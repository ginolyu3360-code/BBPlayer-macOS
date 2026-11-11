import AVFoundation
import XCTest
@testable import BBPlayerCore

final class LocalMusicTests: XCTestCase {
    func testOriginalReferenceRelinkAndBackupKeepIdentityAndHistory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("original.wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
        buffer.frameLength = 4800
        do { let file = try AVAudioFile(forWriting: url, settings: format.settings); try file.write(from: buffer) }
        let bytes = try Data(contentsOf: url)
        let track = try await LocalMusic.read(url)
        XCTAssertEqual(track.source, "local")
        XCTAssertGreaterThan(track.duration, 0)
        let db = try LibraryDatabase(url: root.appendingPathComponent("db"))
        try db.saveLocalTrack(track)
        let identity = try XCTUnwrap(db.songIdentity(sourceID: track.id))
        let playlist = Playlist(title: "Local")
        try db.savePlaylist(playlist, tracks: [track])
        try db.checkpointHistory(id: "event", track: track, started: Date(), listened: 0.05, completed: false)
        let moved = root.appendingPathComponent("moved.wav")
        try FileManager.default.copyItem(at: url, to: moved)
        let relinked = try await LocalMusic.read(moved, replacing: track)
        try db.saveLocalTrack(relinked, protectingExisting: true)
        XCTAssertEqual(try db.songIdentity(sourceID: track.id)?.id, identity.id)
        XCTAssertEqual(try db.historySource(eventID: "event")?.track.localFileURL, url)
        XCTAssertEqual(try db.tracks(playlistID: playlist.id).first?.localFileURL, moved)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        let backup = LibraryBackup(library: db)
        let archive = root.appendingPathComponent("local.bbbackup")
        try backup.export(to: archive)
        try backup.restore(backup.prepareRestore(from: archive))
        XCTAssertEqual(try db.localTracks().first?.id, track.id)
        try FileManager.default.removeItem(at: moved)
        XCTAssertEqual(try db.localTracks().count, 1, "Missing files must not remove metadata")
    }
}
