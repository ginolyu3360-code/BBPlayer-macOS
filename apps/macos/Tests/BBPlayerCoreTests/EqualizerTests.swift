import AudioRealtime
import AudioToolbox
import XCTest
@testable import BBPlayerCore

final class EqualizerTests: XCTestCase {
    private func render(rate: Int, frequency: Double, gains: [Double], enabled: Bool = true, channels: Int = 2) throws -> ([Float], [Float]) {
        let state = try XCTUnwrap(bb_eq_create())
        defer { bb_eq_destroy(state) }
        gains.withUnsafeBufferPointer { bb_eq_configure(state, enabled, $0.baseAddress) }
        bb_eq_prepare(state, Double(rate), channels, true)
        let input = (0..<rate * channels).map { index in Float(index % channels == 0 ? 0.1 * sin(2 * .pi * frequency * Double(index / channels) / Double(rate)) : 0) }
        var output = input
        output.withUnsafeMutableBytes { samples in
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: UInt32(samples.count), mData: samples.baseAddress))
            bb_eq_process(state, &list, rate)
        }
        return (input, output)
    }
    private func rms(_ samples: [Float], rate: Int, channels: Int) -> Double {
        let selected = stride(from: rate / 2 * channels, to: samples.count, by: channels).map { Double(samples[$0]) }
        return sqrt(selected.reduce(0) { $0 + $1 * $1 } / Double(selected.count))
    }
    func testDefaultAndFlatAreExactBypassAcrossRatesAndChannels() throws {
        for rate in [32000, 44100, 48000, 96000] {
            for channels in [1, 2] {
                let dry = try render(rate: rate, frequency: 1000, gains: Array(repeating: 6, count: 10), enabled: false, channels: channels)
                XCTAssertEqual(dry.0, dry.1)
                let flat = try render(rate: rate, frequency: 1000, gains: Array(repeating: 0, count: 10), channels: channels)
                XCTAssertEqual(flat.0, flat.1)
            }
        }
    }
    func testPeakingResponseRetainsStereoSeparationAndAppliesHeadroom() throws {
        for rate in [44100, 48000, 96000] {
            var gains = Array(repeating: 0.0, count: 10); gains[5] = 6
            let peak = try render(rate: rate, frequency: 1000, gains: gains)
            let outside = try render(rate: rate, frequency: 125, gains: gains)
            let ratio = rms(peak.1, rate: rate, channels: 2) / rms(outside.1, rate: rate, channels: 2)
            XCTAssertEqual(20 * log10(ratio), 6, accuracy: 0.3)
            XCTAssertTrue(peak.1.allSatisfy { $0.isFinite && abs($0) < 0.11 })
            XCTAssertTrue(stride(from: 1, to: peak.1.count, by: 2).allSatisfy { peak.1[$0] == 0 })
        }
    }
    func testPlanarFloatChannelsAndSmoothedDisable() throws {
        let state = try XCTUnwrap(bb_eq_create())
        defer { bb_eq_destroy(state) }
        var gains = Array(repeating: 0.0, count: 10); gains[5] = 6
        gains.withUnsafeBufferPointer { bb_eq_configure(state, true, $0.baseAddress) }
        bb_eq_prepare(state, 48000, 2, true)
        var left = Array(repeating: Float(0.1), count: 24000), right = Array(repeating: Float(0), count: 24000)
        func process() {
            left.withUnsafeMutableBytes { l in right.withUnsafeMutableBytes { r in
                let allocation = UnsafeMutableRawPointer.allocate(byteCount: MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.stride, alignment: MemoryLayout<AudioBufferList>.alignment)
                defer { allocation.deallocate() }
                let list = allocation.bindMemory(to: AudioBufferList.self, capacity: 1)
                list.initialize(to: AudioBufferList(mNumberBuffers: 2, mBuffers: AudioBuffer()))
                let buffers = UnsafeMutableAudioBufferListPointer(list)
                buffers[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(l.count), mData: l.baseAddress)
                buffers[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(r.count), mData: r.baseAddress)
                bb_eq_process(state, allocation, l.count / MemoryLayout<Float>.size)
            } }
        }
        process()
        XCTAssertTrue(right.allSatisfy { $0 == 0 })
        let before = try XCTUnwrap(left.last)
        XCTAssertLessThan(before, 0.06)
        gains.withUnsafeBufferPointer { bb_eq_configure(state, false, $0.baseAddress) }
        left = Array(repeating: 0.1, count: left.count)
        process()
        XCTAssertEqual(left[0], before, accuracy: 0.001)
        XCTAssertEqual(left.last!, 0.1, accuracy: 0.00001)
        left = Array(repeating: 0.1, count: left.count)
        process()
        XCTAssertTrue(left.allSatisfy { $0 == 0.1 })
    }
    func testUnsupportedInputIsUntouchedAndMalformedGainsAreBounded() throws {
        let settings = AudioEqualizerSettings()
        XCTAssertFalse(settings.enabled)
        var malformed = settings; malformed.gains = [Double.nan, 100, -100]
        XCTAssertEqual(malformed.normalizedGains, [0,12,-12,0,0,0,0,0,0,0])
        let state = try XCTUnwrap(bb_eq_create())
        defer { bb_eq_destroy(state) }
        bb_eq_prepare(state, 48000, 2, false)
        XCTAssertEqual(bb_eq_status(state), -1)
        var values: [Float] = [0.25, -0.5]
        values.withUnsafeMutableBytes { bytes in
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
            bb_eq_process(state, &list, 1)
        }
        XCTAssertEqual(values, [0.25,-0.5])
    }
}
