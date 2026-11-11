import XCTest
@testable import BBPlayerCore

final class LANPairingTests: XCTestCase {
    func testInvitationIsExpiringOneUseAndRevocationPersistsWithoutPlaintextToken() throws {
        var stored: [LANPeer] = []
        let store = try LANPairingStore(load: { [] }, save: { stored = $0 })
        let now = Date(), secret = try store.begin(now: now)
        let request = LANPairRequest(version: 1, deviceID: UUID().uuidString, actor: UUID().uuidString, secret: secret)
        let token = try store.accept(request, now: now)
        XCTAssertEqual(try store.authorize(token: token).id, request.deviceID)
        XCTAssertThrowsError(try store.accept(request, now: now))
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(stored), as: UTF8.self).contains(token))
        let reopened = try LANPairingStore(load: { stored }, save: { stored = $0 })
        XCTAssertEqual(try reopened.authorize(token: token).actor, request.actor)
        try reopened.revoke(request.deviceID)
        XCTAssertThrowsError(try reopened.authorize(token: token))
        let expired = try store.begin(now: now)
        XCTAssertThrowsError(try store.accept(LANPairRequest(version: 1, deviceID: request.deviceID, actor: request.actor, secret: expired), now: now.addingTimeInterval(301)))
    }
    func testWrongInvitationsAreBoundedAndPersistenceFailureDoesNotAcceptPeer() throws {
        let store = try LANPairingStore(load: { [] }, save: { _ in throw LANError.unavailable })
        let now = Date(), secret = try store.begin(now: now), id = UUID().uuidString
        for _ in 0..<6 { XCTAssertThrowsError(try store.accept(LANPairRequest(version: 1, deviceID: id, actor: id, secret: "wrong"), now: now)) }
        XCTAssertThrowsError(try store.accept(LANPairRequest(version: 1, deviceID: id, actor: id, secret: secret), now: now))
        let fresh = try store.begin(now: now)
        XCTAssertThrowsError(try store.accept(LANPairRequest(version: 1, deviceID: id, actor: id, secret: fresh), now: now))
        XCTAssertTrue(store.list().isEmpty)
    }
    func testBoundedHTTPRejectsAmbiguousOrUnapprovedRequestsAndHandlesSplitBody() throws {
        var parser = LANHTTPParser()
        XCTAssertNil(try parser.append(Data("POST /v1/sync HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{".utf8)))
        XCTAssertEqual(try parser.append(Data("}".utf8))?.body, Data("{}".utf8))
        for extra in ["Content-Length: 2\r\nContent-Length: 2", "Content-Length: 999999999", "Content-Length: 2\r\nTransfer-Encoding: chunked"] {
            var invalid = LANHTTPParser()
            XCTAssertThrowsError(try invalid.append(Data("POST /v1/sync HTTP/1.1\r\nContent-Type: application/json\r\n\(extra)\r\n\r\n{}".utf8)))
        }
        var oversized = LANHTTPParser()
        XCTAssertThrowsError(try oversized.append(Data(repeating: 65, count: 8192)))
    }
}
