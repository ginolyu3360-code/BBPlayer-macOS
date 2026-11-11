import Foundation
import AVFoundation
import MediaPlayer
import Accelerate
import Observation
import AudioRealtime
import Network
import AppKit

@MainActor
@Observable public final class NativePlaybackEngine: PlaybackEngine {
    public private(set) var startupTiming = PlaybackTiming()
    @ObservationIgnored private var startupClock = ProcessInfo.processInfo.systemUptime
    public private(set) var snapshot = PlaybackSnapshot()
    public private(set) var isPlaying = false
    public private(set) var isLoading = false
    public private(set) var position: Double = 0
    public private(set) var duration: Double = 0
    public private(set) var chapters: [Chapter] = []
    public private(set) var equalizerStatus = 0
    public private(set) var streamInfo: AudioStreamInfo?
    public private(set) var errorMessage: String?
    public private(set) var spectrum: [Float] = Array(repeating: 0, count: 48)
    public private(set) var lyrics = LyricDocument()
    public private(set) var sleepEnd: Date?
    public var preferences = PlayerPreferences() { didSet { applyPreferences() } }
    public var visualizerVisible = false { didSet { updateSpectrumDemand() } }
    public var onTrackChanged: ((Track) -> Void)?
    public var onError: ((Error) -> Void)?
    public var currentTrack: Track? { snapshot.queue.indices.contains(snapshot.index) ? snapshot.queue[snapshot.index] : nil }
    public var isPlaybackRequested: Bool { wantsPlayback }
    /// Read the media clock only while a visible animation requests a frame.
    public var renderPosition: Double { let time = player.currentTime().seconds; return time.isFinite ? max(0, time) : position }
    public var diagnostics: [String: String] {
        ["timeControl": String(player.timeControlStatus.rawValue), "rate": String(player.rate), "waiting": player.reasonForWaitingToPlay?.rawValue ?? "", "itemStatus": String(player.currentItem?.status.rawValue ?? -1), "requested": String(wantsPlayback), "repeat": snapshot.repeatMode.rawValue, "bufferedAhead": String(bufferedAhead), "bufferRecovery": String(waitingForBuffer), "segmented": String(resourceLoader?.isSegmented == true)]
    }
    public var capturedFrames: UInt64 { bb_pcm_frames(pcm) }

    @ObservationIgnored private let player = AVPlayer()
    @ObservationIgnored private let provider: any MediaSourceProvider
    @ObservationIgnored private let database: LibraryDatabase
    @ObservationIgnored private let cache: AudioCache
    @ObservationIgnored private var playbackActivity: NSObjectProtocol?
    @ObservationIgnored private var visualizationTrack: AVAssetTrack?
    @ObservationIgnored private var resourceLoader: AudioResourceLoader?
    @ObservationIgnored private var metadataTask: Task<Void, Never>?
    @ObservationIgnored private var visualizationTask: Task<Void, Never>?
    @ObservationIgnored private var prefetchSourceTask: Task<ResolvedAudio, Error>?
    @ObservationIgnored private var prefetchSourceID: String?
    @ObservationIgnored private var prefetchTask: Task<Void, Never>?
    @ObservationIgnored private var prefetchGeneration = UUID()
    @ObservationIgnored private var prefetchedSource: (requestedID: String, source: ResolvedAudio, expires: Date)?
    @ObservationIgnored private var attemptedPrefetch: String?
    @ObservationIgnored private var stablePlaybackClock: Double?
    @ObservationIgnored private var bufferObservation: NSKeyValueObservation?
    @ObservationIgnored private var emptyObservation: NSKeyValueObservation?
    @ObservationIgnored private var hasPlayedCurrent = false
    @ObservationIgnored private var waitingForBuffer = false
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var observation: NSKeyValueObservation?
    @ObservationIgnored private var statusObservation: NSKeyValueObservation?
    @ObservationIgnored private var timeToken: Any?
    @ObservationIgnored private var progressInterval = -1.0
    @ObservationIgnored private var endToken: NSObjectProtocol?
    @ObservationIgnored private var failureToken: NSObjectProtocol?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var loadedTrackID: String?
    @ObservationIgnored private var normalizationGain: Float = 1
    @ObservationIgnored private var consecutiveFailures = 0
    @ObservationIgnored private var shuffleRemaining: [String] = []
    @ObservationIgnored private var shuffleCycleStarted = false
    @ObservationIgnored private var historyID = UUID().uuidString
    @ObservationIgnored private var historyStart = Date()
    @ObservationIgnored private var accumulator = ListeningAccumulator()
    @ObservationIgnored private var coveredMedia = 0.0
    @ObservationIgnored private var previousPosition: Double?
    @ObservationIgnored private var lastCheckpoint = 0.0
    private var wantsPlayback = false
    @ObservationIgnored private var aacFallbackTrack: String?
    @ObservationIgnored private var configuredQuality: AudioQuality = .aac
    @ObservationIgnored private var refreshedSource = false
    @ObservationIgnored private var previewLyrics: LyricDocument?
    @ObservationIgnored private var previewSnapshot: (PlaybackSnapshot, Bool)?
    @ObservationIgnored private var audioTapContext: PlaybackTapContext?
    @ObservationIgnored private var equalizerDetach: Task<Void, Never>?
    @ObservationIgnored private let pcm: OpaquePointer
    @ObservationIgnored private var spectrumTimer: Timer?
    @ObservationIgnored private var sleepTimer: Timer?
    @ObservationIgnored private var libraryWritesSuspended: Bool
    @ObservationIgnored private var hasShutdown = false
    @ObservationIgnored private var localAudioAccess: LocalAudioAccess?
    @ObservationIgnored private var recovery = PlaybackRecovery()
    @ObservationIgnored private var recoveryTimer: Timer?
    @ObservationIgnored private let connectivity = NWPathMonitor()
    @ObservationIgnored private var networkAvailable = true
    @ObservationIgnored private var sourceIsLocal = false
    @ObservationIgnored private var seekToken: UUID?
    @ObservationIgnored private var workspaceTokens: [NSObjectProtocol] = []
    @ObservationIgnored private var systemSleeping = false
    @ObservationIgnored private var remoteTargets: [(command: MPRemoteCommand, target: Any)] = []
    var remoteCommandRegistrationCount: Int { remoteTargets.count }
    @ObservationIgnored private var fftReal = [Float](repeating: 0, count: 1024)
    @ObservationIgnored private var fftImag = [Float](repeating: 0, count: 1024)
    @ObservationIgnored private var fftOutReal = [Float](repeating: 0, count: 1024)
    @ObservationIgnored private var fftOutImag = [Float](repeating: 0, count: 1024)
    @ObservationIgnored private var fftWindow = [Float](repeating: 0, count: 1024)
    @ObservationIgnored private var fft: vDSP_DFT_Setup?

    public init(provider: any MediaSourceProvider, database: LibraryDatabase, cache: AudioCache, restore: Bool = true, writesSuspended: Bool = false, allowAutoplay: Bool = true) {
        self.provider = provider; self.database = database; self.cache = cache
        libraryWritesSuspended = writesSuspended
        pcm = bb_pcm_create()!
        fft = vDSP_DFT_zop_CreateSetup(nil, 1024, .FORWARD)
        vDSP_hann_window(&fftWindow, 1024, Int32(vDSP_HANN_NORM))
        if restore {
            snapshot = (try? database.state(PlaybackSnapshot.self, key: "playback")) ?? PlaybackSnapshot()
            preferences = (try? database.state(PlayerPreferences.self, key: "preferences")) ?? PlayerPreferences()
            position = snapshot.position; duration = currentTrack?.duration ?? 0
        }
        player.automaticallyWaitsToMinimizeStalling = false
        observation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                if self.isPlaying { self.captureAudibleTail() }
                self.isPlaying = self.player.timeControlStatus == .playing
                if self.isPlaying {
                    self.previousPosition = self.player.currentTime().seconds
                    self.hasPlayedCurrent = true; self.waitingForBuffer = false; self.isLoading = false
                    if self.stablePlaybackClock == nil { self.stablePlaybackClock = ProcessInfo.processInfo.systemUptime }
                } else {
                    self.stablePlaybackClock = nil; self.cancelPrefetch(reset: false)
                    if self.wantsPlayback, self.player.currentItem?.status == .readyToPlay { self.waitingForBuffer = true; self.isLoading = true }
                }
                _ = self.accumulator.update(clock: ProcessInfo.processInfo.systemUptime, audible: self.isPlaying)
                if !self.isPlaying { self.previousPosition = nil }
                self.resumeBufferedPlayback(); self.updateSpectrumDemand(); self.updateNowPlaying()
            }
        }
        endToken = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in
                guard let self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
                if self.isPlaying { self.captureAudibleTail() }
                self.finishHistory(completed: self.coveredMedia >= self.duration * 0.9)
                if self.previewSnapshot != nil { self.endPreview(); return }
                if self.snapshot.repeatMode == .track {
                    self.resetListeningSession(); self.seek(to: 0); self.play()
                } else { self.next(automatic: true) }
            }
        }
        failureToken = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in
                guard let self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
                self.handleFailure(item.error ?? APIError.network("playback"))
            }
        }
        configureRemoteCommands()
        connectivity.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor in self?.networkAvailable = available }
        }
        connectivity.start(queue: DispatchQueue(label: "playback-connectivity"))
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollRecovery(now: ProcessInfo.processInfo.systemUptime) }
        }
        recoveryTimer = timer
        RunLoop.main.add(timer, forMode: .common)
        for notification in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification] {
            workspaceTokens.append(NSWorkspace.shared.notificationCenter.addObserver(forName: notification, object: nil, queue: .main) { [weak self] note in
                let sleeping = note.name == NSWorkspace.willSleepNotification
                Task { @MainActor in
                    guard let self else { return }
                    self.systemSleeping = sleeping
                    self.recovery.restartAttempt()
                }
            })
        }
        applyPreferences()
        if allowAutoplay, preferences.autoplay, currentTrack != nil { play() }
    }
    deinit {
        recoveryTimer?.invalidate(); connectivity.cancel()
        for token in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }
        for entry in remoteTargets { entry.command.removeTarget(entry.target) }
        if let timeToken { player.removeTimeObserver(timeToken) }
        for token in [endToken, failureToken].compactMap({ $0 }) { NotificationCenter.default.removeObserver(token) }
        spectrumTimer?.invalidate(); sleepTimer?.invalidate()
        if let fft { vDSP_DFT_DestroySetup(fft) }
        bb_pcm_destroy(pcm)
        if let playbackActivity { ProcessInfo.processInfo.endActivity(playbackActivity) }
    }
    public func setQueue(_ tracks: [Track], index: Int = 0) {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        finishHistory(completed: false)
        previewSnapshot = nil; previewLyrics = nil
        snapshot.queue = tracks
        shuffleRemaining = []; shuffleCycleStarted = false
        load(index: index)
    }
    public func play() {
        guard !libraryWritesSuspended, !hasShutdown, currentTrack != nil else { return }
        wantsPlayback = true
        if player.currentItem?.status == .failed { load(index: snapshot.index, position: position, refresh: true); return }
        if loadedTrackID != currentTrack?.id { load(index: snapshot.index, position: snapshot.position); return }
        if duration > 0, position >= duration - 0.25 { resetListeningSession(); seek(to: 0) }
        player.playImmediately(atRate: Float(snapshot.rate))
    }
    public func pause() { recovery.reset(); cancelPrefetch(reset: false); stablePlaybackClock = nil; waitingForBuffer = false; wantsPlayback = false; if isPlaying { captureAudibleTail() }; player.pause(); isPlaying = false; updateSpectrumDemand(); updateNowPlaying(); _ = accumulator.update(clock: ProcessInfo.processInfo.systemUptime, audible: false); previousPosition = nil; saveCheckpoint() }
    public func toggle() { wantsPlayback ? pause() : play() }
    public func seek(to seconds: Double) {
        guard !libraryWritesSuspended, !hasShutdown, seconds.isFinite else { return }
        let target = max(0, min(seconds, duration > 0 ? duration : seconds))
        previousPosition = nil
        _ = accumulator.update(clock: ProcessInfo.processInfo.systemUptime, audible: false)
        let seeking = UUID(); seekToken = seeking
        player.seek(to: CMTime(seconds: target, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in if self?.seekToken == seeking { self?.seekToken = nil } }
        }
        position = target; snapshot.position = target; saveCheckpoint(); updateNowPlaying()
    }
    public func jump(_ seconds: Double) { seek(to: position + seconds) }
    public func setRate(_ rate: Double) {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        snapshot.rate = min(3, max(0.5, rate)); if isPlaying { player.rate = Float(snapshot.rate) }
        previousPosition = nil; saveCheckpoint(); updateNowPlaying()
    }
    public func setRepeat(_ mode: RepeatMode) { guard !libraryWritesSuspended, !hasShutdown else { return }; snapshot.repeatMode = mode; queueDidChange(); saveCheckpoint() }
    public func toggleShuffle() { guard !libraryWritesSuspended, !hasShutdown else { return }; snapshot.shuffled.toggle(); shuffleRemaining = []; shuffleCycleStarted = false; queueDidChange(); saveCheckpoint() }
    public func enqueue(_ track: Track, next: Bool = false) {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        if snapshot.queue.isEmpty { setQueue([track]); return }
        if next {
            // Moving the active entry must never restart or duplicate playback.
            guard track.id != currentTrack?.id else { return }
            let removedBeforeCurrent = snapshot.queue.prefix(snapshot.index).filter { $0.id == track.id }.count
            snapshot.queue.removeAll { $0.id == track.id }
            snapshot.index -= removedBeforeCurrent
            snapshot.queue.insert(track, at: min(snapshot.index + 1, snapshot.queue.count))
        } else {
            enqueue([track]); return
        }
        queueDidChange(); saveCheckpoint()
    }
    @discardableResult public func enqueue(_ tracks: [Track]) -> Int {
        guard !libraryWritesSuspended, !hasShutdown else { return 0 }
        var seen = Set(snapshot.queue.map(\.id))
        let additions = tracks.filter { seen.insert($0.id).inserted }
        guard !additions.isEmpty else { return 0 }
        if snapshot.queue.isEmpty { setQueue(additions) }
        else { snapshot.queue.append(contentsOf: additions); queueDidChange(); saveCheckpoint() }
        return additions.count
    }
    public func removeFromQueue(at index: Int) {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        guard snapshot.queue.indices.contains(index) else { return }
        if index == snapshot.index {
            finishHistory(completed: false); snapshot.queue.remove(at: index)
            if snapshot.queue.isEmpty { stop(); snapshot.index = 0; queueDidChange(); saveCheckpoint() } else { load(index: min(index, snapshot.queue.count - 1)) }
        } else { snapshot.queue.remove(at: index); if index < snapshot.index { snapshot.index -= 1 }; queueDidChange(); saveCheckpoint() }
    }
    public func moveQueue(from: Int, to: Int) {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        guard snapshot.queue.indices.contains(from), snapshot.queue.indices.contains(to) else { return }
        moveQueue(fromOffsets: IndexSet(integer: from), toOffset: from < to ? to + 1 : to)
    }
    /// Destination is an insertion boundary in the original queue, as in a List move.
    public func moveQueue(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        guard !offsets.isEmpty, offsets.allSatisfy({ snapshot.queue.indices.contains($0) }),
              (0...snapshot.queue.count).contains(destination), snapshot.queue.indices.contains(snapshot.index) else { return }
        var order = Array(snapshot.queue.indices)
        let moved = offsets.map { order[$0] }
        for index in offsets.reversed() { order.remove(at: index) }
        let insertion = destination - offsets.filter { $0 < destination }.count
        order.insert(contentsOf: moved, at: insertion)
        // Preserve the active occurrence even in restored queues with duplicate IDs.
        let activeIndex = order.firstIndex(of: snapshot.index)!
        let original = snapshot.queue
        snapshot.queue = order.map { original[$0] }
        snapshot.index = activeIndex
        queueDidChange(); saveCheckpoint()
    }
    public func skip(to index: Int) { finishHistory(completed: false); load(index: index) }
    public func next(automatic: Bool = false) {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        guard !snapshot.queue.isEmpty else { return }
        if !automatic { finishHistory(completed: false) }
        if let index = upcomingIndex(automatic: automatic, consume: true) { load(index: index) } else { pause() }
    }
    private func upcomingIndex(automatic: Bool, consume: Bool) -> Int? {
        guard !snapshot.queue.isEmpty else { return nil }
        if snapshot.shuffled && snapshot.queue.count > 1 {
            let valid = Set(snapshot.queue.filter { $0.id != currentTrack?.id }.map(\.id))
            shuffleRemaining.removeAll { !valid.contains($0) }
            if shuffleRemaining.isEmpty {
                if automatic && snapshot.repeatMode != .queue && shuffleCycleStarted { return nil }
                shuffleRemaining = Array(valid).shuffled(); shuffleCycleStarted = true
            }
            let id = consume ? shuffleRemaining.popLast() : shuffleRemaining.last
            return id.flatMap { id in snapshot.queue.firstIndex { $0.id == id } }
        }
        let index = snapshot.index + 1
        return index < snapshot.queue.count ? index : (snapshot.repeatMode == .queue ? 0 : nil)
    }

    public func previous() {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        if position > 3 { seek(to: 0); return }
        finishHistory(completed: false); load(index: max(0, snapshot.index - 1))
    }
    public func preview(_ track: Track) {
        guard !libraryWritesSuspended, !hasShutdown else { return }
        if previewSnapshot == nil { snapshot.position = position; saveCheckpoint(); finishHistory(completed: false); previewLyrics = lyrics; previewSnapshot = (snapshot, wantsPlayback) }
        snapshot.queue = [track]; snapshot.index = 0; load(index: 0)
    }
    public func endPreview() {
        guard let (original, wasPlaying) = previewSnapshot else { return }
        previewSnapshot = nil; stop(); snapshot = original; position = original.position; duration = currentTrack?.duration ?? 0
        lyrics = previewLyrics ?? LyricDocument(); previewLyrics = nil; chapters = []
        if wasPlaying { play() }
    }
    public func setLyrics(_ document: LyricDocument) { lyrics = document }
    public func setSleepTimer(minutes: Double?) {
        sleepTimer?.invalidate(); sleepTimer = nil; sleepEnd = nil
        guard let minutes, minutes > 0 else { return }
        sleepEnd = Date().addingTimeInterval(minutes * 60)
        sleepTimer = Timer.scheduledTimer(withTimeInterval: minutes * 60, repeats: false) { [weak self] _ in Task { @MainActor in self?.pause(); self?.sleepEnd = nil } }
    }
    public func shutdown() {
        guard !hasShutdown else { return }
        pause(); stop(); sleepTimer?.invalidate(); spectrumTimer?.invalidate()
        recoveryTimer?.invalidate(); connectivity.cancel()
        for token in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }
        workspaceTokens.removeAll()
        hasShutdown = true; libraryWritesSuspended = true
        for entry in remoteTargets { entry.command.removeTarget(entry.target) }
        remoteTargets.removeAll()
    }
    /// Install restored preferences before permitting this empty engine to persist again.
    public func completeLibraryRestore(preferences restored: PlayerPreferences) {
        guard libraryWritesSuspended, !hasShutdown else { return }
        stop(); snapshot = PlaybackSnapshot(); position = 0; duration = 0
        lyrics = LyricDocument(); chapters = []
        preferences = restored
        libraryWritesSuspended = false
        applyPreferences()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
    }
    public func stop() {
        recovery.reset(); seekToken = nil
        equalizerDetach?.cancel(); equalizerDetach = nil; audioTapContext = nil; equalizerStatus = 0
        loadTask?.cancel(); metadataTask?.cancel(); metadataTask = nil; visualizationTask?.cancel(); visualizationTask = nil; cancelPrefetch(reset: true)
        bufferObservation = nil; emptyObservation = nil; hasPlayedCurrent = false; waitingForBuffer = false; stablePlaybackClock = nil
        generation = UUID(); wantsPlayback = false; player.pause(); player.replaceCurrentItem(with: nil)
        resourceLoader?.cancel(); resourceLoader = nil; localAudioAccess = nil; visualizationTrack = nil; statusObservation = nil; loadedTrackID = nil; streamInfo = nil
        isPlaying = false; isLoading = false; updateSpectrumDemand()
    }
    private func load(index: Int, position requestedPosition: Double? = nil, refresh: Bool = false, autoplay: Bool = true, recovering: Bool = false) {
        guard !libraryWritesSuspended, !hasShutdown, snapshot.queue.indices.contains(index) else { return }
        let track = snapshot.queue[index]
        let prepared = prefetchedSource.flatMap { $0.requestedID == track.id && $0.expires > Date() && !refresh ? $0.source : nil }
        let pendingSource = !refresh && prefetchSourceID == track.id ? prefetchSourceTask : nil
        if pendingSource != nil { prefetchSourceTask = nil; prefetchSourceID = nil }
        let savedRecovery = recovery
        stop(); if recovering { recovery = savedRecovery; recovery.restartAttempt() }
        wantsPlayback = autoplay; refreshedSource = refresh; snapshot.index = index; snapshot.position = requestedPosition ?? 0; position = requestedPosition ?? 0; errorMessage = nil; isLoading = true
        sourceIsLocal = track.source == "local"
        let token = UUID(); generation = token
        startupClock = ProcessInfo.processInfo.systemUptime; startupTiming = PlaybackTiming()
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let local = try database.state(URL.self, key: "download-file:" + track.id)
                var source: ResolvedAudio
                if let local, FileManager.default.fileExists(atPath: local.path), aacFallbackTrack != track.id {
                    let metadata = try database.state(OfflineAudioMetadata.self, key: "download-metadata:" + track.id)
                    let offlineTrack = Self.offlinePlaybackTrack(requested: track, metadata: metadata?.track)
                    source = ResolvedAudio(track: offlineTrack, url: local, measuredLoudness: metadata?.measuredLoudness, targetLoudness: metadata?.targetLoudness, chapters: metadata?.chapters ?? [], streamInfo: metadata?.streamInfo)
                }
                else if let prepared { source = prepared }
                else if let pendingSource {
                    do {
                        let resolved = try await withTaskCancellationHandler(operation: { try await pendingSource.value }, onCancel: { pendingSource.cancel() })
                        try Task.checkCancellation()
                        if AudioPrefetch.expiry(for: resolved) > Date() { source = resolved }
                        else { source = try await provider.resolve(track, quality: aacFallbackTrack == track.id ? .aac : preferences.audioQuality ?? .aac) }
                    } catch {
                        try Task.checkCancellation()
                        source = try await provider.resolve(track, quality: aacFallbackTrack == track.id ? .aac : preferences.audioQuality ?? .aac)
                    }
                }
                else { source = try await provider.resolve(track, quality: aacFallbackTrack == track.id ? .aac : preferences.audioQuality ?? .aac) }
                try Task.checkCancellation()
                guard token == generation, snapshot.queue.indices.contains(snapshot.index), currentTrack?.id == track.id else { return }
                startupTiming.sourceReady = ProcessInfo.processInfo.systemUptime - startupClock
                if aacFallbackTrack == track.id { source.streamInfo?.fallbackReason = "所选音轨播放失败，已回退常规 AAC。" }
                sourceIsLocal = source.url.isFileURL
                snapshot.queue[snapshot.index] = source.track
                let asset: AVURLAsset
                if source.url.isFileURL {
                    if source.track.source == "local" { localAudioAccess = LocalAudioAccess(source.url) }
                    asset = AVURLAsset(url: source.url)
                }
                else { let loader = AudioResourceLoader(source: source, cache: cache, onFirstByte: { [weak self] in
                    Task { @MainActor in guard let self, self.generation == token, self.startupTiming.firstByte == nil else { return }; self.startupTiming.firstByte = ProcessInfo.processInfo.systemUptime - self.startupClock }
                }, onDelivery: { [weak self] in
                    Task { @MainActor in guard let self, self.generation == token, self.startupTiming.firstDelivery == nil else { return }; self.startupTiming.firstDelivery = ProcessInfo.processInfo.systemUptime - self.startupClock }
                }, onForeground: { [weak self] in
                    Task { @MainActor in guard let self, self.generation == token else { return }; self.cancelPrefetch(reset: false) }
                }); resourceLoader = loader; try await loader.prepareForPlayback(); try Task.checkCancellation(); guard token == generation else { return }; asset = loader.asset }
                let item = AVPlayerItem(asset: asset, automaticallyLoadedAssetKeys: [])
                item.preferredForwardBufferDuration = 5
                if !source.url.isFileURL && source.chapters.isEmpty {
                    metadataTask = Task { [weak self, provider] in
                        guard let chapters = try? await provider.chapters(for: source.track), let self, !Task.isCancelled, self.generation == token else { return }
                        self.chapters = chapters
                    }
                }
                normalizationGain = Loudness.gain(measured: source.measuredLoudness, target: source.targetLoudness ?? -14)
                player.volume = Float(preferences.volume) * (preferences.normalization ? normalizationGain : 1)
                player.replaceCurrentItem(with: item)
                loadedTrackID = source.track.id; chapters = source.chapters; streamInfo = source.streamInfo
                duration = source.track.duration
                resetListeningSession()
                let saved = try database.resume(trackID: source.track.id)
                if requestedPosition == nil, track.duration > 600, let saved { snapshot.rate = saved.rate }
                let requested = requestedPosition ?? (track.duration > 600 ? saved?.position : nil) ?? 0
                let resume = track.duration > 0 && requested >= track.duration - 0.5 ? 0 : requested
                if resume > 0 { seekToken = token; await player.seek(to: CMTime(seconds: resume, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero); position = resume; snapshot.position = resume; if seekToken == token { seekToken = nil } }
                try Task.checkCancellation(); guard token == generation else { return }
                statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
                    Task { @MainActor in
                        guard let self, token == self.generation else { return }
                        if item.status == .failed {
                            self.handleFailure(item.error ?? APIError.network("playback"))
                        } else if item.status == .readyToPlay {
                            self.prepareVisualization(asset: asset, token: token)
                            self.startupTiming.itemReady = self.startupTiming.itemReady ?? (ProcessInfo.processInfo.systemUptime - self.startupClock)
                            self.isLoading = false; self.consecutiveFailures = 0
                            if self.wantsPlayback { self.player.playImmediately(atRate: Float(self.snapshot.rate)) }
                        }
                    }
                }
                bufferObservation = item.observe(\.loadedTimeRanges, options: [.new]) { [weak self] _, _ in
                    Task { @MainActor in guard let self, self.generation == token else { return }; self.resumeBufferedPlayback() }
                }
                emptyObservation = item.observe(\.isPlaybackBufferEmpty, options: [.new]) { [weak self] item, _ in
                    Task { @MainActor in guard let self, self.generation == token else { return }; if item.isPlaybackBufferEmpty && self.wantsPlayback { self.waitingForBuffer = true; self.isLoading = true; self.cancelPrefetch(reset: false) }; self.resumeBufferedPlayback() }
                }
                if wantsPlayback { player.playImmediately(atRate: Float(snapshot.rate)) }; onTrackChanged?(source.track)
                updateNowPlaying(); saveCheckpoint()
            } catch is CancellationError { }
            catch {
                guard token == generation else { return }
                handleFailure(error)
            }
        }
    }
    private func prepareVisualization(asset: AVURLAsset, token: UUID) {
        if resourceLoader?.isSegmented == true { updateSpectrumDemand(); return }
        guard visualizationTask == nil else { return }
        visualizationTask = Task { [weak self] in
            guard let tracks = try? await asset.loadTracks(withMediaType: .audio), let self, !Task.isCancelled, self.generation == token else { return }
            self.visualizationTrack = tracks.first; self.updateSpectrumDemand()
        }
    }
    static func offlinePlaybackTrack(requested: Track, metadata: Track?) -> Track {
        guard var metadata else { return requested }
        // Old downloads kept the resolved part ID in metadata under a video alias.
        // Preserve only that alias; never remap an independently selected part.
        if requested.id == "\(requested.source):\(requested.bvid):video",
           metadata.bvid == requested.bvid, metadata.source == requested.source {
            metadata.id = requested.id
        }
        return metadata
    }
    private var bufferedAhead: Double {
        guard let item = player.currentItem else { return 0 }
        let position = max(0, player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0)
        return item.loadedTimeRanges.map(\.timeRangeValue).filter { CMTimeGetSeconds($0.start) <= position + 0.05 && CMTimeGetSeconds(CMTimeRangeGetEnd($0)) >= position }
            .map { CMTimeGetSeconds(CMTimeRangeGetEnd($0)) - position }.max() ?? 0
    }
    private func resumeBufferedPlayback() {
        guard wantsPlayback, waitingForBuffer, let item = player.currentItem, item.status == .readyToPlay else { return }
        let ahead = bufferedAhead, time = max(0, player.currentTime().seconds)
        let threshold = hasPlayedCurrent ? 2 * snapshot.rate : 0.1
        let atEnd = item.duration.seconds.isFinite && time + ahead >= item.duration.seconds - 0.05
        guard ahead >= threshold || (atEnd && ahead > 0) else { return }
        waitingForBuffer = false; isLoading = false
        player.playImmediately(atRate: Float(snapshot.rate))
    }
    private func cancelPrefetch(reset: Bool) {
        prefetchGeneration = UUID()
        prefetchTask?.cancel(); prefetchTask = nil
        prefetchSourceTask?.cancel(); prefetchSourceTask = nil; prefetchSourceID = nil
        if reset { prefetchedSource = nil; attemptedPrefetch = nil }
    }
    private func queueDidChange() { cancelPrefetch(reset: true) }
    private func schedulePrefetchIfNeeded() {
        guard prefetchTask == nil, preferences.prefetchNextTrack != false, preferences.cacheLimit > 0,
              previewSnapshot == nil, isPlaying, wantsPlayback, !waitingForBuffer,
              let stablePlaybackClock, ProcessInfo.processInfo.systemUptime - stablePlaybackClock >= 2,
              snapshot.repeatMode != .track, snapshot.queue.count > 1, bufferedAhead >= 2 * snapshot.rate,
              let index = upcomingIndex(automatic: true, consume: false) else { return }
        let track = snapshot.queue[index]
        if let local = try? database.state(URL.self, key: "download-file:" + track.id), FileManager.default.fileExists(atPath: local.path) { return }
        let pair = (currentTrack?.id ?? "") + "->" + track.id
        guard attemptedPrefetch != pair else { return }
        attemptedPrefetch = pair
        let token = generation
        let prefetchToken = UUID(); prefetchGeneration = prefetchToken
        let requestedQuality = aacFallbackTrack == track.id ? AudioQuality.aac : preferences.audioQuality ?? .aac
        let sourceTask = Task(priority: .background) { [provider] in try await provider.resolve(track, quality: requestedQuality) }
        prefetchSourceTask = sourceTask; prefetchSourceID = track.id
        prefetchTask = Task(priority: .background) { [weak self] in
            guard let self else { return }
            defer { if self.prefetchGeneration == prefetchToken { self.prefetchTask = nil } }
            do {
                let source = try await sourceTask.value
                try Task.checkCancellation()
                guard token == generation, prefetchToken == prefetchGeneration else { return }
                let expiry = AudioPrefetch.expiry(for: source)
                guard expiry > Date() else { return }
                prefetchedSource = (track.id, source, expiry)
                _ = try await AudioPrefetch.fill(source: source, cache: cache)
            } catch { /* Prefetch is optional and never changes playback or history. */ }
        }
    }
    private func handleFailure(_ error: Error) {
        if let track = currentTrack, track.source == "bilibili", streamInfo?.quality != nil, streamInfo?.quality != .aac, aacFallbackTrack != track.id {
            aacFallbackTrack = track.id
            load(index: snapshot.index, position: position, refresh: true, autoplay: wantsPlayback)
            return
        }
        // Permanent/unavailable media keeps the existing queue-skip behavior.
        if wantsPlayback, ((error as? APIError)?.shouldSkipTrack != true) {
            recovery.reportFailure(); isLoading = true
            return
        }
        pause(); isLoading = false; errorMessage = error.localizedDescription; onError?(error)
        if let apiError = error as? APIError, apiError.shouldSkipTrack {
            consecutiveFailures += 1
            if consecutiveFailures < 3 { next() }
        }
    }
    /// Wall-clock poll; does not depend on media callbacks firing.
    func pollRecovery(now: Double, connectivityAvailable: Bool? = nil) {
        guard !hasShutdown, !libraryWritesSuspended, currentTrack != nil else { return }
        let time = player.currentTime().seconds
        let mediaPosition = time.isFinite && loadedTrackID != nil ? max(0, time) : position
        let offlineWaiting = !sourceIsLocal && !(connectivityAvailable ?? networkAvailable) && bufferedAhead <= 0.1
        guard let action = recovery.poll(now: now, position: mediaPosition, requested: wantsPlayback,
                                         initialLoading: !hasPlayedCurrent,
                                         excluded: seekToken != nil || systemSleeping || offlineWaiting) else { return }
        switch action {
        case .retry:
            // Preserve the resolved part, rate and intent; no next-track action.
            position = mediaPosition
            saveCheckpoint(); finishHistory(completed: false)
            load(index: snapshot.index, position: mediaPosition, refresh: true, autoplay: wantsPlayback, recovering: true)
        case .exhausted:
            pause(); stop()
            errorMessage = "播放恢复已尝试 3 次。当前歌曲和进度已保留，请检查连接后重新播放。"
            onError?(APIError.network("playback-recovery-exhausted"))
        }
    }
    private func tick() {
        if preferences.equalizer?.enabled == true {
            equalizerStatus = audioTapContext.map { Int(bb_eq_status($0.eq)) } ?? (visualizationTask != nil && visualizationTrack == nil && resourceLoader?.isSegmented != true ? -1 : 0)
        } else if equalizerStatus != 0 { equalizerStatus = 0 }
        guard loadedTrackID != nil else { return }
        let time = player.currentTime().seconds
        if time.isFinite { position = max(0, time) }
        if let item = player.currentItem, item.status == .readyToPlay, item.duration.seconds.isFinite, item.duration.seconds > 0 { self.duration = item.duration.seconds }
        let audible = player.timeControlStatus == .playing && player.rate > 0
        let clock = ProcessInfo.processInfo.systemUptime
        resumeBufferedPlayback()
        schedulePrefetchIfNeeded()
        if previewSnapshot == nil {
            _ = accumulator.update(clock: clock, audible: audible)
            if audible, let previousPosition { coveredMedia += max(0, min(position - previousPosition, 2 * snapshot.rate)) }
        }
        previousPosition = audible ? position : nil
        if clock - lastCheckpoint > 5 { saveCheckpoint(); lastCheckpoint = clock }
    }
    public func saveCheckpoint() {
        guard !libraryWritesSuspended, !hasShutdown, previewSnapshot == nil else { return }
        snapshot.position = position
        do {
            try database.saveState(snapshot, key: "playback")
            try database.saveState(preferences, key: "preferences")
            if let track = currentTrack {
                try database.saveResume(trackID: track.id, position: position, rate: snapshot.rate)
                if accumulator.audibleSeconds > 0 { try database.checkpointHistory(id: historyID, track: track, started: historyStart, listened: accumulator.audibleSeconds, completed: false) }
            }
        } catch { errorMessage = "保存播放进度失败：\(error.localizedDescription)" }
    }
    private func captureAudibleTail() {
        let time = player.currentTime().seconds
        guard time.isFinite else { return }
        if previewSnapshot == nil {
            _ = accumulator.update(clock: ProcessInfo.processInfo.systemUptime, audible: true)
            if let previousPosition { coveredMedia += max(0, min(time - previousPosition, 2 * snapshot.rate)) }
        }
        position = time; previousPosition = time
    }
    private func resetListeningSession() {
        historyID = UUID().uuidString; historyStart = Date(); accumulator = ListeningAccumulator(); coveredMedia = 0; previousPosition = nil
    }
    private func finishHistory(completed: Bool) {
        guard !libraryWritesSuspended, !hasShutdown, previewSnapshot == nil, let track = currentTrack, accumulator.audibleSeconds > 0 else { return }
        do { try database.checkpointHistory(id: historyID, track: track, started: historyStart, listened: accumulator.audibleSeconds, completed: completed) }
        catch { errorMessage = "保存听歌记录失败：\(error.localizedDescription)" }
    }
    private func applyPreferences() {
        let quality = preferences.audioQuality ?? .aac
        if configuredQuality != quality {
            configuredQuality = quality; aacFallbackTrack = nil; cancelPrefetch(reset: true)
        }
        player.volume = Float(max(0, min(1, preferences.volume))) * (preferences.normalization ? normalizationGain : 1)
        updateSpectrumDemand()
        if !libraryWritesSuspended, !hasShutdown { try? database.saveState(preferences, key: "preferences") }
        if preferences.prefetchNextTrack == false || preferences.cacheLimit == 0 { cancelPrefetch(reset: true) }
        Task { try? await cache.setLimit(preferences.cacheLimit) }
    }
    private func makeTap() -> MTAudioProcessingTap? {
        guard let context = PlaybackTapContext(pcm: pcm) else { return nil }
        context.configure(preferences.equalizer)
        var callbacks = MTAudioProcessingTapCallbacks(version: kMTAudioProcessingTapCallbacksVersion_0, clientInfo: Unmanaged.passUnretained(context).toOpaque(), init: { _, info, storage in
            guard let info else { return }
            storage.pointee = info
            _ = Unmanaged<PlaybackTapContext>.fromOpaque(info).retain()
        }, finalize: { tap in Unmanaged<PlaybackTapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release() }, prepare: { tap, _, format in
            let context = Unmanaged<PlaybackTapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
            let format = format.pointee
            let isFloat = format.mFormatID == kAudioFormatLinearPCM && format.mBitsPerChannel == 32 && (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0
            let planar = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
            let supported = isFloat && format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0
                && format.mBytesPerFrame == (planar ? 4 : 4 * format.mChannelsPerFrame)
            bb_pcm_set_format(context.pcm, isFloat)
            bb_eq_prepare(context.eq, format.mSampleRate, Int(format.mChannelsPerFrame), supported)
        }, unprepare: { _ in }, process: { tap, frames, _, list, outputFrames, outputFlags in
            let status = MTAudioProcessingTapGetSourceAudio(tap, frames, list, outputFlags, nil, outputFrames)
            guard status == noErr, outputFrames.pointee > 0 else { return }
            let context = Unmanaged<PlaybackTapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
            bb_eq_process(context.eq, UnsafeMutableRawPointer(list), Int(outputFrames.pointee))
            let first = list.pointee.mBuffers
            guard let data = first.mData else { return }
            bb_pcm_push(context.pcm, data.assumingMemoryBound(to: Float.self), Int(outputFrames.pointee), max(1, Int(first.mNumberChannels)))
        })
        var tap: MTAudioProcessingTap?
        let status: OSStatus
        if #available(macOS 27.0, *), resourceLoader?.isSegmented == true {
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: true)!
            status = MTAudioProcessingTapCreateWithPreferredFormat(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PreEffects, format.formatDescription, &tap)
        } else { status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PreEffects, &tap) }
        guard status == noErr else { return nil }
        audioTapContext = context
        return tap
    }
    private func updateSpectrumDemand() {
        let interval = visualizerVisible || preferences.floatingLyrics ? 0.25 : 1.0
        if interval != progressInterval {
            if let timeToken { player.removeTimeObserver(timeToken) }
            progressInterval = interval
            timeToken = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: interval, preferredTimescale: 1000), queue: .main) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        }
        if isPlaying, playbackActivity == nil {
            playbackActivity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "User-requested audio playback")
        } else if !isPlaying, let activity = playbackActivity {
            ProcessInfo.processInfo.endActivity(activity); playbackActivity = nil
        }
        let enabled = preferences.spectrum && visualizerVisible && isPlaying
        bb_pcm_enable(pcm, enabled)
        let wantsEQ = preferences.equalizer?.enabled == true
        let needsTap = enabled || wantsEQ
        audioTapContext?.configure(preferences.equalizer)
        if needsTap { equalizerDetach?.cancel(); equalizerDetach = nil }
        if let item = player.currentItem {
            if needsTap, item.audioMix == nil, (resourceLoader?.isSegmented == true || visualizationTrack != nil), let tap = makeTap() {
                let parameter: AVMutableAudioMixInputParameters
                if #available(macOS 27.0, *), resourceLoader?.isSegmented == true {
                    // On macOS 27 this initializer selects the documented track-mix ID.
                    parameter = AVMutableAudioMixInputParameters()
                } else if let track = visualizationTrack { parameter = AVMutableAudioMixInputParameters(track: track) }
                else { return }
                let mix = AVMutableAudioMix()
                parameter.audioTapProcessor = tap; mix.inputParameters = [parameter]; item.audioMix = mix
            } else if !needsTap, item.audioMix != nil {
                if audioTapContext?.usedEqualizer == true, isPlaying {
                    if equalizerDetach == nil {
                        let token = generation
                        equalizerDetach = Task { [weak self, weak item] in
                            do { try await Task.sleep(for: .milliseconds(160)) } catch { return }
                            guard let self, self.generation == token else { return }
                            item?.audioMix = nil; self.audioTapContext = nil; self.equalizerDetach = nil
                        }
                    }
                } else {
                    item.audioMix = nil; audioTapContext = nil
                }
            }
        }
        if enabled && spectrumTimer == nil {
            spectrumTimer = Timer.scheduledTimer(withTimeInterval: 1 / 30, repeats: true) { [weak self] _ in Task { @MainActor in self?.sampleSpectrum() } }
        } else if !enabled { spectrumTimer?.invalidate(); spectrumTimer = nil; spectrum = Array(repeating: 0, count: 48) }
    }
    private func sampleSpectrum() {
        let count = fftReal.withUnsafeMutableBufferPointer { bb_pcm_read(pcm, $0.baseAddress, 1024) }
        guard count == 1024, let fft else { return }
        vDSP_vmul(fftReal, 1, fftWindow, 1, &fftReal, 1, 1024)
        vDSP_DFT_Execute(fft, fftReal, fftImag, &fftOutReal, &fftOutImag)
        var values = spectrum
        for band in 0..<48 {
            let lower = max(1, Int(pow(512, Double(band) / 48))), upper = max(lower + 1, Int(pow(512, Double(band + 1) / 48)))
            var magnitude: Float = 0
            for bin in lower..<min(512, upper) { magnitude = max(magnitude, hypotf(fftOutReal[bin], fftOutImag[bin]) / 512) }
            let target = max(0, min(1, (20 * log10f(max(magnitude, 0.0001)) + 70) / 70))
            values[band] = values[band] * 0.65 + target * 0.35
        }
        spectrum = values
    }
    enum RemotePlaybackAction: Sendable { case play, pause, toggle, next, previous, seek(Double) }
    func handleRemoteCommand(_ action: RemotePlaybackAction) {
        // The target may have queued this task immediately before shutdown.
        guard !libraryWritesSuspended, !hasShutdown else { return }
        switch action {
        case .play: play()
        case .pause: pause()
        case .toggle: toggle()
        case .next: next()
        case .previous: previous()
        case .seek(let seconds): seek(to: seconds)
        }
    }
    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        func register(_ command: MPRemoteCommand, action: RemotePlaybackAction) {
            let target = command.addTarget { [weak self] _ in
                Task { @MainActor in self?.handleRemoteCommand(action) }; return .success
            }
            remoteTargets.append((command, target))
        }
        register(center.playCommand, action: .play)
        register(center.pauseCommand, action: .pause)
        register(center.togglePlayPauseCommand, action: .toggle)
        register(center.nextTrackCommand, action: .next)
        register(center.previousTrackCommand, action: .previous)
        let target = center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let seconds = event.positionTime
            Task { @MainActor in self?.handleRemoteCommand(.seek(seconds)) }; return .success
        }
        remoteTargets.append((center.changePlaybackPositionCommand, target))
    }
    private func updateNowPlaying() {
        guard !hasShutdown, !libraryWritesSuspended, let track = currentTrack else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: track.title, MPMediaItemPropertyArtist: track.artist,
            MPMediaItemPropertyPlaybackDuration: duration, MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? snapshot.rate : 0]
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }
}


private final class PlaybackTapContext {
    let pcm: OpaquePointer
    let eq: OpaquePointer
    private var settings: AudioEqualizerSettings?
    private(set) var usedEqualizer = false
    init?(pcm: OpaquePointer) {
        guard let eq = bb_eq_create() else { return nil }
        self.pcm = pcm; self.eq = eq
        bb_pcm_retain(pcm)
    }
    deinit { bb_eq_destroy(eq); bb_pcm_destroy(pcm) }
    func configure(_ value: AudioEqualizerSettings?) {
        guard settings != value else { return }
        settings = value
        let enabled = value?.enabled == true
        if enabled { usedEqualizer = true }
        let gains = (value ?? AudioEqualizerSettings()).normalizedGains
        gains.withUnsafeBufferPointer { bb_eq_configure(eq, enabled, $0.baseAddress) }
    }
}
