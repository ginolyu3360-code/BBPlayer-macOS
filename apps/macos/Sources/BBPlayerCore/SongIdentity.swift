import Foundation
import GRDB

/// Track.id remains the source/cache key; this UUID identifies the library song.
public struct SongIdentity: Equatable, Sendable {
    public var id: UUID
    public var activeSourceID: String
}

public enum HistorySourceEvidence: String, Codable, Sendable {
    case recordedAtPlayback
    /// Legacy events cannot establish what metadata existed at playback time.
    case observedAtMigration
}

public struct HistorySourceSnapshot: Sendable {
    public var songID: UUID
    public var track: Track
    public var evidence: HistorySourceEvidence
}

public enum SongSourceReplacementError: Error, Equatable {
    case unknownSong
    case candidateAlreadyInLibrary
}

extension LibraryDatabase {
    /// Changes future library selections only. Playback queue and source-specific
    /// downloads, lyrics, resume and immutable history are deliberately untouched.
    public func replaceSource(songID: UUID, with candidate: Track) throws {
        try pool.read { try SongIdentitySchema.validateReplacement(songID: songID, candidate: candidate, in: $0) }
        let directory = databaseURL.deletingLastPathComponent().appendingPathComponent("migration-backups", isDirectory: true)
        let destination = directory.appendingPathComponent("pre-source-replacement-\(UUID().uuidString).sqlite")
        try DatabaseSnapshot.create(from: pool, at: destination)
        try pool.write { db in
            // Re-check after snapshot creation: another writer may have used the candidate.
            try SongIdentitySchema.validateReplacement(songID: songID, candidate: candidate, in: db)
            let candidateSong = try String.fetchOne(db, sql: "SELECT song_id FROM song_source WHERE source_id=?", arguments: [candidate.id])
            if let candidateSong, candidateSong != songID.uuidString {
                try db.execute(sql: "DELETE FROM song_source WHERE source_id=?", arguments: [candidate.id])
                try db.execute(sql: "DELETE FROM library_song WHERE id=?", arguments: [candidateSong])
            }
            let payload = try JSONEncoder().encode(candidate)
            try db.execute(sql: "INSERT INTO track VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,payload=excluded.payload", arguments: [candidate.id, candidate.title, candidate.artist, payload])
            try db.execute(sql: "INSERT OR IGNORE INTO song_source(source_id,song_id,initial_payload) VALUES(?,?,?)", arguments: [candidate.id, songID.uuidString, payload])
            let memberships = try Row.fetchAll(db, sql: "SELECT pt.playlist_id,MIN(pt.sort_order) AS sort_order FROM playlist_track pt JOIN song_source m ON m.source_id=pt.track_id WHERE m.song_id=? GROUP BY pt.playlist_id", arguments: [songID.uuidString])
            try db.execute(sql: "DELETE FROM playlist_track WHERE track_id IN (SELECT source_id FROM song_source WHERE song_id=?)", arguments: [songID.uuidString])
            for membership in memberships {
                let playlistID: String = membership["playlist_id"], order: Int = membership["sort_order"]
                try db.execute(sql: "INSERT INTO playlist_track VALUES(?,?,?)", arguments: [playlistID, candidate.id, order])
            }
            try db.execute(sql: "UPDATE library_song SET active_source_id=? WHERE id=?", arguments: [candidate.id, songID.uuidString])
            try SyncEngine.captureSource(songID.uuidString, library: self, db: db)
        }
    }

    public func songIdentity(sourceID: String) throws -> SongIdentity? {
        try pool.read { db in
            guard let row = try Row.fetchOne(db, sql: "SELECT s.id,s.active_source_id FROM library_song s JOIN song_source m ON m.song_id=s.id WHERE m.source_id=?", arguments: [sourceID]) else { return nil }
            return SongIdentity(id: try SongIdentitySchema.uuid(row["id"]), activeSourceID: row["active_source_id"])
        }
    }

    public func activeSource(songID: UUID) throws -> Track? {
        try pool.read { db in
            guard let payload = try Data.fetchOne(db, sql: "SELECT t.payload FROM track t JOIN library_song s ON s.active_source_id=t.id WHERE s.id=?", arguments: [songID.uuidString]) else { return nil }
            return try JSONDecoder().decode(Track.self, from: payload)
        }
    }

    public func historySource(eventID: String) throws -> HistorySourceSnapshot? {
        try pool.read { db in
            guard let row = try Row.fetchOne(db, sql: "SELECT song_id,payload,evidence FROM history_source_snapshot WHERE history_id=?", arguments: [eventID]) else { return nil }
            let raw: String = row["evidence"]
            guard let evidence = HistorySourceEvidence(rawValue: raw) else { throw SongIdentitySchema.InvalidIdentity() }
            return HistorySourceSnapshot(songID: try SongIdentitySchema.uuid(row["song_id"]), track: try JSONDecoder().decode(Track.self, from: row["payload"]), evidence: evidence)
        }
    }
}

enum SongIdentitySchema {
    struct InvalidIdentity: Error {}

    /// Stale imports and undo records must not silently reactivate an archived source.
    static func librarySourceID(trackID: String, in db: Database) throws -> String {
        guard let source = try String.fetchOne(db, sql: "SELECT s.active_source_id FROM library_song s JOIN song_source m ON m.song_id=s.id WHERE m.source_id=?", arguments: [trackID]) else { throw InvalidIdentity() }
        return source
    }

    static func uuid(_ value: String) throws -> UUID {
        guard let uuid = UUID(uuidString: value) else { throw InvalidIdentity() }
        return uuid
    }

    static func validateReplacement(songID: UUID, candidate: Track, in db: Database) throws {
        guard try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM library_song WHERE id=?)", arguments: [songID.uuidString])! else { throw SongSourceReplacementError.unknownSong }
        guard let owner = try String.fetchOne(db, sql: "SELECT song_id FROM song_source WHERE source_id=?", arguments: [candidate.id]), owner != songID.uuidString else { return }
        let inUse = try Bool.fetchOne(db, sql: """
            SELECT EXISTS(SELECT 1 FROM playlist_track pt JOIN song_source m ON m.source_id=pt.track_id WHERE m.song_id=?)
                OR EXISTS(SELECT 1 FROM history_source_snapshot WHERE song_id=?)
                OR EXISTS(SELECT 1 FROM history h JOIN song_source m ON m.source_id=h.track_id WHERE m.song_id=?)
                OR (SELECT COUNT(*) FROM song_source WHERE song_id=?) > 1
            """, arguments: [owner, owner, owner, owner])!
        guard !inUse else { throw SongSourceReplacementError.candidateAlreadyInLibrary }
    }

    static func migrate(_ db: Database) throws {
        try db.execute(sql: """
            CREATE TABLE library_song (
                id TEXT PRIMARY KEY NOT NULL,
                active_source_id TEXT NOT NULL UNIQUE REFERENCES track(id));
            CREATE TABLE song_source (
                source_id TEXT PRIMARY KEY NOT NULL REFERENCES track(id),
                song_id TEXT NOT NULL REFERENCES library_song(id),
                initial_payload BLOB NOT NULL);
            CREATE INDEX song_source_song ON song_source(song_id);
            CREATE TABLE history_source_snapshot (
                history_id TEXT PRIMARY KEY NOT NULL REFERENCES history(id) ON DELETE CASCADE,
                song_id TEXT NOT NULL REFERENCES library_song(id),
                source_id TEXT NOT NULL REFERENCES track(id),
                payload BLOB NOT NULL,
                evidence TEXT NOT NULL CHECK(evidence IN ('recordedAtPlayback','observedAtMigration')));
            CREATE INDEX history_source_song ON history_source_snapshot(song_id);
            """)
        for id in try String.fetchAll(db, sql: "SELECT id FROM track ORDER BY id") {
            try ensureSource(trackID: id, in: db)
        }
        for id in try String.fetchAll(db, sql: "SELECT id FROM history ORDER BY id") {
            try snapshotHistory(id: id, evidence: .observedAtMigration, in: db)
        }
        // Bulk writers also insert directly through the public GRDB pool.
        // Capture their event payload at insertion, rather than projecting mutable metadata later.
        try db.execute(sql: """
            CREATE TRIGGER history_capture_source AFTER INSERT ON history BEGIN
                INSERT INTO history_source_snapshot(history_id,song_id,source_id,payload,evidence)
                SELECT NEW.id,m.song_id,NEW.track_id,t.payload,'recordedAtPlayback'
                FROM track t JOIN song_source m ON m.source_id=t.id WHERE t.id=NEW.track_id;
            END;
            """)
    }

    static func ensureSource(trackID: String, in db: Database) throws {
        guard try !Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM song_source WHERE source_id=?)", arguments: [trackID])! else { return }
        guard let payload = try Data.fetchOne(db, sql: "SELECT payload FROM track WHERE id=?", arguments: [trackID]) else { throw InvalidIdentity() }
        // Validate old payloads before committing a migration. No title/artist matching.
        _ = try JSONDecoder().decode(Track.self, from: payload)
        let songID = UUID().uuidString
        try db.execute(sql: "INSERT INTO library_song(id,active_source_id) VALUES(?,?)", arguments: [songID, trackID])
        try db.execute(sql: "INSERT INTO song_source(source_id,song_id,initial_payload) VALUES(?,?,?)", arguments: [trackID, songID, payload])
    }

    static func snapshotHistory(id: String, evidence: HistorySourceEvidence, in db: Database) throws {
        try db.execute(sql: """
            INSERT OR IGNORE INTO history_source_snapshot(history_id,song_id,source_id,payload,evidence)
            SELECT h.id,m.song_id,h.track_id,t.payload,? FROM history h
            JOIN track t ON t.id=h.track_id JOIN song_source m ON m.source_id=h.track_id WHERE h.id=?
            """, arguments: [evidence.rawValue, id])
    }
}
