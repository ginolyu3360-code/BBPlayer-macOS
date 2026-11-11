import GRDB
import XCTest
@testable import BBPlayerCore

final class SyncRecordingTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws { root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func library(_ name: String) throws -> LibraryDatabase { try LibraryDatabase(url: root.appendingPathComponent(name).appendingPathComponent("db.sqlite")) }

    func testLibraryMutatorsRecordAtomicallyAndProjectionDoesNotEcho() throws {
        let source = try library("source"), target = try library("target")
        let recorder = try XCTUnwrap(SyncEngine.activate(library: source))
        let receiver = try XCTUnwrap(SyncEngine.activate(library: target))
        let playlist = Playlist(title: "First")
        let first = Track(bvid: "first", title: "First"), second = Track(bvid: "second", title: "Second")
        try source.savePlaylist(playlist, tracks: [first])
        try source.append(second, to: playlist.id)
        try source.moveTrack(second.id, in: playlist.id, forward: false)
        try source.renamePlaylist(playlist.id, title: "Renamed")
        try source.removeTrack(first.id, from: playlist.id)
        try receiver.applySeed(recorder.exportSeed())
        XCTAssertEqual(try target.tracks(playlistID: playlist.id).map(\.id), [second.id])
        XCTAssertEqual(try target.playlists().first?.title, "Renamed")
        XCTAssertFalse(try receiver.exportSeed().operations.contains { $0.actor == receiver.actor })
        try source.deletePlaylist(playlist.id)
        try receiver.applySeed(recorder.exportSeed())
        XCTAssertTrue(try target.playlists().isEmpty)
        _ = try source.restoreDeletedPlaylist()
        try receiver.applySeed(recorder.exportSeed())
        XCTAssertEqual(try target.tracks(playlistID: playlist.id).map(\.id), [second.id])
        let count = try recorder.exportSeed().operations.count
        try source.pool.write { db in
            try db.execute(sql: "CREATE TRIGGER fail_sync_insert BEFORE INSERT ON sync_operation BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        }
        XCTAssertThrowsError(try source.renamePlaylist(playlist.id, title: "Must roll back"))
        XCTAssertEqual(try source.playlists().first?.title, "Renamed")
        XCTAssertEqual(try recorder.exportSeed().operations.count, count)
    }

    func testReplacementLikesAndRetiredLyricsSeedWithoutHistoryOrFiles() throws {
        let source = try library("replacement"), recorder = try XCTUnwrap(SyncEngine.activate(library: source))
        let old = Track(bvid: "old", cid: 77, title: "Old"), replacement = Track(bvid: "new", cid: 88, title: "New")
        let playlist = Playlist(title: "Library")
        try source.savePlaylist(playlist, tracks: [old])
        let song = try XCTUnwrap(source.songIdentity(sourceID: old.id)?.id)
        try source.checkpointHistory(id: "private-history", track: old, started: Date(), listened: 30, completed: false)
        try source.setLiked(true, track: old)
        try source.saveLyrics(LyricsParser.parse("[00:01.00]Manual correction", source: "netease"), trackID: old.id)
        try source.replaceSource(songID: song, with: replacement)
        try source.saveLyrics(LyricsParser.parse("[00:02.00]Retired source correction", source: "qq"), trackID: old.id)
        let seed = try recorder.exportSeed(), target = try library("fresh-peer")
        let receiver = try XCTUnwrap(SyncEngine.activate(library: target))
        try receiver.applySeed(seed)
        XCTAssertEqual(try target.activeSource(songID: song)?.id, replacement.id)
        XCTAssertEqual(try target.tracks(playlistID: playlist.id).map(\.id), [replacement.id])
        XCTAssertTrue(try target.isLiked(trackID: replacement.id))
        XCTAssertEqual(try target.lyrics(trackID: old.id)?.lines.first?.text, "Retired source correction")
        XCTAssertNil(try target.lyrics(trackID: replacement.id))
        XCTAssertEqual(try target.summary().seconds, 0)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(seed), as: UTF8.self).contains("private-history"))
        let before = seed.operations.count
        try source.saveLyrics(LyricsParser.parse("[00:03.00]Automatic", source: "automatic"), trackID: replacement.id, synchronize: false)
        XCTAssertEqual(try recorder.exportSeed().operations.count, before)
        let rebased = try SyncEngine.rebaseline(library: source)
        let fresh = try library("rebased-peer"), freshReceiver = try XCTUnwrap(SyncEngine.activate(library: fresh))
        try freshReceiver.applySeed(rebased.exportSeed())
        XCTAssertEqual(try fresh.lyrics(trackID: old.id)?.source, "qq")
        XCTAssertEqual(try fresh.activeSource(songID: song)?.id, replacement.id)
    }

    func testActorPersistsPauseSuppressesRecordingAndExplicitRebaselineRotatesActor() throws {
        let database = try library("actor"), original = try XCTUnwrap(SyncEngine.activate(library: database))
        try database.savePlaylist(Playlist(title: "Initial"), tracks: [Track(bvid: "one", title: "One")])
        XCTAssertEqual(try SyncEngine.activate(library: database)?.actor, original.actor)
        try database.saveState(true, key: "sync-paused-after-restore")
        XCTAssertNil(try SyncEngine.activate(library: database))
        let playlist = Playlist(title: "Edited while paused")
        try database.savePlaylist(playlist, tracks: [Track(bvid: "two", title: "Two")])
        let replacement = try SyncEngine.rebaseline(library: database)
        XCTAssertNotEqual(replacement.actor, original.actor)
        XCTAssertThrowsError(try original.exportSeed())
        let target = try library("rebaseline-peer"), receiver = try XCTUnwrap(SyncEngine.activate(library: target))
        try receiver.applySeed(replacement.exportSeed())
        XCTAssertEqual(try target.tracks(playlistID: playlist.id).first?.bvid, "two")
        XCTAssertEqual(try replacement.revision().keys.sorted(), [replacement.actor])
    }

    func testLocalFilesAndAutomaticLyricsDoNotCreateOperations() throws {
        let database = try library("scope"), recorder = try XCTUnwrap(SyncEngine.activate(library: database))
        var local = Track(bvid: "private-local", title: "Local", source: "local")
        local.localFileURL = URL(fileURLWithPath: "/private/media/fixture.wav")
        let playlist = Playlist(title: "Mixed")
        try database.savePlaylist(playlist, tracks: [Track(bvid: "network", title: "Network")])
        let before = try recorder.exportSeed().operations.count
        try database.append(local, to: playlist.id)
        XCTAssertEqual(try recorder.exportSeed().operations.count, before)
        try database.saveLyrics(LyricsParser.parse("[00:00.00]Local lyric"), trackID: local.id)
        XCTAssertEqual(try recorder.exportSeed().operations.count, before)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(recorder.exportSeed()), as: UTF8.self).contains("private-local"))
    }
}
