import XCTest
@testable import BBPlayerCore

final class AudioStreamSelectionTests: XCTestCase {
    func testHighestOrdinaryAACIsDefaultAndMissingOrUnsupportedPremiumFallsBack() throws {
        let low: [String: Any] = ["baseUrl":"https://example.com/low.m4s","codecs":"mp4a.40.2","bandwidth":64000]
        let high: [String: Any] = ["baseUrl":"https://example.com/high.m4s","codecs":"mp4a.40.2","bandwidth":192000]
        let lossless: [String: Any] = ["baseUrl":"https://example.com/lossless.m4s","codecs":"fLaC","bandwidth":900000]
        let body: [String: Any] = ["dash":["audio":[low,high],"flac":["audio":lossless]]]
        XCTAssertEqual(try AudioStreamSelection.select(body, preference: .aac).stream.string("baseUrl"), high.string("baseUrl"))
        let unsupported = try AudioStreamSelection.select(body, preference: .lossless, canDecode: { _ in false })
        XCTAssertEqual(unsupported.quality, .aac)
        XCTAssertNotNil(unsupported.reason)
        let selected = try AudioStreamSelection.select(body, preference: .lossless, canDecode: { $0.lowercased() == "flac" })
        XCTAssertEqual(selected.quality, .lossless)
        XCTAssertNil(selected.reason)
        let missing = try AudioStreamSelection.select(body, preference: .dolby)
        XCTAssertEqual(missing.quality, .aac)
        XCTAssertNotNil(missing.reason)
        XCTAssertThrowsError(try AudioStreamSelection.select(["dash":["audio":[["baseUrl":"http://example.com/audio","codecs":"mp4a.40.2"]]]], preference: .aac))
    }
}
