import GRDB
import XCTest
@testable import BBPlayerCore

final class DatabaseSnapshotTests: XCTestCase {
    func testInvalidForeignKeysAreRejectedWithoutPublishing() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var configuration = Configuration(); configuration.foreignKeysEnabled = false
        let source = try DatabaseQueue(configuration: configuration)
        try source.write { db in
            try db.execute(sql: "CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(42)")
        }
        let target = root.appendingPathComponent("rollback.sqlite")
        XCTAssertThrowsError(try DatabaseSnapshot.create(from: source, at: target))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }

    func testSnapshotIncludesCommittedWALAndRemainsIndependent() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let library = try LibraryDatabase(url: root.appendingPathComponent("live.sqlite"))
        let playlist = Playlist(title: "Before migration")
        let track = Track(bvid: "fixture", cid: 1, title: "Original")
        try library.savePlaylist(playlist, tracks: [track])
        try library.checkpointHistory(id: "event", track: track, started: Date(), listened: 42, completed: false)
        let target = root.appendingPathComponent("rollback.sqlite")
        try DatabaseSnapshot.create(from: library.pool, at: target)
        try library.renamePlaylist(playlist.id, title: "Changed after backup")
        var configuration = Configuration(); configuration.readonly = true
        let snapshot = try DatabaseQueue(path: target.path, configuration: configuration)
        try snapshot.read { db in
            XCTAssertEqual(try String.fetchOne(db, sql: "SELECT title FROM playlist"), "Before migration")
            XCTAssertEqual(try Double.fetchOne(db, sql: "SELECT SUM(listened) FROM history"), 42)
            XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM playlist_track"), 1)
        }
        try snapshot.close()
        let original = try Data(contentsOf: target)
        XCTAssertThrowsError(try DatabaseSnapshot.create(from: library.pool, at: target))
        XCTAssertEqual(try Data(contentsOf: target), original)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix(".snapshot-") })
    }
}
