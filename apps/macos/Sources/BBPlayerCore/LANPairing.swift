import CryptoKit
import Foundation
import Security

public struct LANPeer: Codable, Identifiable, Sendable {
    public var id: String
    public var actor: String
    public var pairedAt: Date
    fileprivate var tokenHash: Data
}
public struct LANPairRequest: Codable, Sendable {
    public var version: Int
    public var deviceID: String
    public var actor: String
    public var secret: String
}
public struct LANPairResponse: Codable, Sendable {
    public var version = 1
    public var deviceID: String
    public var actor: String
    public var token: String
}
/// Pairing credentials are kept outside the library and every portable backup.
public final class LANPairingStore: @unchecked Sendable {
    private let lock = NSLock()
    private let save: ([LANPeer]) throws -> Void
    private var peers: [LANPeer]
    private var invitation: (secret: String, expires: Date, attempts: Int)?
    public init(load: () throws -> [LANPeer], save: @escaping ([LANPeer]) throws -> Void) throws {
        self.peers = try load(); self.save = save
    }
    public static func persistent(allowInteraction: Bool = true) throws -> LANPairingStore {
        try LANPairingStore(load: {
            guard let value = try CredentialStore.read("lan-paired-peers-v1", allowInteraction: allowInteraction) else { return [] }
            return try JSONDecoder().decode([LANPeer].self, from: Data(value.utf8))
        }, save: { peers in
            try CredentialStore.withInteractionPolicy(allowInteraction: false) {
                try CredentialStore.write(String(decoding: JSONEncoder().encode(peers), as: UTF8.self), account: "lan-paired-peers-v1")
            }
        })
    }
    public func list() -> [LANPeer] { lock.lock(); defer { lock.unlock() }; return peers }
    /// Show only through the pairing UI/QR. Never publish it in Bonjour or logs.
    public func begin(now: Date = Date()) throws -> String {
        lock.lock(); defer { lock.unlock() }
        let secret = try Self.secret()
        invitation = (secret, now.addingTimeInterval(300), 0)
        return secret
    }
    public func cancelInvitation() { lock.lock(); defer { lock.unlock() }; invitation = nil }
    public func accept(_ request: LANPairRequest, now: Date = Date()) throws -> String {
        lock.lock(); defer { lock.unlock() }
        guard var offer = invitation, now <= offer.expires, offer.attempts < 6 else { throw LANError.unauthorized }
        offer.attempts += 1; invitation = offer
        guard request.version == 1, UUID(uuidString: request.deviceID)?.uuidString == request.deviceID,
              UUID(uuidString: request.actor)?.uuidString == request.actor,
              Self.constantTimeEqual(Data(request.secret.utf8), Data(offer.secret.utf8)) else { throw LANError.unauthorized }
        let token = try Self.secret()
        let peer = LANPeer(id: request.deviceID, actor: request.actor, pairedAt: now, tokenHash: Data(SHA256.hash(data: Data(token.utf8))))
        let next = peers.filter { $0.id != peer.id } + [peer]
        guard next.count <= 16 else { throw LANError.invalidRequest }
        try save(next)
        peers = next; invitation = nil
        return token
    }
    public func authorize(token: String) throws -> LANPeer {
        lock.lock(); defer { lock.unlock() }
        guard token.utf8.count <= 128 else { throw LANError.unauthorized }
        let digest = Data(SHA256.hash(data: Data(token.utf8)))
        guard let peer = peers.first(where: { Self.constantTimeEqual($0.tokenHash, digest) }) else { throw LANError.unauthorized }
        return peer
    }
    public func revoke(_ id: String) throws {
        lock.lock(); defer { lock.unlock() }
        let next = peers.filter { $0.id != id }; try save(next); peers = next
    }
    public func revokeAll() throws {
        lock.lock(); defer { lock.unlock() }
        try save([]); peers = []; invitation = nil
    }
    static func secret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw LANError.identity }
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        return zip(a,b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
