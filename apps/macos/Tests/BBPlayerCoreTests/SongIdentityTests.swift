import GRDB
import XCTest
@testable import BBPlayerCore

final class SongIdentityTests: XCTestCase {
    private var root: URL!
    private var url: URL { root.appendingPathComponent("library.sqlite") }
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    /// Construct the exact pre-identity schema, retaining all existing table contents.
    private func makeLegacy(_ database: LibraryDatabase) throws {
        try database.pool.write { db in
            try db.execute(sql: """
                DROP TRIGGER history_capture_source;
                DROP TABLE history_source_snapshot;
                DROP TABLE song_source;
                DROP TABLE library_song;
                DROP TABLE sync_ack;
                DROP TABLE sync_head;
                DROP TABLE sync_operation;
                DROP TABLE sync_revision;
                DROP TABLE sync_like;
                DROP TABLE sync_lyric_choice;
                DELETE FROM grdb_migrations WHERE identifier IN ('native-v2-song-identity','native-v3-sync');
                """)
        }
        try database.pool.close()
    }

    func testLegacyMigrationPreservesDataAndReopenDoesNotBackupAgain() throws {
        let library = try LibraryDatabase(url: url)
        let first = Track(bvid: "first", cid: 1, title: "Same title")
        let second = Track(bvid: "second", cid: 2, title: "Same title")
        let playlist = Playlist(title: "Order")
        try library.savePlaylist(playlist, tracks: [second, first])
        try library.checkpointHistory(id: "old", track: first, started: Date(), listened: 45, completed: true)
        try library.saveResume(trackID: first.id, position: 8, rate: 1.5)
        try library.saveLyrics(LyricsParser.parse("[00:00.00]Preserved"), trackID: first.id)
        try library.saveState("audio-file", key: "download-file:" + first.id)
        try makeLegacy(library)
        let migrated = try LibraryDatabase(url: url)
        let firstID = try XCTUnwrap(migrated.songIdentity(sourceID: first.id))
        XCTAssertNotEqual(firstID.id, try migrated.songIdentity(sourceID: second.id)?.id)
        XCTAssertEqual(try migrated.activeSource(songID: firstID.id), first)
        XCTAssertEqual(try migrated.tracks(playlistID: playlist.id).map(\.id), [second.id, first.id])
        XCTAssertEqual(try migrated.summary().seconds, 45)
        XCTAssertEqual(try migrated.summary().completed, 1)
        XCTAssertEqual(try migrated.historySource(eventID: "old")?.evidence, .observedAtMigration)
        XCTAssertEqual(try migrated.resume(trackID: first.id)?.position, 8)
        XCTAssertEqual(try migrated.lyrics(trackID: first.id)?.lines.first?.text, "Preserved")
        XCTAssertEqual(try migrated.state(String.self, key: "download-file:" + first.id), "audio-file")
        let backupDirectory = root.appendingPathComponent("migration-backups")
        let backups = try FileManager.default.contentsOfDirectory(at: backupDirectory, includingPropertiesForKeys: nil)
        XCTAssertEqual(backups.count, 1)
        let rollback = try DatabaseQueue(path: XCTUnwrap(backups.first).path)
        try rollback.read { db in
            XCTAssertFalse(try db.tableExists("library_song"))
            XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM track"), 2)
            XCTAssertEqual(try Double.fetchOne(db, sql: "SELECT SUM(listened) FROM history"), 45)
        }
        try rollback.close()
        try migrated.pool.close()
        let reopened = try LibraryDatabase(url: url)
        XCTAssertEqual(try reopened.songIdentity(sourceID: first.id), firstID)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: backupDirectory.path).count, 1)
    }

    func testEveryInsertPathAssignsIdentityAndHistoryIsImmutable() throws {
        let library = try LibraryDatabase(url: url)
        let playlist = Playlist(title: "Library")
        let first = Track(bvid: "saved", title: "Original")
        let appended = Track(bvid: "appended", title: "Original")
        let historyOnly = Track(bvid: "history", title: "Original")
        try library.savePlaylist(playlist, tracks: [first])
        try library.append(appended, to: playlist.id)
        let started = Date()
        try library.checkpointHistory(id: "event", track: historyOnly, started: started, listened: 5, completed: false)
        let originalID = try XCTUnwrap(library.songIdentity(sourceID: historyOnly.id))
        var edited = historyOnly; edited.title = "Later metadata"
        try library.checkpointHistory(id: "event", track: edited, started: started, listened: 20, completed: true)
        XCTAssertEqual(try library.songIdentity(sourceID: edited.id), originalID)
        XCTAssertEqual(try library.historySource(eventID: "event")?.track, historyOnly)
        XCTAssertEqual(try library.historySource(eventID: "event")?.evidence, .recordedAtPlayback)
        XCTAssertEqual(try library.listeningEvents(on: started).first?.track, historyOnly)
        XCTAssertEqual(try library.summary().seconds, 20)
        XCTAssertNotNil(try library.songIdentity(sourceID: first.id))
        XCTAssertNotNil(try library.songIdentity(sourceID: appended.id))
        XCTAssertNotEqual(try library.songIdentity(sourceID: first.id)?.id, try library.songIdentity(sourceID: appended.id)?.id)
        // Restore's INSERT OR IGNORE pathway must also assign a new source identity.
        try library.deletePlaylist(playlist.id)
        try library.pool.write { db in
            try db.execute(sql: "DELETE FROM song_source WHERE source_id=?", arguments: [appended.id])
            try db.execute(sql: "DELETE FROM library_song WHERE active_source_id=?", arguments: [appended.id])
            try db.execute(sql: "DELETE FROM track WHERE id=?", arguments: [appended.id])
        }
        _ = try library.restoreDeletedPlaylist()
        XCTAssertNotNil(try library.songIdentity(sourceID: appended.id))
        XCTAssertEqual(try library.tracks(playlistID: playlist.id).map(\.id), [first.id, appended.id])
    }

    func testSnapshotFailurePreventsMigration() throws {
        let library = try LibraryDatabase(url: url)
        try makeLegacy(library)
        let blocker = root.appendingPathComponent("migration-backups")
        try Data("existing file".utf8).write(to: blocker)
        XCTAssertThrowsError(try LibraryDatabase(url: url))
        let database = try DatabaseQueue(path: url.path)
        try database.read { db in
            XCTAssertFalse(try db.tableExists("library_song"))
            XCTAssertEqual(try String.fetchAll(db, sql: "SELECT identifier FROM grdb_migrations"), ["native-v1"])
        }
        XCTAssertEqual(try Data(contentsOf: blocker), Data("existing file".utf8))
    }

    func testInvalidPayloadRollsBackMigrationAndKeepsSnapshot() throws {
        let library = try LibraryDatabase(url: url)
        try library.pool.write { db in
            try db.execute(sql: "INSERT INTO track VALUES('invalid','Title','Artist',?)", arguments: [Data("invalid JSON".utf8)])
        }
        try makeLegacy(library)
        XCTAssertThrowsError(try LibraryDatabase(url: url))
        let database = try DatabaseQueue(path: url.path)
        try database.read { db in
            XCTAssertFalse(try db.tableExists("library_song"))
            XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM track"), 1)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("migration-backups").path).count, 1)
    }

    func testReplacementPreservesSongOrderHistoryAndSourceSpecificState() throws {
        let library = try LibraryDatabase(url: url)
        let old = Track(bvid: "old", cid: 1, title: "Old source")
        let new = Track(bvid: "new", cid: 2, title: "New source")
        let other = Track(bvid: "other", title: "Other")
        let first = Playlist(title: "First"), second = Playlist(title: "Second")
        try library.savePlaylist(first, tracks: [other, old])
        try library.savePlaylist(second, tracks: [old, other])
        let deleted = Playlist(title: "Deleted before replacement")
        try library.savePlaylist(deleted, tracks: [old, other])
        try library.deletePlaylist(deleted.id)
        let song = try XCTUnwrap(library.songIdentity(sourceID: old.id))
        let started = Date()
        try library.checkpointHistory(id: "old-play", track: old, started: started, listened: 30, completed: true)
        try library.saveResume(trackID: old.id, position: 12, rate: 1.25)
        try library.saveLyrics(LyricsParser.parse("[00:00.00]Old lyrics"), trackID: old.id)
        try library.saveState("old-audio", key: "download-file:" + old.id)
        try library.saveState([old], key: "queue-fixture")
        try library.replaceSource(songID: song.id, with: new)
        XCTAssertEqual(try library.songIdentity(sourceID: new.id)?.id, song.id)
        XCTAssertEqual(try library.songIdentity(sourceID: old.id)?.id, song.id)
        XCTAssertEqual(try library.activeSource(songID: song.id), new)
        XCTAssertEqual(try library.tracks(playlistID: first.id).map(\.id), [other.id, new.id])
        XCTAssertEqual(try library.tracks(playlistID: second.id).map(\.id), [new.id, other.id])
        XCTAssertEqual(try library.historySource(eventID: "old-play")?.track, old)
        XCTAssertEqual(try library.resume(trackID: old.id)?.position, 12)
        XCTAssertNil(try library.resume(trackID: new.id))
        XCTAssertEqual(try library.lyrics(trackID: old.id)?.lines.first?.text, "Old lyrics")
        XCTAssertNil(try library.lyrics(trackID: new.id))
        XCTAssertEqual(try library.state(String.self, key: "download-file:" + old.id), "old-audio")
        XCTAssertNil(try library.state(String.self, key: "download-file:" + new.id))
        XCTAssertEqual(try library.state([Track].self, key: "queue-fixture"), [old])
        _ = try library.restoreDeletedPlaylist()
        XCTAssertEqual(try library.tracks(playlistID: deleted.id).map(\.id), [new.id, other.id])
        // Stale callers retain the active source and deduplicate by the stable song.
        try library.append(old, to: first.id)
        XCTAssertEqual(try library.tracks(playlistID: first.id).map(\.id), [other.id, new.id])
        let imported = Playlist(title: "Stale saved playlist")
        try library.savePlaylist(imported, tracks: [old, new])
        XCTAssertEqual(try library.tracks(playlistID: imported.id), [new])
        try library.checkpointHistory(id: "new-play", track: new, started: started, listened: 20, completed: false)
        XCTAssertEqual(try library.summary().ranking.count, 1)
        XCTAssertEqual(try library.summary().ranking.first?.seconds, 50)
        XCTAssertEqual(try library.summary().ranking.first?.track, new)
        XCTAssertEqual(try library.recentTracks(), [new])
        XCTAssertEqual(try library.listeningEvents(on: started).map(\.track.id).sorted(), [old.id, new.id].sorted())
        try library.replaceSource(songID: song.id, with: old)
        XCTAssertEqual(try library.activeSource(songID: song.id), old)
        XCTAssertEqual(try library.tracks(playlistID: first.id).map(\.id), [other.id, old.id])
        XCTAssertEqual(try library.summary().seconds, 50)
    }

    func testReplacementRejectsReferencedCandidateAndReassignsUnusedDefaultIdentity() throws {
        let library = try LibraryDatabase(url: url)
        let old = Track(bvid: "old", title: "Old"), candidate = Track(bvid: "candidate", title: "Candidate")
        let playlist = Playlist(title: "Playlist")
        try library.savePlaylist(playlist, tracks: [old, candidate])
        let song = try XCTUnwrap(library.songIdentity(sourceID: old.id))
        XCTAssertThrowsError(try library.replaceSource(songID: song.id, with: candidate))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("migration-backups").path))
        try library.removeTrack(candidate.id, from: playlist.id)
        let unusedID = try XCTUnwrap(library.songIdentity(sourceID: candidate.id)?.id)
        try library.replaceSource(songID: song.id, with: candidate)
        XCTAssertNil(try library.activeSource(songID: unusedID))
        XCTAssertEqual(try library.songIdentity(sourceID: candidate.id)?.id, song.id)
        let historyCandidate = Track(bvid: "history-candidate", title: "History")
        try library.checkpointHistory(id: "event", track: historyCandidate, started: Date(), listened: 1, completed: false)
        XCTAssertThrowsError(try library.replaceSource(songID: song.id, with: historyCandidate))
        XCTAssertEqual(try library.activeSource(songID: song.id), candidate)
    }

    func testReplacementSaveFailureRollsBackAndSnapshotFailurePreventsWrite() throws {
        let library = try LibraryDatabase(url: url)
        let old = Track(bvid: "old", title: "Old"), candidate = Track(bvid: "candidate", title: "Candidate")
        let playlist = Playlist(title: "Playlist")
        try library.savePlaylist(playlist, tracks: [old])
        let song = try XCTUnwrap(library.songIdentity(sourceID: old.id))
        let blocker = root.appendingPathComponent("migration-backups")
        try Data("block".utf8).write(to: blocker)
        XCTAssertThrowsError(try library.replaceSource(songID: song.id, with: candidate))
        XCTAssertNil(try library.songIdentity(sourceID: candidate.id))
        XCTAssertEqual(try library.tracks(playlistID: playlist.id), [old])
        try FileManager.default.removeItem(at: blocker)
        try library.pool.write { db in
            try db.execute(sql: "CREATE TRIGGER fail_replacement BEFORE INSERT ON playlist_track BEGIN SELECT RAISE(ABORT,'test failure'); END")
        }
        XCTAssertThrowsError(try library.replaceSource(songID: song.id, with: candidate))
        XCTAssertEqual(try library.activeSource(songID: song.id), old)
        XCTAssertNil(try library.songIdentity(sourceID: candidate.id))
        XCTAssertEqual(try library.tracks(playlistID: playlist.id), [old])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: blocker.path).count, 1)
        try library.pool.write { try $0.execute(sql: "DROP TRIGGER fail_replacement") }
        try library.replaceSource(songID: song.id, with: candidate)
        XCTAssertEqual(try library.tracks(playlistID: playlist.id), [candidate])
    }
}
