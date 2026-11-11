import Foundation

public struct SyncSource: Codable, Sendable {
    public var songID: String
    public var track: Track
    public init(songID: String, track: Track) { self.songID = songID; self.track = track }
}
public struct SyncValue: Codable, Sendable {
    public var text: String?
    public var flag: Bool?
    public var order: [String]?
    public var source: SyncSource?
    public var lyrics: LyricDocument?
    public init(text: String? = nil, flag: Bool? = nil, order: [String]? = nil, source: SyncSource? = nil, lyrics: LyricDocument? = nil) {
        self.text = text; self.flag = flag; self.order = order; self.source = source; self.lyrics = lyrics
    }
}
public struct SyncOperation: Codable, Sendable {
    public var version: Int = 1
    public var id: String
    public var actor: String
    public var sequence: Int64
    public var context: [String: Int64]
    public var entity: String
    public var field: String
    public var value: SyncValue
    public init(id: String = UUID().uuidString, actor: String, sequence: Int64, context: [String: Int64], entity: String, field: String, value: SyncValue) {
        self.id = id; self.actor = actor; self.sequence = sequence; self.context = context; self.entity = entity; self.field = field; self.value = value
    }
}
public struct SyncSeed: Codable, Sendable {
    public var version: Int = 1
    public var operations: [SyncOperation]
    public init(operations: [SyncOperation]) { self.operations = operations }
}
public struct SyncConflict: Sendable {
    public var entity: String
    public var field: String
    public var variants: [SyncOperation]
}
public enum SyncEngineError: Error, Equatable, LocalizedError {
    case invalidOperation, operationCollision, missingSource, sourceOwnershipConflict, pausedAfterRestore, staleActor
    public var errorDescription: String? {
        switch self {
        case .invalidOperation: "同步操作的格式或内容不受支持，未保存修改。"
        case .operationCollision: "同步操作编号重复且内容不同，已停止应用这批修改。"
        case .missingSource: "同步歌曲来源尚未准备好，未保存修改。"
        case .sourceOwnershipConflict: "该来源已属于另一首歌，需要明确处理身份冲突后才能同步。"
        case .pausedAfterRestore: "资料恢复后同步保持暂停，需要明确重新建立同步基线。"
        case .staleActor: "同步身份已更新，请重新打开同步连接。"
        }
    }
}
