import AudioToolbox
import Foundation

public enum AudioQuality: String, Codable, CaseIterable, Sendable {
    case aac, lossless, dolby
    public var label: String { switch self { case .aac: "常规 AAC"; case .lossless: "优先无损"; case .dolby: "优先 Dolby 音轨" } }
}
enum AudioStreamSelection {
    static let decoders: Set<AudioFormatID> = {
        var size: UInt32 = 0
        guard AudioFormatGetPropertyInfo(kAudioFormatProperty_DecodeFormatIDs, 0, nil, &size) == noErr else { return [] }
        var formats = [AudioFormatID](repeating: 0, count: Int(size) / MemoryLayout<AudioFormatID>.size)
        let status = formats.withUnsafeMutableBytes { AudioFormatGetProperty(kAudioFormatProperty_DecodeFormatIDs, 0, nil, &size, $0.baseAddress!) }
        return status == noErr ? Set(formats) : []
    }()
    static func codecSupported(_ codec: String) -> Bool {
        let format: AudioFormatID
        switch codec.lowercased() {
        case let value where value.hasPrefix("mp4a"): format = kAudioFormatMPEG4AAC
        case "flac": format = kAudioFormatFLAC
        case "ec-3", "eac3": format = kAudioFormatEnhancedAC3
        case "ac-3", "ac3": format = kAudioFormatAC3
        default: return false
        }
        return decoders.contains(format)
    }
    static func select(_ body: [String: Any], preference: AudioQuality, canDecode: (String) -> Bool = codecSupported) throws -> (stream: [String: Any], quality: AudioQuality, reason: String?) {
        let dash = body.object("dash")
        func valid(_ stream: [String: Any]) -> Bool {
            guard let url = URL(string: stream.string("baseUrl", fallback: "base_url")) else { return false }
            return url.scheme == "https" && url.host != nil && url.user == nil && url.password == nil
        }
        let aac = dash.array("audio").filter {
            let codec = $0.string("codecs").lowercased()
            return valid($0) && (codec.isEmpty || codec.hasPrefix("mp4a"))
        }.max { $0.int("bandwidth") < $1.int("bandwidth") }
        var reason: String?
        if preference != .aac {
            let candidates = preference == .lossless ? [dash.object("flac").object("audio")] : dash.object("dolby").array("audio")
            let available = candidates.filter { valid($0) }
            if let selected = available.filter({ canDecode($0.string("codecs")) }).max(by: { $0.int("bandwidth") < $1.int("bandwidth") }) {
                return (selected, preference, nil)
            }
            reason = available.isEmpty ? "来源或当前账号没有提供所选规格，已使用常规 AAC。" : "当前解码器不支持所选音轨，已使用常规 AAC。"
        }
        guard let aac else { throw APIError.unavailable("没有可用的常规 AAC 音轨。") }
        return (aac, .aac, reason)
    }
}
