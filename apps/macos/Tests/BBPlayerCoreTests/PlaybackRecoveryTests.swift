import XCTest
@testable import BBPlayerCore

private actor RecoveryFixtureProvider: MediaSourceProvider {
    private(set) var requests: [Track] = []
    func search(_ query: String, page: Int) async throws -> [Track] { [] }
    func resolve(_ track: Track) async throws -> ResolvedAudio {
        requests.append(track)
        try await Task.sleep(for: .seconds(300))
        throw APIError.cancelled
    }
}

final class PlaybackRecoveryTests: XCTestCase {
    func testFrozenLoadingDelaysAndThreeAttemptBudget() {
        var policy = PlaybackRecovery()
        for attempt in 0..<3 {
            policy.restartAttempt()
            for second in 0...12 { XCTAssertNil(policy.poll(now: Double(second), position: 42, requested: true, initialLoading: false)) }
            let delay = [1, 3, 6][attempt]
            for second in 1..<delay { XCTAssertNil(policy.poll(now: Double(12 + second), position: 42, requested: true, initialLoading: false)) }
            XCTAssertEqual(policy.poll(now: Double(12 + delay), position: 42, requested: true, initialLoading: false), .retry)
            XCTAssertEqual(policy.attempts, attempt + 1)
        }
        policy.restartAttempt()
        for second in 0..<20 { XCTAssertNil(policy.poll(now: Double(second), position: 42, requested: true, initialLoading: true)) }
        XCTAssertEqual(policy.poll(now: 20, position: 42, requested: true, initialLoading: true), .exhausted)
    }

    func testExcludedTimeSleepGapPauseAndHealthyBudgetReset() {
        var policy = PlaybackRecovery()
        policy.reportFailure()
        XCTAssertNil(policy.poll(now: 0, position: 0, requested: true, initialLoading: true))
        XCTAssertEqual(policy.poll(now: 1, position: 0, requested: true, initialLoading: true), .retry)
        policy.restartAttempt()
        for second in 0...40 { XCTAssertNil(policy.poll(now: Double(second), position: Double(second), requested: true, initialLoading: false)) }
        XCTAssertEqual(policy.attempts, 0)
        for second in 41...100 { XCTAssertNil(policy.poll(now: Double(second), position: 40, requested: true, initialLoading: false, excluded: true)) }
        XCTAssertNil(policy.poll(now: 500, position: 40, requested: true, initialLoading: false))
        for second in 501...511 { XCTAssertNil(policy.poll(now: Double(second), position: 40, requested: true, initialLoading: false)) }
        XCTAssertNil(policy.poll(now: 512, position: 40, requested: true, initialLoading: false))
        XCTAssertNil(policy.poll(now: 513, position: 40, requested: false, initialLoading: false))
        XCTAssertEqual(policy.attempts, 0)
        XCTAssertNil(policy.poll(now: 514, position: 40, requested: false, initialLoading: false))
    }

    func testProgressCancelsPendingRetryAndNetworkLossAloneDoesNotTrigger() {
        var policy = PlaybackRecovery()
        for second in 0...12 { XCTAssertNil(policy.poll(now: Double(second), position: 0, requested: true, initialLoading: false)) }
        for second in 13...100 { XCTAssertNil(policy.poll(now: Double(second), position: Double(second), requested: true, initialLoading: false)) }
        XCTAssertEqual(policy.attempts, 0)
    }

    @MainActor func testIndependentPollRetriesSamePartAndPauseSwitchStopCancel() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try LibraryDatabase(url: root.appendingPathComponent("db.sqlite"))
        let cache = try AudioCache(root: root.appendingPathComponent("cache"))
        let provider = RecoveryFixtureProvider()
        let first = Track(bvid: "first", cid: 77, title: "First", duration: 600)
        var saved = PlaybackSnapshot(); saved.queue = [first]; saved.position = 42; saved.rate = 1.5
        try database.saveState(saved, key: "playback")
        let engine = NativePlaybackEngine(provider: provider, database: database, cache: cache)
        defer { engine.shutdown() }
        engine.play()
        for _ in 0..<20 { await Task.yield() }
        for second in 0...21 { engine.pollRecovery(now: Double(second), connectivityAvailable: true) }
        for _ in 0..<20 { await Task.yield() }
        let initialRequests = await provider.requests
        XCTAssertEqual(initialRequests.map(\.cid), [77, 77])
        XCTAssertEqual(engine.snapshot.rate, 1.5)
        XCTAssertEqual(engine.snapshot.position, 42)
        XCTAssertEqual(engine.currentTrack?.id, first.id)
        engine.pause()
        for second in 22...100 { engine.pollRecovery(now: Double(second), connectivityAvailable: true) }
        let pausedRequests = await provider.requests
        XCTAssertEqual(pausedRequests.count, 2)
        let second = Track(bvid: "second", cid: 88, title: "Second")
        engine.setQueue([second]); engine.stop()
        for second in 101...150 { engine.pollRecovery(now: Double(second), connectivityAvailable: true) }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(engine.currentTrack?.id, second.id)
        XCTAssertFalse(engine.isPlaybackRequested)
        let stoppedRequests = await provider.requests
        XCTAssertLessThanOrEqual(stoppedRequests.count, 3)
    }
}
