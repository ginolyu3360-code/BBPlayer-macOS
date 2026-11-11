import Foundation
import GRDB

/// Durable causal log and SQLite adapter. Transport/authentication and automatic
/// interception of UI writes are intentionally separate integration layers.
public final class SyncEngine: @unchecked Sendable {
    public let actor: String
    private let library: LibraryDatabase
    public init(library: LibraryDatabase, actor: String) throws {
        guard UUID(uuidString: actor)?.uuidString == actor else { throw SyncEngineError.invalidOperation }
        self.library = library; self.actor = actor
    }
    /// Enables durable local recording, without connecting to any peer.
    public static func activate(library: LibraryDatabase) throws -> SyncEngine? {
        try library.pool.write { db in
            if let value = try Data.fetchOne(db, sql: "SELECT value FROM state WHERE key='sync-paused-after-restore'"), (try? JSONDecoder().decode(Bool.self, from: value)) == true { return nil }
            let actor = try Data.fetchOne(db, sql: "SELECT value FROM state WHERE key='sync-actor'").map { try JSONDecoder().decode(String.self, from: $0) } ?? UUID().uuidString
            let engine = try SyncEngine(library: library, actor: actor)
            try db.execute(sql: "INSERT INTO state VALUES('sync-actor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arguments: [try JSONEncoder().encode(actor)])
            try engine.seedLocalLibrary(in: db)
            return engine
        }
    }
    /// Explicit caller decision: peers must discard the old baseline before reconnecting.
    public static func rebaseline(library: LibraryDatabase) throws -> SyncEngine {
        try library.pool.write { db in
            let engine = try SyncEngine(library: library, actor: UUID().uuidString)
            try db.execute(sql: "DELETE FROM sync_ack; DELETE FROM sync_head; DELETE FROM sync_operation; DELETE FROM sync_revision; DELETE FROM state WHERE key='sync-paused-after-restore'")
            try db.execute(sql: "INSERT INTO state VALUES('sync-actor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arguments: [try JSONEncoder().encode(engine.actor)])
            try engine.seedLocalLibrary(in: db)
            return engine
        }
    }
    struct PlaylistState {
        var title: String?
        var network: [String]
    }
    static func playlistState(_ id: String, in db: Database) throws -> PlaylistState {
        guard let data = try Data.fetchOne(db, sql: "SELECT payload FROM playlist WHERE id=?", arguments: [id]),
              let playlist = try? JSONDecoder().decode(Playlist.self, from: data), playlist.kind == "local" else { return PlaylistState(title: nil, network: []) }
        var network: [String] = []
        for row in try Row.fetchAll(db, sql: "SELECT t.payload,m.song_id FROM playlist_track pt JOIN track t ON t.id=pt.track_id JOIN song_source m ON m.source_id=t.id WHERE pt.playlist_id=? ORDER BY pt.sort_order", arguments: [id]) {
            let track = try JSONDecoder().decode(Track.self, from: row["payload"]), song: String = row["song_id"]
            if track.source == "bilibili", !network.contains(song) { network.append(song) }
        }
        return PlaylistState(title: playlist.title, network: network)
    }
    private static func recorder(library: LibraryDatabase, db: Database) throws -> SyncEngine? {
        if let value = try Data.fetchOne(db, sql: "SELECT value FROM state WHERE key='sync-paused-after-restore'"), (try? JSONDecoder().decode(Bool.self, from: value)) == true { return nil }
        guard let data = try Data.fetchOne(db, sql: "SELECT value FROM state WHERE key='sync-actor'") else { return nil }
        return try SyncEngine(library: library, actor: JSONDecoder().decode(String.self, from: data))
    }
    private func appendLocal(_ entity: String, _ field: String, _ value: SyncValue, db: Database) throws {
        let context = try revisions(db)
        let operation = SyncOperation(actor: actor, sequence: (context[actor] ?? 0) + 1, context: context, entity: entity, field: field, value: value)
        try ingest([operation], in: db, materialize: false)
    }
    private func captureSource(_ song: String, db: Database) throws {
        guard let payload = try Data.fetchOne(db, sql: "SELECT t.payload FROM library_song s JOIN track t ON t.id=s.active_source_id WHERE s.id=?", arguments: [song]) else { return }
        let track = try JSONDecoder().decode(Track.self, from: payload)
        guard track.source == "bilibili" else { return }
        let value = SyncValue(source: SyncSource(songID: song, track: portable(track)))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let winner = try fieldHeads(entity: "song:" + song, field: "source", db: db).max { $0.id < $1.id }
        if let winner, try encoder.encode(winner.value) == encoder.encode(value) { return }
        try appendLocal("song:" + song, "source", value, db: db)
    }
    static func captureSource(_ song: String, library: LibraryDatabase, db: Database) throws {
        try recorder(library: library, db: db)?.captureSource(song, db: db)
    }
    static func capturePlaylist(_ id: String, before: PlaylistState, library: LibraryDatabase, db: Database) throws {
        guard let recorder = try recorder(library: library, db: db) else { return }
        let after = try playlistState(id, in: db), entity = "playlist:" + id
        if before.title == nil, after.title != nil { try recorder.appendLocal(entity, "deleted", SyncValue(flag: false), db: db) }
        if before.title != nil, after.title == nil { try recorder.appendLocal(entity, "deleted", SyncValue(flag: true), db: db); return }
        if let title = after.title, title != before.title { try recorder.appendLocal(entity, "title", SyncValue(text: title), db: db) }
        for song in after.network { try recorder.captureSource(song, db: db) }
        for song in Set(before.network).subtracting(after.network).sorted() { try recorder.appendLocal(entity, "entry:" + song, SyncValue(flag: false), db: db) }
        for song in Set(after.network).subtracting(before.network).sorted() { try recorder.appendLocal(entity, "entry:" + song, SyncValue(flag: true), db: db) }
        if before.network != after.network { try recorder.appendLocal(entity, "order", SyncValue(order: after.network), db: db) }
    }
    static func captureLyrics(_ document: LyricDocument, sourceID: String, library: LibraryDatabase, db: Database) throws {
        try recorder(library: library, db: db)?.captureLyrics(document, sourceID: sourceID, db: db)
    }
    private func captureLyrics(_ document: LyricDocument, sourceID: String, db: Database) throws {
        guard let row = try Row.fetchOne(db, sql: "SELECT m.song_id,t.payload FROM song_source m JOIN track t ON t.id=m.source_id WHERE m.source_id=?", arguments: [sourceID]),
              try JSONDecoder().decode(Track.self, from: row["payload"]).source == "bilibili" else { return }
        let song: String = row["song_id"]
        try captureSource(song, db: db)
        if try String.fetchOne(db, sql: "SELECT active_source_id FROM library_song WHERE id=?", arguments: [song]) != sourceID {
            try appendLocal("song:" + song, "archive:" + sourceID, SyncValue(source: SyncSource(songID: song, track: portable(JSONDecoder().decode(Track.self, from: row["payload"])))), db: db)
        }
        try appendLocal("source:" + sourceID, "lyrics", SyncValue(lyrics: document), db: db)
    }
    static func captureLike(_ song: String, liked: Bool, library: LibraryDatabase, db: Database) throws {
        guard let recorder = try recorder(library: library, db: db) else { return }
        try recorder.captureSource(song, db: db)
        try recorder.appendLocal("song:" + song, "liked", SyncValue(flag: liked), db: db)
    }
    static func migrate(_ db: Database) throws {
        try db.execute(sql: """
            CREATE TABLE sync_operation(id TEXT PRIMARY KEY,actor TEXT NOT NULL,sequence INTEGER NOT NULL,payload BLOB NOT NULL,applied INTEGER NOT NULL DEFAULT 0,UNIQUE(actor,sequence));
            CREATE TABLE sync_revision(actor TEXT PRIMARY KEY,sequence INTEGER NOT NULL);
            CREATE INDEX sync_pending ON sync_operation(applied,actor,sequence);
            CREATE TABLE sync_head(entity TEXT NOT NULL,field TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES sync_operation(id),PRIMARY KEY(entity,field,operation_id));
            CREATE TABLE sync_ack(peer TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES sync_operation(id),PRIMARY KEY(peer,operation_id));
            CREATE TABLE sync_like(song_id TEXT PRIMARY KEY,liked INTEGER NOT NULL);
            CREATE TABLE sync_lyric_choice(source_id TEXT PRIMARY KEY);
            """)
    }
    @discardableResult public func record(entity: String, field: String, value: SyncValue) throws -> SyncOperation {
        try library.pool.write { db in
            try checkPaused(db)
            let context = try revisions(db)
            let op = SyncOperation(actor: actor, sequence: (context[actor] ?? 0) + 1, context: context, entity: entity, field: field, value: value)
            try ingest([op], in: db)
            return op
        }
    }
    /// A resolution uses the current revision vector, superseding every observed variant.
    @discardableResult public func resolve(entity: String, field: String, value: SyncValue) throws -> SyncOperation {
        try record(entity: entity, field: field, value: value)
    }
    /// Resolve a displayed conflict as one transaction, including synthetic delete/edit conflicts.
    public func resolve(_ conflict: SyncConflict, choosing variantID: String) throws {
        try library.pool.write { db in
            try checkPaused(db)
            let currentHeads = try allHeads(db)
            let currentVariants: [SyncOperation]
            if conflict.field == "delete/edit" { currentVariants = deleteEditHeads(entity: conflict.entity, heads: currentHeads) }
            else if conflict.field.hasPrefix("entry-delete/edit:") {
                let song = String(conflict.field.dropFirst("entry-delete/edit:".count))
                currentVariants = currentHeads.filter { $0.entity == conflict.entity && $0.field == "entry:" + song && $0.value.flag == false }.flatMap { entryDeleteEditHeads(deletion: $0, heads: currentHeads) }
            } else { currentVariants = currentHeads.filter { $0.entity == conflict.entity && $0.field == conflict.field } }
            guard Set(currentVariants.map(\.id)) == Set(conflict.variants.map(\.id)) else { throw APIError.unavailable("冲突内容已更新，请刷新后重新选择。") }
            guard let variant = conflict.variants.first(where: { $0.id == variantID }) else { throw SyncEngineError.invalidOperation }
            func append(_ entity: String, _ field: String, _ value: SyncValue) throws {
                let context = try revisions(db)
                try ingest([SyncOperation(actor: actor, sequence: (context[actor] ?? 0) + 1, context: context, entity: entity, field: field, value: value)], in: db, materialize: false)
            }
            if conflict.field == "delete/edit" {
                let remove = variant.field == "deleted" && variant.value.flag == true
                try append(conflict.entity, "deleted", SyncValue(flag: remove))
                if !remove { try append(variant.entity, variant.field, variant.value) }
            } else if conflict.field.hasPrefix("entry-delete/edit:") {
                let song = String(conflict.field.dropFirst("entry-delete/edit:".count))
                let remove = variant.field == "entry:" + song && variant.value.flag == false
                try append(conflict.entity, "entry:" + song, SyncValue(flag: !remove))
                if !remove { try append(variant.entity, variant.field, variant.value) }
            } else {
                try append(variant.entity, variant.field, variant.value)
            }
            try project(db)
        }
    }
    public func receive(_ operations: [SyncOperation]) throws -> [String] {
        try library.pool.write { db in
            try checkPaused(db)
            try ingest(operations, in: db)
            return try operations.filter { try Bool.fetchOne(db, sql: "SELECT applied FROM sync_operation WHERE id=?", arguments: [$0.id]) == true }.map(\.id)
        }
    }
    public func outbox(peer: String, limit: Int = 1000) throws -> [SyncOperation] {
        try library.pool.read { db in
            try checkPaused(db)
            return try Data.fetchAll(db, sql: "SELECT payload FROM sync_operation o WHERE applied=1 AND NOT EXISTS(SELECT 1 FROM sync_ack a WHERE a.peer=? AND a.operation_id=o.id) ORDER BY (SELECT COALESCE(SUM(value),0) FROM json_each(o.payload,'$.context')),o.actor,o.sequence LIMIT ?", arguments: [peer, max(0, min(limit, 10_000))]).map { try JSONDecoder().decode(SyncOperation.self, from: $0) }
        }
    }
    public func acknowledge(peer: String, operationIDs: [String]) throws {
        try library.pool.write { db in
            try checkPaused(db)
            for id in operationIDs {
                guard try Bool.fetchOne(db, sql: "SELECT applied FROM sync_operation WHERE id=?", arguments: [id]) == true else { throw SyncEngineError.invalidOperation }
                try db.execute(sql: "INSERT OR IGNORE INTO sync_ack VALUES(?,?)", arguments: [peer, id])
            }
        }
    }
    public func exportSeed() throws -> SyncSeed {
        try library.pool.read { db in
            try checkPaused(db)
            return SyncSeed(operations: try Data.fetchAll(db, sql: "SELECT payload FROM sync_operation WHERE applied=1 ORDER BY actor,sequence").map { try JSONDecoder().decode(SyncOperation.self, from: $0) })
        }
    }
    public func applySeed(_ seed: SyncSeed) throws {
        guard seed.version == 1 else { throw SyncEngineError.invalidOperation }
        try library.pool.write { db in
            try checkPaused(db)
            try ingest(seed.operations, in: db, maximumOperations: 100_000, maximumBytes: 134_217_728)
        }
    }
    public func revision() throws -> [String: Int64] { try library.pool.read { try checkPaused($0); return try revisions($0) } }
    public func likedSongIDs() throws -> [String] {
        try library.pool.read { try String.fetchAll($0, sql: "SELECT song_id FROM sync_like WHERE liked=1 ORDER BY song_id") }
    }
    public func conflicts() throws -> [SyncConflict] {
        try library.pool.read { db in
            let heads = try allHeads(db)
            var result = Dictionary(grouping: heads, by: { $0.entity + "\u{0}" + $0.field }).values.filter { $0.count > 1 }.map {
                SyncConflict(entity: $0[0].entity, field: $0[0].field, variants: $0.sorted { $0.id < $1.id })
            }
            for entity in Set(heads.filter { $0.field == "deleted" }.map(\.entity)) {
                let variants = deleteEditHeads(entity: entity, heads: heads)
                if !variants.isEmpty { result.append(SyncConflict(entity: entity, field: "delete/edit", variants: variants)) }
            }
            for deletion in heads where deletion.field.hasPrefix("entry:") && deletion.value.flag == false {
                let variants = entryDeleteEditHeads(deletion: deletion, heads: heads)
                if !variants.isEmpty { result.append(SyncConflict(entity: deletion.entity, field: "entry-delete/edit:" + String(deletion.field.dropFirst(6)), variants: variants)) }
            }
            return result.sorted { ($0.entity, $0.field) < ($1.entity, $1.field) }
        }
    }
    /// Snapshot current local playlists once, before dispatching the first seed.
    /// Later UI mutations must call record/resolve explicitly.
    public func seedLocalLibrary() throws { try library.pool.write { try seedLocalLibrary(in: $0) } }
    private func seedLocalLibrary(in db: Database) throws {
            try checkPaused(db)
            guard try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM sync_operation") == 0 else { return }
            func append(_ entity: String, _ field: String, _ value: SyncValue) throws {
                let context = try revisions(db)
                try ingest([SyncOperation(actor: actor, sequence: (context[actor] ?? 0) + 1, context: context, entity: entity, field: field, value: value)], in: db, materialize: false)
            }
            let rows = try Row.fetchAll(db, sql: "SELECT s.id,t.payload FROM library_song s JOIN track t ON t.id=s.active_source_id WHERE EXISTS(SELECT 1 FROM playlist p JOIN playlist_track pt ON pt.playlist_id=p.id JOIN song_source m ON m.source_id=pt.track_id WHERE m.song_id=s.id AND json_extract(p.payload,'$.kind')='local') OR EXISTS(SELECT 1 FROM sync_like l WHERE l.song_id=s.id AND l.liked=1) ORDER BY s.id")
            for row in rows {
                let track = try JSONDecoder().decode(Track.self, from: row["payload"])
                guard track.source == "bilibili" else { continue }
                let id: String = row["id"]
                try append("song:" + id, "source", SyncValue(source: SyncSource(songID: id, track: portable(track))))
                if try Bool.fetchOne(db, sql: "SELECT liked FROM sync_like WHERE song_id=?", arguments: [id]) == true {
                    try append("song:" + id, "liked", SyncValue(flag: true))
                }
            }
            for row in try Row.fetchAll(db, sql: "SELECT l.track_id,l.payload FROM lyric l JOIN song_source m ON m.source_id=l.track_id ORDER BY l.track_id") {
                let document = try JSONDecoder().decode(LyricDocument.self, from: row["payload"])
                let chosen = try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM sync_lyric_choice WHERE source_id=?)", arguments: [row["track_id"] as String]) == true
                if document.source == "manual" || chosen {
                    try captureLyrics(document, sourceID: row["track_id"], db: db)
                }
            }
            for row in try Row.fetchAll(db, sql: "SELECT id,payload FROM playlist ORDER BY id") {
                let playlist = try JSONDecoder().decode(Playlist.self, from: row["payload"])
                guard playlist.kind == "local" else { continue }
                let id = "playlist:" + playlist.id
                try append(id, "title", SyncValue(text: playlist.title))
                var order: [String] = []
                for entry in try Row.fetchAll(db, sql: "SELECT m.song_id,t.payload FROM playlist_track pt JOIN track t ON t.id=pt.track_id JOIN song_source m ON m.source_id=t.id WHERE pt.playlist_id=? ORDER BY pt.sort_order", arguments: [playlist.id]) {
                    let track = try JSONDecoder().decode(Track.self, from: entry["payload"])
                    guard track.source == "bilibili" else { continue }
                    let song: String = entry["song_id"]
                    if !order.contains(song) { order.append(song); try append(id, "entry:" + song, SyncValue(flag: true)) }
                }
                try append(id, "order", SyncValue(order: order))
            }
    }
    private func portable(_ track: Track) -> Track {
        var track = track
        track.localFileURL = nil; track.localFileBookmark = nil
        if let url = track.coverURL, url.scheme != "https" || url.user != nil || url.password != nil || url.query != nil || url.fragment != nil { track.coverURL = nil }
        return track
    }
    private func checkPaused(_ db: Database) throws {
        if let value = try Data.fetchOne(db, sql: "SELECT value FROM state WHERE key='sync-paused-after-restore'"), (try? JSONDecoder().decode(Bool.self, from: value)) == true { throw SyncEngineError.pausedAfterRestore }
        if let value = try Data.fetchOne(db, sql: "SELECT value FROM state WHERE key='sync-actor'"), try JSONDecoder().decode(String.self, from: value) != actor { throw SyncEngineError.staleActor }
    }
    private func revisions(_ db: Database) throws -> [String: Int64] {
        Dictionary(uniqueKeysWithValues: try Row.fetchAll(db, sql: "SELECT actor,sequence FROM sync_revision").map { ($0["actor"] as String, $0["sequence"] as Int64) })
    }
    private func encoded(_ op: SyncOperation) throws -> Data { let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(op) }
    private func validate(_ op: SyncOperation) throws {
        func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString == value }
        guard op.version == 1, uuid(op.id), uuid(op.actor), op.sequence > 0, op.sequence < 9_007_199_254_740_991,
              !op.entity.unicodeScalars.contains(where: { $0.value < 32 }),
              op.context.count <= 64, op.context.allSatisfy({ uuid($0.key) && $0.value >= 0 && $0.value < 9_007_199_254_740_991 }),
              (op.context[op.actor] ?? 0) == op.sequence - 1, try encoded(op).count <= 1_048_576 else { throw SyncEngineError.invalidOperation }
        let values = [op.value.text != nil, op.value.flag != nil, op.value.order != nil, op.value.source != nil, op.value.lyrics != nil].filter { $0 }.count
        guard values == 1 else { throw SyncEngineError.invalidOperation }
        if op.entity.hasPrefix("playlist:"), !op.entity.dropFirst(9).isEmpty, op.entity.utf8.count <= 512 {
            if op.field == "title", let title = op.value.text, !title.isEmpty, title.utf8.count <= 4096 { return }
            if op.field == "deleted", op.value.flag != nil { return }
            if op.field.hasPrefix("entry:"), uuid(String(op.field.dropFirst(6))), op.value.flag != nil { return }
            if op.field == "order", let order = op.value.order, order.count <= 10_000, Set(order).count == order.count, order.allSatisfy(uuid) { return }
        }
        if op.entity.hasPrefix("song:"), uuid(String(op.entity.dropFirst(5))) {
            if op.field == "liked", op.value.flag != nil { return }
            if let source = op.value.source, (op.field == "source" || op.field == "archive:" + source.track.id), source.songID == String(op.entity.dropFirst(5)),
               source.track.source == "bilibili", source.track.duration.isFinite, source.track.duration >= 0,
               source.track.id == "bilibili:\(source.track.bvid):video" || source.track.id == "bilibili:\(source.track.bvid):\(source.track.cid.map(String.init) ?? "video")",
               source.track == portable(source.track), !source.track.bvid.isEmpty, !source.track.bvid.contains("/"), !source.track.bvid.contains(":") { return }
        }
        if op.entity.hasPrefix("source:bilibili:"), op.field == "lyrics", let lyrics = op.value.lyrics,
           lyrics.offset.isFinite, lyrics.lines.allSatisfy({ $0.start.isFinite && $0.end.isFinite && $0.words.allSatisfy { $0.start.isFinite && $0.end.isFinite } }) { return }
        throw SyncEngineError.invalidOperation
    }
    private func ingest(_ operations: [SyncOperation], in db: Database, materialize: Bool = true, maximumOperations: Int = 10_000, maximumBytes: Int = 16_777_216) throws {
        guard operations.count <= maximumOperations else { throw SyncEngineError.invalidOperation }
        var batchBytes = 0
        for op in operations {
            try validate(op)
            let payload = try encoded(op)
            batchBytes += payload.count
            guard batchBytes <= maximumBytes else { throw SyncEngineError.invalidOperation }
            if let row = try Row.fetchOne(db, sql: "SELECT id,payload FROM sync_operation WHERE id=? OR (actor=? AND sequence=?)", arguments: [op.id, op.actor, op.sequence]) {
                guard (row["id"] as String) == op.id, (row["payload"] as Data) == payload else { throw SyncEngineError.operationCollision }
                continue
            }
            try db.execute(sql: "INSERT INTO sync_operation(id,actor,sequence,payload) VALUES(?,?,?,?)", arguments: [op.id, op.actor, op.sequence, payload])
        }
        var progressed = true
        while progressed {
            progressed = false
            for payload in try Data.fetchAll(db, sql: "SELECT payload FROM sync_operation WHERE applied=0 ORDER BY actor,sequence") {
                let op = try JSONDecoder().decode(SyncOperation.self, from: payload), revision = try revisions(db)
                guard op.sequence == (revision[op.actor] ?? 0) + 1, op.context.allSatisfy({ (revision[$0.key] ?? 0) >= $0.value }) else { continue }
                for head in try fieldHeads(entity: op.entity, field: op.field, db: db) where (op.context[head.actor] ?? 0) >= head.sequence {
                    try db.execute(sql: "DELETE FROM sync_head WHERE operation_id=?", arguments: [head.id])
                }
                try db.execute(sql: "INSERT INTO sync_head VALUES(?,?,?)", arguments: [op.entity, op.field, op.id])
                try db.execute(sql: "UPDATE sync_operation SET applied=1 WHERE id=?", arguments: [op.id])
                try db.execute(sql: "INSERT INTO sync_revision VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET sequence=excluded.sequence", arguments: [op.actor, op.sequence])
                progressed = true
            }
        }
        guard try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM sync_operation WHERE applied=0")! <= 10_000 else { throw SyncEngineError.invalidOperation }
        if materialize { try project(db) }
    }
    private func allHeads(_ db: Database) throws -> [SyncOperation] {
        try Data.fetchAll(db, sql: "SELECT o.payload FROM sync_head h JOIN sync_operation o ON o.id=h.operation_id ORDER BY h.entity,h.field,o.id").map { try JSONDecoder().decode(SyncOperation.self, from: $0) }
    }
    private func fieldHeads(entity: String, field: String, db: Database) throws -> [SyncOperation] {
        try Data.fetchAll(db, sql: "SELECT o.payload FROM sync_head h JOIN sync_operation o ON o.id=h.operation_id WHERE h.entity=? AND h.field=?", arguments: [entity, field]).map { try JSONDecoder().decode(SyncOperation.self, from: $0) }
    }
    private func deleteEditHeads(entity: String, heads: [SyncOperation]) -> [SyncOperation] {
        let relevant = heads.filter { $0.entity == entity }
        var result: [String: SyncOperation] = [:]
        for deletion in relevant where deletion.field == "deleted" && deletion.value.flag == true {
            for edit in relevant where edit.field != "deleted" && (deletion.context[edit.actor] ?? 0) < edit.sequence && (edit.context[deletion.actor] ?? 0) < deletion.sequence {
                result[deletion.id] = deletion; result[edit.id] = edit
            }
        }
        return result.values.sorted { $0.id < $1.id }
    }
    private func project(_ db: Database) throws {
        let heads = try allHeads(db)
        let winners = Dictionary(grouping: heads, by: { $0.entity + "\u{0}" + $0.field }).values.compactMap { $0.max { $0.id < $1.id } }
        // Sources must be available before playlist memberships and lyrics are projected.
        for op in winners where op.field == "source" {
            guard let source = op.value.source else { continue }
            let track = source.track
            if let owner = try String.fetchOne(db, sql: "SELECT song_id FROM song_source WHERE source_id=?", arguments: [track.id]), owner != source.songID { throw SyncEngineError.sourceOwnershipConflict }
            try db.execute(sql: "INSERT INTO track VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,payload=excluded.payload", arguments: [track.id, track.title, track.artist, try JSONEncoder().encode(track)])
            try db.execute(sql: "INSERT OR IGNORE INTO library_song VALUES(?,?)", arguments: [source.songID, track.id])
            try db.execute(sql: "INSERT OR IGNORE INTO song_source VALUES(?,?,?)", arguments: [track.id, source.songID, try JSONEncoder().encode(track)])
            try db.execute(sql: "UPDATE library_song SET active_source_id=? WHERE id=?", arguments: [track.id, source.songID])
        }
        // Fresh seeds must retain retired sources referenced by lyric choices.
        for payload in try Data.fetchAll(db, sql: "SELECT payload FROM sync_operation WHERE applied=1 AND (json_extract(payload,'$.field')='source' OR json_extract(payload,'$.field') LIKE 'archive:%') ORDER BY actor,sequence") {
            guard let source = try JSONDecoder().decode(SyncOperation.self, from: payload).value.source else { continue }
            let track = source.track
            if let owner = try String.fetchOne(db, sql: "SELECT song_id FROM song_source WHERE source_id=?", arguments: [track.id]), owner != source.songID { throw SyncEngineError.sourceOwnershipConflict }
            try db.execute(sql: "INSERT OR IGNORE INTO track VALUES(?,?,?,?)", arguments: [track.id, track.title, track.artist, try JSONEncoder().encode(track)])
            guard try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM library_song WHERE id=?)", arguments: [source.songID]) == true else { throw SyncEngineError.missingSource }
            try db.execute(sql: "INSERT OR IGNORE INTO song_source VALUES(?,?,?)", arguments: [track.id, source.songID, try JSONEncoder().encode(track)])
        }
        for op in winners where op.field == "liked" {
            let songID = String(op.entity.dropFirst(5))
            guard let payload = try Data.fetchOne(db, sql: "SELECT t.payload FROM library_song s JOIN track t ON t.id=s.active_source_id WHERE s.id=?", arguments: [songID]),
                  try JSONDecoder().decode(Track.self, from: payload).source == "bilibili" else { throw SyncEngineError.missingSource }
            try db.execute(sql: "INSERT INTO sync_like VALUES(?,?) ON CONFLICT(song_id) DO UPDATE SET liked=excluded.liked", arguments: [songID, op.value.flag!])
        }
        for op in winners where op.field == "lyrics" {
            let sourceID = String(op.entity.dropFirst(7))
            guard try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM song_source WHERE source_id=?)", arguments: [sourceID]) == true else { throw SyncEngineError.missingSource }
            try db.execute(sql: "INSERT INTO lyric VALUES(?,?) ON CONFLICT(track_id) DO UPDATE SET payload=excluded.payload", arguments: [sourceID, try JSONEncoder().encode(op.value.lyrics!)])
            try db.execute(sql: "INSERT OR IGNORE INTO sync_lyric_choice VALUES(?)", arguments: [sourceID])
        }
        for entity in Set(winners.filter { $0.entity.hasPrefix("playlist:") }.map(\.entity)).sorted() {
            let fields = winners.filter { $0.entity == entity }, id = String(entity.dropFirst(9))
            let deleted = fields.first { $0.field == "deleted" }?.value.flag == true && deleteEditHeads(entity: entity, heads: heads).isEmpty
            let existing = try Data.fetchOne(db, sql: "SELECT payload FROM playlist WHERE id=?", arguments: [id]).map { try JSONDecoder().decode(Playlist.self, from: $0) }
            guard existing == nil || existing?.kind == "local" else { throw SyncEngineError.invalidOperation }
            let old = try Row.fetchAll(db, sql: "SELECT t.payload,m.song_id FROM playlist_track pt JOIN track t ON t.id=pt.track_id LEFT JOIN song_source m ON m.source_id=t.id WHERE pt.playlist_id=? ORDER BY pt.sort_order", arguments: [id])
            let local = try old.filter { try JSONDecoder().decode(Track.self, from: $0["payload"]).source != "bilibili" }
            if deleted && local.isEmpty { try db.execute(sql: "DELETE FROM playlist WHERE id=?", arguments: [id]); continue }
            var playlist = existing ?? Playlist(id: id, title: fields.first { $0.field == "title" }?.value.text ?? "同步歌单")
            if let title = fields.first(where: { $0.field == "title" })?.value.text { playlist.title = title }
            try db.execute(sql: "INSERT INTO playlist VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,payload=excluded.payload", arguments: [id, playlist.title, try JSONEncoder().encode(playlist)])
            var included = Set(fields.filter { $0.field.hasPrefix("entry:") && $0.value.flag == true }.map { String($0.field.dropFirst(6)) })
            let mentioned = Set(fields.filter { $0.field.hasPrefix("entry:") }.map { String($0.field.dropFirst(6)) })
            // A peer's incomplete library is not a deletion of unmentioned entries.
            for row in old {
                let track = try JSONDecoder().decode(Track.self, from: row["payload"])
                if track.source == "bilibili", let song: String = row["song_id"], !mentioned.contains(song) { included.insert(song) }
            }
            // Concurrent entry delete/add retains the item pending review.
            for op in heads where op.entity == entity && op.field.hasPrefix("entry:") && op.value.flag == true { included.insert(String(op.field.dropFirst(6))) }
            for op in heads where op.entity == entity && op.field.hasPrefix("entry:") && op.value.flag == false && !entryDeleteEditHeads(deletion: op, heads: heads).isEmpty { included.insert(String(op.field.dropFirst(6))) }
            if deleted { included.removeAll() }
            let orderHistory = try Data.fetchAll(db, sql: "SELECT payload FROM sync_operation WHERE applied=1 AND json_extract(payload,'$.entity')=? AND (json_extract(payload,'$.field')='order' OR json_extract(payload,'$.field') LIKE 'entry:%')", arguments: [entity]).map { try JSONDecoder().decode(SyncOperation.self, from: $0) }
            let order = SyncOrdering.networkOrder(winner: fields.first { $0.field == "order" }, history: orderHistory)
            let oldOrder: [String] = old.compactMap { $0["song_id"] as String? }.filter { included.contains($0) && !order.contains($0) }
            let desired = order.filter { included.contains($0) } + oldOrder + included.subtracting(order).subtracting(oldOrder).sorted()
            let existingNetwork = Set(try old.compactMap { row -> String? in try JSONDecoder().decode(Track.self, from: row["payload"]).source == "bilibili" ? row["song_id"] : nil })
            var slots = desired.filter { existingNetwork.contains($0) }.makeIterator(), sourceIDs: [String] = []
            func sourceID(_ song: String) throws -> String {
                guard let row = try Row.fetchOne(db, sql: "SELECT t.id,t.payload FROM library_song s JOIN track t ON t.id=s.active_source_id WHERE s.id=?", arguments: [song]), try JSONDecoder().decode(Track.self, from: row["payload"]).source == "bilibili" else { throw SyncEngineError.missingSource }
                return row["id"]
            }
            for row in old {
                let track = try JSONDecoder().decode(Track.self, from: row["payload"])
                if track.source != "bilibili" { sourceIDs.append(track.id) }
                else if let song = slots.next() { sourceIDs.append(try sourceID(song)) }
            }
            for song in desired where !existingNetwork.contains(song) { sourceIDs.append(try sourceID(song)) }
            try db.execute(sql: "DELETE FROM playlist_track WHERE playlist_id=?", arguments: [id])
            for (index, source) in sourceIDs.enumerated() { try db.execute(sql: "INSERT OR IGNORE INTO playlist_track VALUES(?,?,?)", arguments: [id, source, index]) }
        }
    }
    private func entryDeleteEditHeads(deletion: SyncOperation, heads: [SyncOperation]) -> [SyncOperation] {
        let song = String(deletion.field.dropFirst(6))
        let edits = heads.filter { edit in
            let relevant = (edit.entity == deletion.entity && edit.field == "order" && edit.value.order?.contains(song) == true) || (edit.entity == "song:" + song && edit.field == "source")
            return relevant && (deletion.context[edit.actor] ?? 0) < edit.sequence && (edit.context[deletion.actor] ?? 0) < deletion.sequence
        }
        return edits.isEmpty ? [] : ([deletion] + edits).sorted { $0.id < $1.id }
    }
}
