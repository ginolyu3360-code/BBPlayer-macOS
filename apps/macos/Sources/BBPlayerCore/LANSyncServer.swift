import Foundation
import GRDB
import Network
import Security

public struct LANSyncExchange: Codable, Sendable {
    public var version: Int
    public var deviceID: String
    public var operations: [SyncOperation]
    public var acknowledged: [String]
}
public struct LANSyncResponse: Codable, Sendable {
    public var version = 1
    public var deviceID: String
    public var actor: String
    public var operations: [SyncOperation]
    public var acknowledged: [String]
    public var remaining: Bool
}
public final class LANSyncServer: @unchecked Sendable {
    public let identity: LANIdentity
    public let pairing: LANPairingStore
    private let library: LibraryDatabase
    private let engine: SyncEngine
    private let onChange: @Sendable () -> Void
    private let queue = DispatchQueue(label: "com.bbplayer.lan-sync")
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    public init(identity: LANIdentity, pairing: LANPairingStore, library: LibraryDatabase, engine: SyncEngine, onChange: @escaping @Sendable () -> Void = {}) {
        self.identity = identity; self.pairing = pairing; self.library = library; self.engine = engine; self.onChange = onChange
    }
    /// Network access starts only after the synchronization switch is enabled.
    public func start(port: UInt16 = 0, loopbackOnly: Bool = false, state: @escaping @Sendable (UInt16?, String?) -> Void) throws {
        let tls = NWProtocolTLS.Options()
        guard let secured = sec_identity_create(identity.identity) else { throw LANError.identity }
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, secured)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        parameters.includePeerToPeer = false
        if loopbackOnly { parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any) }
        let next = try NWListener(using: parameters, on: port == 0 ? .any : NWEndpoint.Port(rawValue: port)!)
        if !loopbackOnly { next.service = NWListener.Service(name: "BBPlayer-" + String(identity.deviceID.prefix(8)), type: "_bbplayer-sync._tcp") }
        next.stateUpdateHandler = { [weak next] status in
            switch status {
            case .ready: state(next?.port?.rawValue, nil)
            case .failed: state(nil, LANError.unavailable.localizedDescription)
            case .waiting: state(nil, "等待局域网权限或网络连接")
            default: break
            }
        }
        next.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        queue.sync { listener?.cancel(); listener = next }
        next.start(queue: queue)
    }
    public func stop() {
        queue.sync { listener?.cancel(); listener = nil; for connection in connections.values { connection.cancel() }; connections.removeAll(); pairing.cancelInvitation() }
    }
    private func accept(_ connection: NWConnection) {
        guard connections.count < 8, LANNetwork.isLocal(connection.endpoint) else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state { case .cancelled, .failed: self?.connections.removeValue(forKey: id); default: break }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 20) { [weak connection] in connection?.cancel() }
        receive(connection, parser: LANHTTPParser())
    }
    private func receive(_ connection: NWConnection, parser: LANHTTPParser) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak connection] data, _, complete, error in
            guard let self, let connection else { return }
            guard error == nil, let data, !data.isEmpty else { connection.cancel(); return }
            var parser = parser
            do {
                if let request = try parser.append(data) {
                    let result = try self.route(request)
                    connection.send(content: LANHTTPParser.response(result), completion: .contentProcessed { _ in connection.cancel() })
                } else if !complete { self.receive(connection, parser: parser) }
                else { connection.cancel() }
            } catch {
                let code = error as? LANError == .unauthorized ? 401 : 400
                connection.send(content: LANHTTPParser.response(Data("{\"error\":\"request_rejected\"}".utf8), status: code), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }
    func route(_ request: LANHTTPRequest) throws -> Data {
        let decoder = JSONDecoder(), encoder = JSONEncoder()
        if request.path == "/v1/pair" {
            let pair = try decoder.decode(LANPairRequest.self, from: request.body)
            let token = try pairing.accept(pair)
            // Re-pairing a restored/reinstalled client must replay the current causal log.
            try library.pool.write { db in try db.execute(sql: "DELETE FROM sync_ack WHERE peer=?", arguments: [pair.deviceID]) }
            onChange()
            return try encoder.encode(LANPairResponse(deviceID: identity.deviceID, actor: engine.actor, token: token))
        }
        guard let token = request.bearer else { throw LANError.unauthorized }
        let peer = try pairing.authorize(token: token)
        if request.path == "/v1/revoke" { try pairing.revoke(peer.id); return Data("{}".utf8) }
        if request.path == "/v1/status" {
            return try encoder.encode(LANSyncResponse(deviceID: identity.deviceID, actor: engine.actor, operations: [], acknowledged: [], remaining: false))
        }
        guard request.path == "/v1/sync" else { throw LANError.invalidRequest }
        let input = try decoder.decode(LANSyncExchange.self, from: request.body)
        guard input.version == 1, input.deviceID == peer.id, input.operations.count <= 1000, input.acknowledged.count <= 1000 else { throw LANError.invalidRequest }
        // A peer may relay exact known operations, but cannot mint another actor's new events.
        try library.pool.read { db in
            for op in input.operations where op.actor != peer.actor {
                guard try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM sync_operation WHERE id=?)", arguments: [op.id]) == true else { throw LANError.unauthorized }
            }
        }
        let acknowledged = try engine.receive(input.operations)
        try engine.acknowledge(peer: peer.id, operationIDs: input.acknowledged)
        if !input.operations.isEmpty { onChange() }
        let candidates = try engine.outbox(peer: peer.id, limit: 201)
        var outgoing: [SyncOperation] = [], bytes = 0
        for operation in candidates.prefix(200) {
            let size = try encoder.encode(operation).count
            if bytes + size > 12 * 1024 * 1024 { break }
            outgoing.append(operation); bytes += size
        }
        return try encoder.encode(LANSyncResponse(deviceID: identity.deviceID, actor: engine.actor, operations: outgoing, acknowledged: acknowledged, remaining: candidates.count > outgoing.count))
    }
}
public enum LANNetwork {
    static func isLocal(_ endpoint: NWEndpoint) -> Bool {
        guard case .hostPort(let host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address): return localV4(Array(address.rawValue))
        case .ipv6(let address):
            let bytes = Array(address.rawValue)
            if bytes.prefix(12) == Array(repeating: UInt8(0), count: 10) + [255,255] { return localV4(Array(bytes.suffix(4))) }
            return bytes == Array(repeating: UInt8(0), count: 15) + [1] || (bytes[0] & 0xfe) == 0xfc || (bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80)
        default: return false
        }
    }
    private static func localV4(_ bytes: [UInt8]) -> Bool {
        bytes.count == 4 && (bytes[0] == 10 || bytes[0] == 127 || (bytes[0] == 172 && (16...31).contains(bytes[1])) || (bytes[0] == 192 && bytes[1] == 168) || (bytes[0] == 169 && bytes[1] == 254))
    }
    public static func endpoints(port: UInt16) -> [String] {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return [] }
        defer { freeifaddrs(first) }
        var result: [String] = [], cursor = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            guard let address = current.pointee.ifa_addr, Int32(address.pointee.sa_family) == AF_INET,
                  current.pointee.ifa_flags & UInt32(IFF_UP) != 0, current.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) == 0 {
                let host = String(cString: name)
                if isLocal(.hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!)) { result.append("https://\(host):\(port)") }
            }
        }
        return Array(Set(result)).sorted()
    }
}
