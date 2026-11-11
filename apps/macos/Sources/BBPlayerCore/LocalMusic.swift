import AVFoundation
import Foundation
import GRDB

final class LocalAudioAccess {
    let url: URL
    private let scoped: Bool
    init(_ url: URL) { self.url = url; scoped = url.startAccessingSecurityScopedResource() }
    deinit { if scoped { url.stopAccessingSecurityScopedResource() } }
}

public enum LocalMusic {
    public static func resolve(_ track: Track) throws -> URL {
        guard track.source == "local" else { throw APIError.unavailable("这不是本地音频。") }
        if let bookmark = track.localFileBookmark {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale) { return url }
        }
        guard let url = track.localFileURL, url.isFileURL else { throw APIError.unavailable("文件引用失效，请重新关联原文件。") }
        return url
    }
    public static func read(_ url: URL, replacing original: Track? = nil) async throws -> Track {
        guard ["mp3", "aac", "m4a", "flac", "wav"].contains(url.pathExtension.lowercased()) else { throw APIError.unavailable("请选择 MP3、AAC/M4A、FLAC 或 WAV。") }
        let access = LocalAudioAccess(url)
        let asset = AVURLAsset(url: url)
        guard try await asset.load(.isPlayable) else { throw APIError.unavailable("本机无法解码该音频，原文件未改动。") }
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration >= 0 else { throw APIError.unavailable("无法读取音频时长。") }
        let metadata = try await asset.load(.commonMetadata)
        let title = try await metadata.first(where: { $0.commonKey == .commonKeyTitle })?.load(.stringValue)
        let artist = try await metadata.first(where: { $0.commonKey == .commonKeyArtist })?.load(.stringValue)
        var track = original ?? Track(bvid: UUID().uuidString, title: title ?? url.deletingPathExtension().lastPathComponent, artist: artist ?? "", source: "local")
        track.localFileURL = url
        track.localFileBookmark = try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
        track.duration = duration
        withExtendedLifetime(access) {}
        return track
    }
}

extension LibraryDatabase {
    public func saveLocalTrack(_ input: Track, protectingExisting: Bool = false) throws {
        var track = input
        if !protectingExisting, let existing = try localTracks().first(where: { $0.localFileURL?.standardizedFileURL == input.localFileURL?.standardizedFileURL }) {
            track.id = existing.id; track.bvid = existing.bvid; track.title = existing.title; track.artist = existing.artist; track.coverURL = existing.coverURL
        }
        guard track.source == "local", track.localFileURL?.isFileURL == true else { throw APIError.unavailable("本地文件引用无效。") }
        if protectingExisting {
            let folder = databaseURL.deletingLastPathComponent().appendingPathComponent("migration-backups")
            try DatabaseSnapshot.create(from: pool, at: folder.appendingPathComponent("pre-relink-\(UUID().uuidString).sqlite"))
        }
        try pool.write { db in
            try db.execute(sql: "INSERT INTO track(id,title,artist,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,payload=excluded.payload", arguments: [track.id, track.title, track.artist, try JSONEncoder().encode(track)])
            try SongIdentitySchema.ensureSource(trackID: track.id, in: db)
        }
    }
    public func localTracks() throws -> [Track] {
        try pool.read { db in try Data.fetchAll(db, sql: "SELECT payload FROM track ORDER BY title").map { try JSONDecoder().decode(Track.self, from: $0) }.filter { $0.source == "local" } }
    }
}
