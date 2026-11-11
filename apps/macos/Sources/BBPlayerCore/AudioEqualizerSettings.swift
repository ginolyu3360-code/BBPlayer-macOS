import Foundation

public struct AudioEqualizerSettings: Codable, Equatable, Sendable {
    public static let frequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    public var enabled = false
    public var gains = Array(repeating: 0.0, count: 10)
    public var normalizedGains: [Double] {
        Self.frequencies.indices.map { index in
            guard gains.indices.contains(index), gains[index].isFinite else { return 0 }
            return min(12, max(-12, gains[index]))
        }
    }
    public init() {}
    public enum Preset: String, CaseIterable {
        case flat, bass, voice, bright
        public var gains: [Double] {
            switch self {
            case .flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
            case .bass: [5, 5, 3, 1, 0, 0, 0, 0, 0, 0]
            case .voice: [-3, -2, -1, 0, 1, 2, 3, 2, 0, -1]
            case .bright: [0, 0, 0, 0, 0, 1, 1, 2, 3, 4]
            }
        }
    }
}
