import AppKit
import SwiftUI

/// Uses the main playback engine; closing this panel never changes playback.
@MainActor final class CompactPlayerController: NSObject, NSWindowDelegate {
    private weak var model: AppModel?
    private var panel: NSPanel?
    private let frameKey = "compact-player-frame-v1"
    private let pinKey = "compact-player-pin-v1"
    init(model: AppModel) {
        self.model = model
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(screenChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }
    func toggle() {
        if let panel, panel.isVisible { panel.close(); return }
        guard let model else { return }
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 160), styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
        window.title = "BBPlayer · 迷你播放器"
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.delegate = self
        let pinned = UserDefaults.standard.bool(forKey: pinKey)
        window.level = pinned ? .floating : .normal
        window.isFloatingPanel = pinned
        window.contentViewController = NSHostingController(rootView: CompactPlayerView(model: model, pinned: pinned, setPinned: { [weak self] in self?.setPinned($0) }, setExpanded: { [weak self] in self?.resize(expanded: $0) }))
        panel = window
        window.center()
        if let stored = UserDefaults.standard.string(forKey: frameKey) {
            let frame = NSRectFromString(stored)
            if !frame.isEmpty, frame.minX.isFinite, frame.maxY.isFinite {
                window.setFrameTopLeftPoint(NSPoint(x: frame.minX, y: frame.maxY))
            }
        }
        screenChanged()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    private func setPinned(_ value: Bool) {
        UserDefaults.standard.set(value, forKey: pinKey)
        panel?.isFloatingPanel = value
        panel?.level = value ? .floating : .normal
    }
    private func resize(expanded: Bool) {
        guard let panel else { return }
        let top = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
        panel.setContentSize(NSSize(width: 360, height: expanded ? 380 : 160))
        panel.setFrameTopLeftPoint(top)
        screenChanged()
    }
    @objc private func screenChanged() {
        guard let panel else { return }
        let screen = NSScreen.screens.max {
            let a = $0.visibleFrame.intersection(panel.frame), b = $1.visibleFrame.intersection(panel.frame)
            return a.width * a.height < b.width * b.height
        }
        let visible = screen?.visibleFrame.intersection(panel.frame)
        guard let bounds = ((visible?.isEmpty == false ? screen : NSScreen.main) ?? screen)?.visibleFrame else { return }
        let frame = panel.frame
        let x = min(max(frame.minX, bounds.minX), max(bounds.minX, bounds.maxX - frame.width))
        let y = min(max(frame.minY, bounds.minY), max(bounds.minY, bounds.maxY - frame.height))
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
    func windowWillClose(_ notification: Notification) {
        guard let panel else { return }
        UserDefaults.standard.set(NSStringFromRect(panel.frame), forKey: frameKey)
        panel.contentViewController = nil
        self.panel = nil
    }
    func close() { panel?.close() }
}

private struct CompactPlayerView: View {
    @Bindable var model: AppModel
    @State var pinned: Bool
    let setPinned: (Bool) -> Void
    let setExpanded: (Bool) -> Void
    @State private var expanded = false
    @State private var scrubbing = false
    @State private var scrubPosition = 0.0

    var body: some View {
        let player = model.player
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(player.currentTrack?.title ?? "播放队列为空").font(.headline).lineLimit(1)
                    Text(player.currentTrack?.artist ?? "从主窗口选择歌曲").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Button { pinned.toggle(); setPinned(pinned) } label: { Image(systemName: pinned ? "pin.fill" : "pin") }
                    .accessibilityLabel(pinned ? "取消置顶" : "窗口置顶")
                Button { model.reopenWindow?() } label: { Image(systemName: "macwindow") }.accessibilityLabel("打开主窗口")
            }
            HStack(spacing: 7) {
                Text(time(scrubbing ? scrubPosition : player.position)).monospacedDigit()
                Slider(value: Binding(get: { min(max(0, scrubbing ? scrubPosition : player.position), max(1, player.duration)) }, set: { scrubPosition = $0 }), in: 0...max(1, player.duration), onEditingChanged: { editing in
                    if editing { scrubPosition = player.position }
                    else if scrubbing { player.seek(to: scrubPosition) }
                    scrubbing = editing
                }).accessibilityLabel("播放进度").disabled(player.duration <= 0)
                Text(time(player.duration)).monospacedDigit()
            }.font(.caption)
            HStack {
                Button { player.previous() } label: { Image(systemName: "backward.end.fill") }.accessibilityLabel("上一首")
                Button { player.toggle() } label: { Image(systemName: player.isPlaybackRequested ? "pause.fill" : "play.fill") }
                    .accessibilityLabel(player.isPlaybackRequested ? "暂停" : "播放")
                Button { player.next() } label: { Image(systemName: "forward.end.fill") }.accessibilityLabel("下一首")
                Spacer()
                Image(systemName: "speaker.wave.2")
                Slider(value: $model.player.preferences.volume, in: 0...1).frame(width: 80).accessibilityLabel("音量")
                Button { expanded.toggle(); setExpanded(expanded) } label: { Image(systemName: "list.bullet") }
                    .accessibilityLabel(expanded ? "收起播放队列" : "展开播放队列")
            }.buttonStyle(.borderless)
            if expanded {
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 5) {
                            ForEach(Array(player.snapshot.queue.enumerated()), id: \.offset) { index, track in
                                Button { player.skip(to: index) } label: {
                                    HStack {
                                        Image(systemName: index == player.snapshot.index ? "speaker.wave.2" : "music.note").frame(width: 16)
                                        Text(track.title).lineLimit(1)
                                        Spacer()
                                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.buttonStyle(.plain).padding(.vertical, 3).id(index)
                            }
                        }
                    }
                    .onAppear { proxy.scrollTo(player.snapshot.index, anchor: .center) }
                    .onChange(of: player.snapshot.index) { _, index in proxy.scrollTo(index, anchor: .center) }
                }
            }
        }
        .padding(13).frame(width: 360, height: expanded ? 380 : 160, alignment: .topLeading)
        .disabled(model.isRestoringLibrary)
    }
    private func time(_ value: Double) -> String {
        let seconds = value.isFinite ? Int(min(max(0, value), 360_000)) : 0
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
