import CryptoKit
import GRDB
import XCTest
@testable import BBPlayerCore

final class LibraryBackupTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws { root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func library(_ name: String) throws -> LibraryDatabase { try LibraryDatabase(url: root.appendingPathComponent(name).appendingPathComponent("library.sqlite")) }
    private func payload(_ file: URL) throws -> [String: Any] {
        let archive = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let encoded = try XCTUnwrap(archive["content"] as? String)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(Data(base64Encoded: encoded))) as? [String: Any])
    }

    func testPortableRoundTripPreservesIdentityOrderAndActualHistoryWithoutRuntimeState() throws {
        let source = try library("source")
        let old = Track(bvid: "old", cid: 1, title: "Actual old source", coverURL: URL(string: "https://example.com/cover.png?token=credential-marker"))
        let new = Track(bvid: "new", cid: 2, title: "Active source")
        let other = Track(bvid: "other", title: "Other")
        let playlist = Playlist(title: "Original playlist")
        try source.savePlaylist(playlist, tracks: [other, old])
        try source.checkpointHistory(id: "event", track: old, started: Date(), listened: 42, completed: true)
        let song = try XCTUnwrap(source.songIdentity(sourceID: old.id))
        try source.replaceSource(songID: song.id, with: new)
        let sync = try SyncEngine(library: source, actor: UUID().uuidString)
        try sync.record(entity: "song:" + song.id.uuidString, field: "liked", value: SyncValue(flag: true))
        try source.saveLyrics(LyricsParser.parse("[00:00.00]Original lyric"), trackID: old.id)
        var preferences = PlayerPreferences(); preferences.volume = 0.4
        try source.saveState(preferences, key: "preferences")
        for key in ["credentials", "downloads", "download-file:" + old.id, "pairing", "sync-secret", "import-job", "playback"] {
            try source.saveState("credential-marker", key: key)
        }
        try source.saveResume(trackID: old.id, position: 12, rate: 1.5)
        let file = root.appendingPathComponent("portable.bbbackup")
        let backups = LibraryBackup(library: source)
        try backups.export(to: file)
        let portable = try payload(file)
        XCTAssertEqual(Set(portable.keys), ["tracks", "songs", "sources", "playlists", "entries", "history", "lyrics", "preferences", "likes", "lyricChoices"])
        let portableText = String(data: try JSONSerialization.data(withJSONObject: portable), encoding: .utf8)!
        XCTAssertFalse(portableText.contains("credential-marker"))
        XCTAssertFalse(portableText.contains("download-file"))
        let target = try library("target"), targetBackups = LibraryBackup(library: target)
        try target.savePlaylist(Playlist(title: "Replaced target"), tracks: [])
        try target.saveState("target-login", key: "credentials")
        try target.saveState("target-audio", key: "download-file:" + old.id)
        try target.saveState("stale-queue", key: "playback")
        let prepared = try targetBackups.prepareRestore(from: file)
        XCTAssertEqual(prepared.songCount, 2); XCTAssertEqual(prepared.historyCount, 1)
        try targetBackups.restore(prepared)
        XCTAssertEqual(try target.songIdentity(sourceID: old.id)?.id, song.id)
        XCTAssertEqual(try target.activeSource(songID: song.id), new)
        try target.pool.read { db in
            XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT liked FROM sync_like WHERE song_id=?", arguments: [song.id.uuidString]), 1)
            XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM sync_operation"), 0)
        }
        XCTAssertEqual(try target.tracks(playlistID: playlist.id).map(\.id), [other.id, new.id])
        XCTAssertEqual(try target.historySource(eventID: "event")?.track.title, old.title)
        XCTAssertNil(try target.historySource(eventID: "event")?.track.coverURL)
        XCTAssertEqual(try target.historySource(eventID: "event")?.evidence, .recordedAtPlayback)
        XCTAssertEqual(try target.summary().seconds, 42)
        XCTAssertEqual(try target.lyrics(trackID: old.id)?.lines.first?.text, "Original lyric")
        XCTAssertEqual(try target.state(PlayerPreferences.self, key: "preferences")?.volume, 0.4)
        XCTAssertEqual(try target.state(String.self, key: "credentials"), "target-login")
        XCTAssertEqual(try target.state(String.self, key: "download-file:" + old.id), "target-audio")
        XCTAssertNil(try target.state(String.self, key: "playback"))
        XCTAssertEqual(try target.state(Bool.self, key: "sync-paused-after-restore"), true)
        try targetBackups.restore(prepared)
        XCTAssertEqual(try target.summary().seconds, 42)
        XCTAssertEqual(try targetBackups.managedBackups().count, 1)
    }

    func testTamperedAndInvalidReferencesAreRejectedBeforeRestore() throws {
        let source = try library("source")
        let playlist = Playlist(title: "Source")
        try source.savePlaylist(playlist, tracks: [Track(bvid: "one", title: "One")])
        let file = root.appendingPathComponent("archive.bbbackup"), backups = LibraryBackup(library: source)
        try backups.export(to: file)
        var archive = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        archive["checksum"] = "tampered"
        let invalid = root.appendingPathComponent("invalid.bbbackup")
        try JSONSerialization.data(withJSONObject: archive).write(to: invalid)
        XCTAssertThrowsError(try backups.prepareRestore(from: invalid))
        var content = try payload(file)
        content["entries"] = [["playlistID": playlist.id, "sourceID": "missing-source", "order": 0]]
        let data = try JSONSerialization.data(withJSONObject: content, options: [.sortedKeys])
        archive["content"] = data.base64EncodedString()
        archive["checksum"] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        try JSONSerialization.data(withJSONObject: archive).write(to: invalid)
        XCTAssertThrowsError(try backups.prepareRestore(from: invalid))
        XCTAssertEqual(try source.tracks(playlistID: playlist.id).count, 1)
    }

    func testRestoreFailureRollsBackAndProtectionFailurePreventsMutation() throws {
        let source = try library("source"), target = try library("target")
        try source.savePlaylist(Playlist(title: "Imported"), tracks: [])
        let current = Playlist(title: "Keep current")
        try target.savePlaylist(current, tracks: [Track(bvid: "keep", title: "Keep")])
        let file = root.appendingPathComponent("restore.bbbackup")
        try LibraryBackup(library: source).export(to: file)
        let directory = root.appendingPathComponent("protection")
        let backups = LibraryBackup(library: target, directory: directory)
        let prepared = try backups.prepareRestore(from: file)
        try Data("existing file".utf8).write(to: directory)
        XCTAssertThrowsError(try backups.restore(prepared))
        XCTAssertEqual(try target.playlists().map(\.id), [current.id])
        try FileManager.default.removeItem(at: directory)
        try target.pool.write { db in
            try db.execute(sql: "CREATE TRIGGER fail_restore BEFORE INSERT ON playlist BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        }
        XCTAssertThrowsError(try backups.restore(prepared))
        XCTAssertEqual(try target.playlists().map(\.id), [current.id])
        XCTAssertEqual(try target.tracks(playlistID: current.id).count, 1)
        let rollback = try XCTUnwrap(backups.managedBackups().first)
        XCTAssertEqual(try backups.prepareRestore(from: rollback).playlistCount, 1)
    }

    func testAutomaticDailyChangedContentRetentionAndManualPreservation() throws {
        let database = try library("automatic"), backups = LibraryBackup(library: database)
        let playlist = Playlist(title: "Day zero")
        try database.savePlaylist(playlist, tracks: [])
        let day = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try XCTUnwrap(backups.automaticIfNeeded(now: day))
        let manual = backups.directory.appendingPathComponent("automatic-\(UUID().uuidString).bbbackup")
        try backups.export(to: manual, now: day)
        let manualBytes = try Data(contentsOf: manual)
        XCTAssertNil(try backups.automaticIfNeeded(now: day.addingTimeInterval(60)))
        try database.saveState("runtime changed", key: "playback")
        XCTAssertNil(try backups.automaticIfNeeded(now: day.addingTimeInterval(86_400)))
        for index in 2..<14 {
            try database.renamePlaylist(playlist.id, title: "Day \(index)")
            XCTAssertNotNil(try backups.automaticIfNeeded(now: day.addingTimeInterval(Double(index) * 86_400)))
        }
        XCTAssertEqual(try backups.managedBackups().count, 11)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
        XCTAssertEqual(try Data(contentsOf: manual), manualBytes)
        XCTAssertThrowsError(try backups.export(to: manual))
    }
}

extension LibraryBackupTests {
    func testMergePreservesCurrentOrderAndMetadataAndDeduplicatesHistory() throws {
        let db = try library("merge")
        let a = Track(bvid: "a", title: "Backup title"), b = Track(bvid: "b", title: "Current addition"), c = Track(bvid: "c", title: "Backup addition")
        var playlist = Playlist(title: "Backup playlist")
        try db.savePlaylist(playlist, tracks: [a, c])
        let started = Date(timeIntervalSince1970: 1000)
        try db.checkpointHistory(id: "same-event", track: a, started: started, listened: 10, completed: false)
        let backups = LibraryBackup(library: db)
        let file = root.appendingPathComponent("merge.bbbackup")
        try backups.export(to: file)
        let prepared = try backups.prepareRestore(from: file)
        var edited = a; edited.title = "Current title"
        playlist.title = "Current playlist"
        try db.savePlaylist(playlist, tracks: [edited, b])
        try db.checkpointHistory(id: "same-event", track: edited, started: started, listened: 20, completed: true)
        XCTAssertGreaterThan(try backups.mergeConflictCount(prepared), 0)
        try backups.merge(prepared)
        XCTAssertEqual(try db.tracks(playlistID: playlist.id).map(\.id), [a.id, b.id, c.id])
        XCTAssertEqual(try db.tracks(playlistID: playlist.id).first?.title, "Current title")
        XCTAssertEqual(try db.summary().seconds, 20)
        try backups.merge(prepared)
        XCTAssertEqual(try db.summary().ranking.first?.count, 1)
        XCTAssertEqual(try db.tracks(playlistID: playlist.id).count, 3)
        try backups.merge(prepared, preferImportedMetadata: true)
        XCTAssertEqual(try db.tracks(playlistID: playlist.id).first?.title, "Backup title")
        XCTAssertEqual(try db.summary().seconds, 20)
    }
}
