import GRDB
import XCTest
@testable import BBPlayerCore

final class SyncEngineTests: XCTestCase {
    private var root: URL!
    private let actorA = "00000000-0000-0000-0000-000000000001"
    private let actorB = "00000000-0000-0000-0000-000000000002"
    private let playlistID = "00000000-0000-0000-0000-000000000021"
    override func setUpWithError() throws { root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func database(_ name: String) throws -> LibraryDatabase { try LibraryDatabase(url: root.appendingPathComponent(name).appendingPathComponent("library.sqlite")) }
    private func fixture() throws -> SyncSeed {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/sync-v1.json")
        return try JSONDecoder().decode(SyncSeed.self, from: Data(contentsOf: file))
    }
    func testLimitedOutboxSendsPredecessorBeforeLexicallyEarlierActor() throws {
        let library = try database("paged"), sync = try SyncEngine(library: library, actor: actorA)
        let prerequisite = SyncOperation(actor: actorB, sequence: 1, context: [:], entity: "playlist:" + playlistID, field: "title", value: SyncValue(text: "Original"))
        _ = try sync.receive([prerequisite])
        _ = try sync.record(entity: prerequisite.entity, field: "title", value: SyncValue(text: "Dependent edit"))
        XCTAssertEqual(try sync.outbox(peer: "new-peer", limit: 1).first?.id, prerequisite.id)
    }
    func testFixtureOutOfOrderDurabilityIdempotenceAndTransactionalAcknowledgment() throws {
        let initial = try database("receiver")
        let receiver = try SyncEngine(library: initial, actor: actorB), seed = try fixture()
        XCTAssertEqual(try receiver.receive([seed.operations[3]]), [])
        XCTAssertTrue(try initial.playlists().isEmpty)
        try initial.pool.close()
        let database = try self.database("receiver")
        let reopened = try SyncEngine(library: database, actor: actorB)
        _ = try reopened.receive(Array(seed.operations.prefix(3).reversed()))
        XCTAssertEqual(try database.tracks(playlistID: playlistID).first?.cid, 77)
        XCTAssertEqual(try database.tracks(playlistID: playlistID).first?.id, "bilibili:fixture:video")
        XCTAssertEqual(try reopened.receive(seed.operations).count, 4)
        XCTAssertEqual(try reopened.outbox(peer: actorA).count, 4)
        XCTAssertThrowsError(try reopened.acknowledge(peer: actorA, operationIDs: [seed.operations[0].id, "missing"]))
        XCTAssertEqual(try reopened.outbox(peer: actorA).count, 4)
        try reopened.acknowledge(peer: actorA, operationIDs: seed.operations.map(\.id))
        XCTAssertTrue(try reopened.outbox(peer: actorA).isEmpty)
        var collision = seed.operations[0]; collision.value.source?.track.title = "Changed payload"
        XCTAssertThrowsError(try reopened.receive([collision]))
        XCTAssertEqual(try database.tracks(playlistID: playlistID).first?.title, "Fixture song")
    }
    func testConcurrentFieldsConflictResolutionDeleteEditAndTombstoneConverge() throws {
        let a = try database("a"), b = try database("b")
        let left = try SyncEngine(library: a, actor: actorA), right = try SyncEngine(library: b, actor: actorB)
        try left.applySeed(fixture()); try right.applySeed(fixture())
        let entity = "playlist:" + playlistID
        let first = try left.record(entity: entity, field: "title", value: SyncValue(text: "Left"))
        let second = try right.record(entity: entity, field: "title", value: SyncValue(text: "Right"))
        _ = try left.receive([second]); _ = try right.receive([first])
        XCTAssertEqual(try a.playlists().first?.title, try b.playlists().first?.title)
        XCTAssertEqual(try left.conflicts().first?.variants.count, 2)
        let resolved = try left.resolve(entity: entity, field: "title", value: SyncValue(text: "Resolved"))
        _ = try right.receive([resolved]); XCTAssertTrue(try right.conflicts().isEmpty)
        let deletion = try left.record(entity: entity, field: "deleted", value: SyncValue(flag: true))
        let edit = try right.record(entity: entity, field: "title", value: SyncValue(text: "Concurrent edit"))
        _ = try left.receive([edit]); _ = try right.receive([deletion])
        XCTAssertEqual(try a.playlists().count, 1); XCTAssertEqual(try b.playlists().count, 1)
        XCTAssertTrue(try left.conflicts().contains { $0.field == "delete/edit" })
        let finalDelete = try left.resolve(entity: entity, field: "deleted", value: SyncValue(flag: true))
        _ = try right.receive([finalDelete])
        XCTAssertTrue(try a.playlists().isEmpty); XCTAssertTrue(try b.playlists().isEmpty)
        _ = try right.receive([first, second, edit])
        XCTAssertTrue(try b.playlists().isEmpty)
    }
    func testMixedPlaylistReordersNetworkSlotsAndAppendsNewNetworkEntries() throws {
        let library = try database("mixed"), sync = try SyncEngine(library: library, actor: actorA)
        let first = Track(bvid: "first", title: "First"), second = Track(bvid: "second", title: "Second")
        var local = Track(bvid: "private-local", title: "Private local", source: "local")
        local.localFileURL = URL(fileURLWithPath: "/private/media/fixture.wav")
        try library.savePlaylist(Playlist(id: playlistID, title: "Mixed"), tracks: [first, local, second])
        try library.saveState("secret-marker", key: "credentials")
        try library.checkpointHistory(id: "local-history", track: local, started: Date(), listened: 10, completed: false)
        try sync.seedLocalLibrary()
        let localSong = try XCTUnwrap(library.songIdentity(sourceID: local.id)?.id.uuidString)
        XCTAssertThrowsError(try sync.record(entity: "song:" + localSong, field: "liked", value: SyncValue(flag: true)))
        let exported = try JSONEncoder().encode(sync.exportSeed())
        XCTAssertFalse(String(decoding: exported, as: UTF8.self).contains("private-local"))
        XCTAssertFalse(String(decoding: exported, as: UTF8.self).contains("secret-marker"))
        let one = try XCTUnwrap(library.songIdentity(sourceID: first.id)?.id.uuidString)
        let two = try XCTUnwrap(library.songIdentity(sourceID: second.id)?.id.uuidString)
        _ = try sync.record(entity: "playlist:" + playlistID, field: "order", value: SyncValue(order: [two, one]))
        XCTAssertEqual(try library.tracks(playlistID: playlistID).map(\.id), [second.id, local.id, first.id])
        let third = Track(bvid: "third", title: "Third"), three = UUID().uuidString
        _ = try sync.record(entity: "song:" + three, field: "source", value: SyncValue(source: SyncSource(songID: three, track: third)))
        _ = try sync.record(entity: "playlist:" + playlistID, field: "entry:" + three, value: SyncValue(flag: true))
        XCTAssertEqual(try library.tracks(playlistID: playlistID).map(\.id), [second.id, local.id, first.id, third.id])
        _ = try sync.record(entity: "playlist:" + playlistID, field: "order", value: SyncValue(order: [three, one, two]))
        // Once newly inserted it occupies an actual network slot on subsequent edits.
        XCTAssertEqual(try library.tracks(playlistID: playlistID).filter { $0.source == "local" }.map(\.id), [local.id])
        XCTAssertEqual(try library.summary().seconds, 10)
        let stranger = try SyncEngine(library: library, actor: actorB)
        let unsafe = SyncOperation(actor: actorB, sequence: 1, context: [:], entity: "song:" + UUID().uuidString, field: "source", value: SyncValue(source: SyncSource(songID: UUID().uuidString, track: local)))
        XCTAssertThrowsError(try stranger.receive([unsafe]))
    }
    func testSourceOwnershipAndRestorePauseFailClosed() throws {
        let library = try database("ownership")
        let track = Track(bvid: "fixture", title: "Independent existing song")
        try library.savePlaylist(Playlist(title: "Existing"), tracks: [track])
        let sync = try SyncEngine(library: library, actor: actorB)
        XCTAssertThrowsError(try sync.applySeed(fixture()))
        XCTAssertTrue(try sync.exportSeed().operations.isEmpty)
        try library.saveState(true, key: "sync-paused-after-restore")
        XCTAssertThrowsError(try sync.exportSeed())
        XCTAssertThrowsError(try sync.record(entity: "playlist:" + playlistID, field: "title", value: SyncValue(text: "Blocked")))
    }
    func testEntryDeleteConcurrentReorderRetainsItemUntilResolutionAndLikesLyricsStayScoped() throws {
        let a = try database("entry-a"), b = try database("entry-b")
        let left = try SyncEngine(library: a, actor: actorA), right = try SyncEngine(library: b, actor: actorB)
        let seed = try fixture(); try left.applySeed(seed); try right.applySeed(seed)
        let song = "00000000-0000-0000-0000-000000000011", entity = "playlist:" + playlistID
        let deletion = try left.record(entity: entity, field: "entry:" + song, value: SyncValue(flag: false))
        let reorder = try right.record(entity: entity, field: "order", value: SyncValue(order: [song]))
        _ = try left.receive([reorder]); _ = try right.receive([deletion])
        XCTAssertEqual(try a.tracks(playlistID: playlistID).count, 1)
        XCTAssertEqual(try b.tracks(playlistID: playlistID).count, 1)
        XCTAssertTrue(try left.conflicts().contains { $0.field.hasPrefix("entry-delete/edit:") })
        let resolution = try left.resolve(entity: entity, field: "entry:" + song, value: SyncValue(flag: false))
        _ = try right.receive([resolution]); XCTAssertTrue(try b.tracks(playlistID: playlistID).isEmpty)
        let like = try left.record(entity: "song:" + song, field: "liked", value: SyncValue(flag: true))
        let lyric = try right.record(entity: "source:bilibili:fixture:video", field: "lyrics", value: SyncValue(lyrics: LyricsParser.parse("[00:01.00]Correction")))
        _ = try left.receive([lyric]); _ = try right.receive([like])
        XCTAssertEqual(try a.lyrics(trackID: "bilibili:fixture:video")?.lines.first?.text, "Correction")
        XCTAssertEqual(try b.pool.read { try Int.fetchOne($0, sql: "SELECT liked FROM sync_like WHERE song_id=?", arguments: [song]) }, 1)
        XCTAssertTrue(try left.conflicts().isEmpty)
    }
}
