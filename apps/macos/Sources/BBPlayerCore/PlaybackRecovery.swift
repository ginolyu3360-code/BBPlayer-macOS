import Foundation

/// Monotonic polling policy, independent of AVPlayer's periodic media callbacks.
struct PlaybackRecovery {
    enum Action: Equatable { case retry, exhausted }
    private(set) var attempts = 0
    private var previousPoll: Double?
    private var previousPosition: Double?
    private var stalled: Double = 0
    private var loading: Double = 0
    private var healthy: Double = 0
    private var pendingDelay: Double?
    private var failed = false

    mutating func reset() { self = Self() }
    mutating func restartAttempt() {
        let count = attempts; reset(); attempts = count
    }
    mutating func reportFailure() { failed = true }

    mutating func poll(now: Double, position: Double, requested: Bool, initialLoading: Bool,
                       excluded: Bool = false) -> Action? {
        guard now.isFinite else { return nil }
        let interval = previousPoll.map { now - $0 } ?? 0
        previousPoll = now
        let progressed = position.isFinite && previousPosition.map { position > $0 + 0.01 } == true
        previousPosition = position.isFinite ? position : nil
        guard requested else { reset(); return nil }
        // Gaps include sleep/wake, a blocked main loop and debugger suspension.
        guard !excluded, interval >= 0, interval <= 3 else {
            stalled = 0; loading = 0; healthy = 0
            return nil
        }
        if progressed {
            stalled = 0; loading = 0; failed = false; pendingDelay = nil
            healthy += interval
            if healthy >= 30 { attempts = 0 }
            return nil
        }
        healthy = 0
        if let delay = pendingDelay {
            pendingDelay = delay - interval
            if delay <= interval { pendingDelay = nil; attempts += 1; return .retry }
            return nil
        }
        if initialLoading { loading += interval } else { stalled += interval }
        guard failed || loading >= 20 || stalled >= 12 else { return nil }
        guard attempts < 3 else { reset(); return .exhausted }
        pendingDelay = [1.0, 3.0, 6.0][attempts]
        return nil
    }
}
