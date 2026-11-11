import Foundation
import GRDB

/// Internal migration rollback material, not a portable library export.
/// Uses SQLite backup so committed WAL contents are included consistently.
public enum DatabaseSnapshot {
    public enum SnapshotError: Error { case destinationExists, invalidDatabase }

    public static func create(from source: any DatabaseReader, at destination: URL) throws {
        let manager = FileManager.default
        guard !manager.fileExists(atPath: destination.path) else { throw SnapshotError.destinationExists }
        let parent = destination.deletingLastPathComponent()
        try manager.createDirectory(at: parent, withIntermediateDirectories: true)
        let staging = parent.appendingPathComponent(".snapshot-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: staging) }
        let file = staging.appendingPathComponent("database.sqlite")
        let copy = try DatabaseQueue(path: file.path)
        do {
            try source.backup(to: copy)
            // A snapshot must not depend on WAL sidecars after publication.
            try copy.writeWithoutTransaction { db in
                _ = try String.fetchOne(db, sql: "PRAGMA journal_mode=DELETE")
            }
            try copy.read { db in
                guard try String.fetchAll(db, sql: "PRAGMA quick_check") == ["ok"],
                      try Row.fetchAll(db, sql: "PRAGMA foreign_key_check").isEmpty else {
                    throw SnapshotError.invalidDatabase
                }
            }
            try copy.close()
        } catch {
            try? copy.close()
            throw error
        }
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        // Same-volume rename publishes only a closed, validated snapshot.
        // moveItem refuses to replace an existing rollback artifact.
        try manager.moveItem(at: file, to: destination)
    }
}
