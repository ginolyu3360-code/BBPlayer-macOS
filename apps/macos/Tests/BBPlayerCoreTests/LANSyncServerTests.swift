import Foundation
import Network
import XCTest
@testable import BBPlayerCore

final class LANSyncServerTests: XCTestCase {
    func testRouterPairsAuthenticatesRetriesAndRevokesWithoutTransportSideEffects() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try LibraryDatabase(url: root.appendingPathComponent("library.sqlite"))
        let track = Track(bvid: "fixture", cid: 77, title: "A song"), playlist = Playlist(title: "A playlist")
        try database.savePlaylist(playlist, tracks: [track])
        let engine = try XCTUnwrap(SyncEngine.activate(library: database)), identity = try LANIdentity.ephemeral()
        let pairing = try LANPairingStore(load: { [] }, save: { _ in })
        let server = LANSyncServer(identity: identity, pairing: pairing, library: database, engine: engine)
        let id = UUID().uuidString, actor = UUID().uuidString, secret = try pairing.begin()
        let encoder = JSONEncoder(), decoder = JSONDecoder()
        let pair = LANPairRequest(version: 1, deviceID: id, actor: actor, secret: secret)
        let response = try decoder.decode(LANPairResponse.self, from: server.route(LANHTTPRequest(path: "/v1/pair", body: encoder.encode(pair))))
        XCTAssertEqual(response.deviceID, identity.deviceID)
        let first = LANSyncExchange(version: 1, deviceID: id, operations: [], acknowledged: [])
        let initial = try decoder.decode(LANSyncResponse.self, from: server.route(LANHTTPRequest(path: "/v1/sync", bearer: response.token, body: encoder.encode(first))))
        XCTAssertFalse(initial.operations.isEmpty)
        XCTAssertThrowsError(try server.route(LANHTTPRequest(path: "/v1/sync", body: encoder.encode(first))))
        let context = try engine.revision()
        let edit = SyncOperation(actor: actor, sequence: 1, context: context, entity: "playlist:" + playlist.id, field: "title", value: SyncValue(text: "From phone"))
        let exchange = LANSyncExchange(version: 1, deviceID: id, operations: [edit], acknowledged: initial.operations.map(\.id))
        for _ in 0..<2 {
            let synced = try decoder.decode(LANSyncResponse.self, from: server.route(LANHTTPRequest(path: "/v1/sync", bearer: response.token, body: encoder.encode(exchange))))
            XCTAssertEqual(synced.acknowledged, [edit.id])
        }
        XCTAssertEqual(try database.playlists().first?.title, "From phone")
        let forged = SyncOperation(actor: UUID().uuidString, sequence: 1, context: [:], entity: "playlist:" + playlist.id, field: "title", value: SyncValue(text: "Forged"))
        let invalid = LANSyncExchange(version: 1, deviceID: id, operations: [forged], acknowledged: [])
        XCTAssertThrowsError(try server.route(LANHTTPRequest(path: "/v1/sync", bearer: response.token, body: encoder.encode(invalid))))
        _ = try server.route(LANHTTPRequest(path: "/v1/revoke", bearer: response.token, body: Data("{}".utf8)))
        XCTAssertThrowsError(try server.route(LANHTTPRequest(path: "/v1/status", bearer: response.token, body: Data("{}".utf8))))
    }
    func testRemoteEndpointsAreRestrictedToLocalAddresses() {
        for address in ["192.168.1.1", "10.0.0.1", "172.16.0.1", "127.0.0.1", "::1", "fc00::1", "fe80::1"] {
            XCTAssertTrue(LANNetwork.isLocal(.hostPort(host: NWEndpoint.Host(address), port: 443)))
        }
        for address in ["8.8.8.8", "172.32.0.1", "2001:4860:4860::8888", "example.com", "ff02::1"] {
            XCTAssertFalse(LANNetwork.isLocal(.hostPort(host: NWEndpoint.Host(address), port: 443)))
        }
    }
}
