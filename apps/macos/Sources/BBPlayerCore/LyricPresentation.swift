import Foundation

public struct LyricPresentation: Codable, Equatable, Sendable {
    public var fontSize = 25.0
    public var spacing = 24.0
    public var translationRatio = 0.65
    public var accent = true
    public var edgeMask = true
    public init() {}
    public var normalized: LyricPresentation {
        var value = self
        value.fontSize = fontSize.isFinite ? min(40, max(16, fontSize)) : 25
        value.spacing = spacing.isFinite ? min(48, max(8, spacing)) : 24
        value.translationRatio = translationRatio.isFinite ? min(1, max(0.4, translationRatio)) : 0.65
        return value
    }
    public static var compact: LyricPresentation { var value = LyricPresentation(); value.fontSize = 20; value.spacing = 12; value.translationRatio = 0.6; return value }
    public static var large: LyricPresentation { var value = LyricPresentation(); value.fontSize = 34; value.spacing = 32; value.translationRatio = 0.75; return value }
}
