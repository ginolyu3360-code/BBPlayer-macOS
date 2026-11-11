import CryptoKit
import Foundation
import GRDB

public enum LibraryBackupError: Error, LocalizedError {
    case invalidArchive, unsupportedVersion, tooLarge, destinationExists
    public var errorDescription: String? {
        switch self {
        case .invalidArchive: "备份内容不完整、校验失败或引用关系无效，未修改资料库。"
        case .unsupportedVersion: "该备份来自不支持的格式版本。"
        case .tooLarge: "备份超过本机支持的 128 MiB 上限。"
        case .destinationExists: "目标文件已存在，请选择新的文件名。"
        }
    }
}

public struct PreparedLibraryRestore: Sendable {
    public let playlistCount: Int
    public let songCount: Int
    public let historyCount: Int
    public let createdAt: Date
    fileprivate let content: BackupContent
}

/// Portable, typed, content-checked backups. Runtime state is never serialized.
public final class LibraryBackup: @unchecked Sendable {
    private let library: LibraryDatabase
    public let directory: URL
    private let lock = NSLock()
    private static let maximumSize = 128 * 1024 * 1024
    public init(library: LibraryDatabase, directory: URL? = nil) {
        self.library = library
        self.directory = directory ?? library.databaseURL.deletingLastPathComponent().appendingPathComponent("backups", isDirectory: true)
    }

    public func export(to destination: URL, now: Date = Date()) throws {
        lock.lock(); defer { lock.unlock() }
        try write(content: capture(), kind: .manual, to: destination, now: now)
    }

    /// Decode and prove relational validity in an isolated database before confirmation.
    public func prepareRestore(from file: URL) throws -> PreparedLibraryRestore {
        let archive = try read(file)
        let content = try Self.decoder().decode(BackupContent.self, from: archive.content)
        try content.validate()
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent("library-restore-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: staging) }
        let staged = try LibraryDatabase(url: staging.appendingPathComponent("staged.sqlite"))
        try staged.pool.write { db in
            try content.apply(to: db)
            guard try Row.fetchAll(db, sql: "PRAGMA foreign_key_check").isEmpty else { throw LibraryBackupError.invalidArchive }
        }
        try staged.pool.close()
        return PreparedLibraryRestore(playlistCount: content.playlists.count, songCount: content.songs.count, historyCount: content.history.count, createdAt: archive.createdAt, content: content)
    }

    /// Caller must quiesce playback/import writers first. This never swaps an open
    /// SQLite file; all library changes commit together on the existing writer.
    public func restore(_ prepared: PreparedLibraryRestore, now: Date = Date()) throws {
        lock.lock(); defer { lock.unlock() }
        try prepared.content.validate()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let rollback = directory.appendingPathComponent("pre-restore-\(UUID().uuidString).bbbackup")
        try write(content: capture(), kind: .preRestore, to: rollback, now: now)
        // Keep the latest verified pre-restore protection, including after a failed restore.
        try prune(kind: .preRestore, keeping: 1, preserving: rollback)
        try library.pool.write { db in
            try prepared.content.apply(to: db)
            for key in ["playback", "import-job", "deleted-playlist", "multipart"] {
                try db.execute(sql: "DELETE FROM state WHERE key=?", arguments: [key])
            }
            try db.execute(sql: "DELETE FROM resume")
            try db.execute(sql: "INSERT INTO state(key,value) VALUES('sync-paused-after-restore',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arguments: [try Self.encoder().encode(true)])
            guard try Row.fetchAll(db, sql: "PRAGMA foreign_key_check").isEmpty else { throw LibraryBackupError.invalidArchive }
        }
    }

    /// Caller quiesces writers exactly as for full restore. Recompute against the latest library at commit time.
    public func merge(_ prepared: PreparedLibraryRestore, preferImportedMetadata: Bool = false, now: Date = Date()) throws {
        let content = try mergedContent(prepared.content, preferImported: preferImportedMetadata).content
        try restore(PreparedLibraryRestore(playlistCount: content.playlists.count, songCount: content.songs.count, historyCount: content.history.count, createdAt: prepared.createdAt, content: content), now: now)
    }

    public func mergeConflictCount(_ prepared: PreparedLibraryRestore) throws -> Int {
        try mergedContent(prepared.content, preferImported: false).conflicts
    }

    private func mergedContent(_ incoming: BackupContent, preferImported: Bool) throws -> (content: BackupContent, conflicts: Int) {
        let current = try capture()
        var conflicts = 0
        let owners = Dictionary(uniqueKeysWithValues: current.sources.map { ($0.sourceID, $0.songID) })
        for source in incoming.sources {
            if let owner = owners[source.sourceID], owner != source.songID {
                throw APIError.unavailable("同一来源属于不同的歌曲身份，未自动合并。请保留两个备份，或选择完整恢复。")
            }
        }
        func combine<T: Encodable>(_ existing: [T], _ imported: [T], key: (T) -> String) throws -> [T] {
            var result = existing
            var positions = Dictionary(uniqueKeysWithValues: existing.enumerated().map { (key($0.element), $0.offset) })
            for item in imported {
                if let index = positions[key(item)] {
                    if try Self.encoder().encode(result[index]) != Self.encoder().encode(item) {
                        conflicts += 1
                        if preferImported { result[index] = item }
                    }
                } else { positions[key(item)] = result.count; result.append(item) }
            }
            return result
        }
        var merged = current
        merged.tracks = try combine(current.tracks, incoming.tracks, key: { $0.id })
        merged.songs = try combine(current.songs, incoming.songs, key: { $0.id.uuidString })
        merged.sources = try combine(current.sources, incoming.sources, key: { $0.sourceID })
        merged.playlists = try combine(current.playlists, incoming.playlists, key: { $0.id })
        merged.lyrics = try combine(current.lyrics, incoming.lyrics, key: { $0.sourceID })
        let currentLyrics = Set(current.lyrics.map(\.sourceID))
        merged.lyricChoices = merged.lyrics.filter { lyric in
            let useIncoming = preferImported || !currentLyrics.contains(lyric.sourceID)
            return (useIncoming ? incoming.lyricChoices : current.lyricChoices)?.contains(lyric.sourceID) == true
        }.map(\.sourceID).sorted()
        merged.likes = try combine(current.likes ?? [], incoming.likes ?? [], key: { $0.songID.uuidString })
        merged.history = try combine(current.history, incoming.history, key: { $0.id })
        let currentEvents = Dictionary(uniqueKeysWithValues: current.history.map { ($0.id, $0) })
        let importedEvents = Dictionary(uniqueKeysWithValues: incoming.history.map { ($0.id, $0) })
        for index in merged.history.indices {
            let event = merged.history[index]
            if let a = currentEvents[event.id], let b = importedEvents[event.id], a.songID == b.songID, a.sourceID == b.sourceID, a.started == b.started {
                merged.history[index].listened = max(a.listened, b.listened)
                merged.history[index].completed = a.completed || b.completed
            }
        }
        let active = Dictionary(uniqueKeysWithValues: merged.songs.map { ($0.id, $0.activeSourceID) })
        let sourceOwners = Dictionary(uniqueKeysWithValues: merged.sources.map { ($0.sourceID, $0.songID) })
        merged.entries = []
        for playlist in merged.playlists {
            var seen = Set<String>()
            let old = current.entries.filter { $0.playlistID == playlist.id }.sorted { $0.order < $1.order }
            let added = incoming.entries.filter { $0.playlistID == playlist.id }.sorted { $0.order < $1.order }
            for entry in old + added {
                guard let owner = sourceOwners[entry.sourceID], let selected = active[owner], seen.insert(selected).inserted else { continue }
                merged.entries.append(BackupEntry(playlistID: playlist.id, sourceID: selected, order: seen.count - 1))
            }
        }
        if try Self.encoder().encode(current.preferences) != Self.encoder().encode(incoming.preferences) { conflicts += 1 }
        merged.preferences = preferImported ? incoming.preferences : current.preferences
        try merged.validate()
        return (merged, conflicts)
    }

    /// First launch of each local day, only if portable content changed.
    @discardableResult public func automaticIfNeeded(now: Date = Date(), calendar: Calendar = .current) throws -> URL? {
        lock.lock(); defer { lock.unlock() }
        let day = calendar.startOfDay(for: now).timeIntervalSince1970
        let indexURL = directory.appendingPathComponent("automatic-index.json")
        let previous = FileManager.default.fileExists(atPath: indexURL.path) ? try Self.decoder().decode(AutomaticIndex.self, from: Data(contentsOf: indexURL)) : nil
        guard previous?.day != day else { return nil }
        let content = try capture(), digest = try Self.digest(Self.encoder().encode(content))
        var destination: URL?
        let newestPublished = try managedBackups().compactMap { file -> Archive? in
            guard file.lastPathComponent.hasPrefix("automatic-"), let archive = try? read(file), archive.kind == .automatic else { return nil }
            return archive
        }.max { $0.createdAt < $1.createdAt }
        let alreadyPublished = newestPublished?.checksum == digest
        if previous?.digest != digest && !alreadyPublished {
            let file = directory.appendingPathComponent("automatic-\(UUID().uuidString).bbbackup")
            try write(content: content, kind: .automatic, to: file, now: now)
            destination = file
            try prune(kind: .automatic, keeping: 10)
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try Self.encoder().encode(AutomaticIndex(day: day, digest: digest)).write(to: indexURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: indexURL.path)
        return destination
    }

    public func managedBackups() throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "bbbackup" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private struct AutomaticIndex: Codable { var day: Double; var digest: String }
    private enum Kind: String, Codable { case manual, automatic, preRestore }
    private struct Archive: Codable {
        var format = "BBPlayerLibrary"
        var version = 1
        var createdAt: Date
        var kind: Kind
        var checksum: String
        var content: Data
    }
    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .secondsSince1970; return encoder
    }
    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .secondsSince1970; return decoder
    }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func read(_ url: URL) throws -> Archive {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= Self.maximumSize else { throw LibraryBackupError.tooLarge }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maximumSize else { throw LibraryBackupError.tooLarge }
        let archive = try Self.decoder().decode(Archive.self, from: data)
        guard archive.format == "BBPlayerLibrary", archive.version == 1 else { throw LibraryBackupError.unsupportedVersion }
        guard archive.createdAt.timeIntervalSince1970.isFinite, archive.checksum == Self.digest(archive.content) else { throw LibraryBackupError.invalidArchive }
        return archive
    }
    private func write(content: BackupContent, kind: Kind, to destination: URL, now: Date) throws {
        try content.validate()
        let payload = try Self.encoder().encode(content)
        let data = try Self.encoder().encode(Archive(createdAt: now, kind: kind, checksum: Self.digest(payload), content: payload))
        guard data.count <= Self.maximumSize else { throw LibraryBackupError.tooLarge }
        let manager = FileManager.default
        guard !manager.fileExists(atPath: destination.path) else { throw LibraryBackupError.destinationExists }
        let parent = destination.deletingLastPathComponent()
        try manager.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = parent.appendingPathComponent(".backup-\(UUID().uuidString)")
        defer { try? manager.removeItem(at: temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        try manager.moveItem(at: temporary, to: destination)
        _ = try read(destination)
    }
    private func prune(kind: Kind, keeping count: Int, preserving protected: URL? = nil) throws {
        let prefix = kind == .automatic ? "automatic-" : "pre-restore-"
        let recognized = try managedBackups().compactMap { file -> (URL, Date)? in
            let name = file.deletingPathExtension().lastPathComponent
            guard name.hasPrefix(prefix), UUID(uuidString: String(name.dropFirst(prefix.count))) != nil,
                  let archive = try? read(file), archive.kind == kind else { return nil }
            return (file, archive.createdAt)
        }.sorted {
            if $0.0 == protected { return true }
            if $1.0 == protected { return false }
            return $0.1 == $1.1 ? $0.0.lastPathComponent > $1.0.lastPathComponent : $0.1 > $1.1
        }
        for file in recognized.dropFirst(count) { try FileManager.default.removeItem(at: file.0) }
    }

    private func capture() throws -> BackupContent {
        try library.pool.read { db in
            let decoder = Self.decoder()
            func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T { try decoder.decode(type, from: data) }
            let tracks = try Data.fetchAll(db, sql: "SELECT payload FROM track ORDER BY id").map { try decode(Track.self, $0).portable() }
            let songs = try Row.fetchAll(db, sql: "SELECT id,active_source_id FROM library_song ORDER BY id").map { row in
                BackupSong(id: try SongIdentitySchema.uuid(row["id"]), activeSourceID: row["active_source_id"])
            }
            let sources = try Row.fetchAll(db, sql: "SELECT source_id,song_id,initial_payload FROM song_source ORDER BY source_id").map { row in
                BackupSource(sourceID: row["source_id"], songID: try SongIdentitySchema.uuid(row["song_id"]), initial: try decode(Track.self, row["initial_payload"]).portable())
            }
            let playlists = try Data.fetchAll(db, sql: "SELECT payload FROM playlist ORDER BY id").map { try decode(Playlist.self, $0).portable() }
            let entries = try Row.fetchAll(db, sql: "SELECT playlist_id,track_id,sort_order FROM playlist_track ORDER BY playlist_id,sort_order,track_id").map { row in
                BackupEntry(playlistID: row["playlist_id"], sourceID: row["track_id"], order: row["sort_order"])
            }
            let events = try Row.fetchAll(db, sql: "SELECT h.id,h.track_id,h.started,h.listened,h.completed,s.song_id,s.payload,s.evidence FROM history h JOIN history_source_snapshot s ON s.history_id=h.id ORDER BY h.id").map { row -> BackupHistory in
                let raw: String = row["evidence"]
                guard let evidence = HistorySourceEvidence(rawValue: raw) else { throw LibraryBackupError.invalidArchive }
                return BackupHistory(id: row["id"], sourceID: row["track_id"], started: row["started"], listened: row["listened"], completed: row["completed"], songID: try SongIdentitySchema.uuid(row["song_id"]), snapshot: try decode(Track.self, row["payload"]).portable(), evidence: evidence)
            }
            guard events.count == (try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM history")) else { throw LibraryBackupError.invalidArchive }
            let lyrics = try Row.fetchAll(db, sql: "SELECT track_id,payload FROM lyric ORDER BY track_id").map { row in
                BackupLyric(sourceID: row["track_id"], document: try decode(LyricDocument.self, row["payload"]))
            }
            let preferences = try Data.fetchOne(db, sql: "SELECT value FROM state WHERE key='preferences'").map { try decode(PlayerPreferences.self, $0) } ?? PlayerPreferences()
            let likes = try Row.fetchAll(db, sql: "SELECT song_id,liked FROM sync_like ORDER BY song_id").map { row in
                BackupLike(songID: try SongIdentitySchema.uuid(row["song_id"]), liked: row["liked"])
            }
            let choices = try String.fetchAll(db, sql: "SELECT source_id FROM sync_lyric_choice ORDER BY source_id")
            return BackupContent(lyricChoices: choices, likes: likes, tracks: tracks, songs: songs, sources: sources, playlists: playlists, entries: entries, history: events, lyrics: lyrics, preferences: preferences)
        }
    }
}

private struct BackupSong: Codable, Sendable { var id: UUID; var activeSourceID: String }
private struct BackupSource: Codable, Sendable { var sourceID: String; var songID: UUID; var initial: Track }
private struct BackupEntry: Codable, Sendable { var playlistID: String; var sourceID: String; var order: Int }
private struct BackupHistory: Codable, Sendable {
    var id: String; var sourceID: String; var started: Double; var listened: Double; var completed: Bool
    var songID: UUID; var snapshot: Track; var evidence: HistorySourceEvidence
}
private struct BackupLyric: Codable, Sendable { var sourceID: String; var document: LyricDocument }
private struct BackupLike: Codable, Sendable { var songID: UUID; var liked: Bool }
fileprivate struct BackupContent: Codable, Sendable {
    var lyricChoices: [String]?
    var likes: [BackupLike]?
    var tracks: [Track]; var songs: [BackupSong]; var sources: [BackupSource]
    var playlists: [Playlist]; var entries: [BackupEntry]; var history: [BackupHistory]; var lyrics: [BackupLyric]
    var preferences: PlayerPreferences

    func validate() throws {
        func unique(_ ids: [String]) throws -> Set<String> {
            let set = Set(ids); guard set.count == ids.count, !set.contains("") else { throw LibraryBackupError.invalidArchive }; return set
        }
        let trackIDs = try unique(tracks.map(\.id)), songIDs = try unique(songs.map { $0.id.uuidString })
        let playlistIDs = try unique(playlists.map(\.id)), sourceIDs = try unique(sources.map(\.sourceID))
        _ = try unique(history.map(\.id)); _ = try unique(lyrics.map(\.sourceID))
        _ = try unique((likes ?? []).map { $0.songID.uuidString })
        guard (likes ?? []).allSatisfy({ songIDs.contains($0.songID.uuidString) }) else { throw LibraryBackupError.invalidArchive }
        _ = try unique(lyricChoices ?? [])
        guard Set(lyricChoices ?? []).isSubset(of: Set(lyrics.map(\.sourceID))) else { throw LibraryBackupError.invalidArchive }
        guard sourceIDs == trackIDs else { throw LibraryBackupError.invalidArchive }
        let mapping = Dictionary(uniqueKeysWithValues: sources.map { ($0.sourceID, $0.songID) })
        for song in songs { guard mapping[song.activeSourceID] == song.id else { throw LibraryBackupError.invalidArchive } }
        for source in sources {
            guard songIDs.contains(source.songID.uuidString), source.initial.id == source.sourceID else { throw LibraryBackupError.invalidArchive }
        }
        _ = try unique(entries.map { "\($0.playlistID.utf8.count):\($0.playlistID)\($0.sourceID)" })
        for entry in entries { guard playlistIDs.contains(entry.playlistID), trackIDs.contains(entry.sourceID), entry.order >= 0 else { throw LibraryBackupError.invalidArchive } }
        for event in history {
            guard mapping[event.sourceID] == event.songID, event.snapshot.id == event.sourceID,
                  event.started.isFinite, event.listened.isFinite, event.listened >= 0 else { throw LibraryBackupError.invalidArchive }
        }
        guard preferences.volume.isFinite, (0...1).contains(preferences.volume), preferences.lyricOffset.isFinite,
              preferences.cacheLimit >= 0 else { throw LibraryBackupError.invalidArchive }
        if let presentation = preferences.lyricPresentation, presentation != presentation.normalized { throw LibraryBackupError.invalidArchive }
        if let equalizer = preferences.equalizer, equalizer.gains != equalizer.normalizedGains { throw LibraryBackupError.invalidArchive }
        for track in tracks + sources.map(\.initial) + history.map(\.snapshot) {
            guard track.duration.isFinite, track.duration >= 0, track.coverURL == track.coverURL?.portableCover else { throw LibraryBackupError.invalidArchive }
        }
        for playlist in playlists { guard playlist.coverURL == playlist.coverURL?.portableCover else { throw LibraryBackupError.invalidArchive } }
        for lyric in lyrics {
            guard lyric.document.offset.isFinite else { throw LibraryBackupError.invalidArchive }
            for line in lyric.document.lines {
                guard line.start.isFinite, line.end.isFinite, line.words.allSatisfy({ $0.start.isFinite && $0.end.isFinite }) else { throw LibraryBackupError.invalidArchive }
            }
        }
    }

    func apply(to db: Database) throws {
        let encoder = JSONEncoder()
        try db.execute(sql: "DELETE FROM sync_ack; DELETE FROM sync_head; DELETE FROM sync_operation; DELETE FROM sync_revision; DELETE FROM sync_like; DELETE FROM sync_lyric_choice; DELETE FROM history; DELETE FROM history_source_snapshot; DELETE FROM playlist_track; DELETE FROM playlist; DELETE FROM song_source; DELETE FROM library_song; DELETE FROM track; DELETE FROM lyric")
        for track in tracks { try db.execute(sql: "INSERT INTO track VALUES(?,?,?,?)", arguments: [track.id, track.title, track.artist, try encoder.encode(track)]) }
        for song in songs { try db.execute(sql: "INSERT INTO library_song VALUES(?,?)", arguments: [song.id.uuidString, song.activeSourceID]) }
        for source in sources { try db.execute(sql: "INSERT INTO song_source VALUES(?,?,?)", arguments: [source.sourceID, source.songID.uuidString, try encoder.encode(source.initial)]) }
        for playlist in playlists { try db.execute(sql: "INSERT INTO playlist VALUES(?,?,?)", arguments: [playlist.id, playlist.title, try encoder.encode(playlist)]) }
        for entry in entries { try db.execute(sql: "INSERT INTO playlist_track VALUES(?,?,?)", arguments: [entry.playlistID, entry.sourceID, entry.order]) }
        for event in history {
            try db.execute(sql: "INSERT INTO history VALUES(?,?,?,?,?)", arguments: [event.id, event.sourceID, event.started, event.listened, event.completed])
            try db.execute(sql: "UPDATE history_source_snapshot SET song_id=?,source_id=?,payload=?,evidence=? WHERE history_id=?", arguments: [event.songID.uuidString, event.sourceID, try encoder.encode(event.snapshot), event.evidence.rawValue, event.id])
        }
        for source in lyricChoices ?? [] { try db.execute(sql: "INSERT INTO sync_lyric_choice VALUES(?)", arguments: [source]) }
        for like in likes ?? [] { try db.execute(sql: "INSERT INTO sync_like VALUES(?,?)", arguments: [like.songID.uuidString, like.liked]) }
        for lyric in lyrics { try db.execute(sql: "INSERT INTO lyric VALUES(?,?)", arguments: [lyric.sourceID, try encoder.encode(lyric.document)]) }
        try db.execute(sql: "INSERT INTO state(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arguments: [try encoder.encode(preferences)])
    }
}

private extension URL {
    var portableCover: URL? {
        guard ["http", "https"].contains(scheme?.lowercased() ?? ""), host != nil, user == nil, password == nil, query == nil, fragment == nil else { return nil }
        return self
    }
}
private extension Track {
    func portable() -> Track { var value = self; value.coverURL = coverURL?.portableCover; return value }
}
private extension Playlist {
    func portable() -> Playlist { var value = self; value.coverURL = coverURL?.portableCover; return value }
}
