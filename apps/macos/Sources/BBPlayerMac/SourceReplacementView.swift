import BBPlayerCore
import SwiftUI

struct SourceReplacementView: View {
    @Bindable var model: AppModel
    let songID: UUID
    let original: Track
    @Environment(\.dismiss) private var dismiss
    @State private var current: Track?
    @State private var searching = false
    @State private var video: Track?
    @State private var partRequest = 0
    @State private var parts: [Track] = []
    @State private var candidate: Track?
    @State private var loadingParts = false
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("替换音乐来源").font(.title2.bold())
            Text("保留同一首歌的歌单位置和累计收听记录。历史详情仍显示当时实际播放的来源。")
            Text("当前队列继续使用原来源；旧来源的下载、歌词和播放进度单独保留，不会套用到新来源。")
                .font(.callout).foregroundStyle(.secondary)
            GroupBox("当前来源") { sourceLabel(current ?? original) }
            HStack {
                Button("搜索或粘贴 B 站链接 / BV 号…") { searching = true }.disabled(saving)
                if loadingParts { ProgressView().controlSize(.small); Text("正在读取分 P…").font(.caption) }
            }
            if parts.count > 1 {
                Text("选择准确的分 P").font(.headline)
                List(parts) { part in
                    HStack {
                        Text(part.title).lineLimit(2)
                        Spacer()
                        Text(MD.time(part.duration)).font(.caption)
                        Button(candidate?.id == part.id ? "已选择" : "选择") { candidate = part }
                    }
                }.frame(height: 130).disabled(saving)
            }
            if let candidate {
                GroupBox("确认新来源") {
                    HStack {
                        sourceLabel(candidate)
                        Button("试听") { model.player.preview(candidate) }.disabled(saving)
                    }
                }
            }
            if let errorMessage { Text(errorMessage).foregroundStyle(.red).textSelection(.enabled) }
            Spacer(minLength: 0)
            HStack {
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
                Spacer()
                if saving { ProgressView().controlSize(.small); Text("正在保护并保存资料…").font(.caption) }
                Button("确认替换") { save() }.buttonStyle(.borderedProminent)
                    .disabled(candidate == nil || loadingParts || saving || candidate?.id == current?.id)
            }
        }.padding(24).frame(width: 690, height: 600)
            .interactiveDismissDisabled(saving)
            .sheet(isPresented: $searching, onDismiss: { model.player.endPreview() }) {
                let track = current ?? original
                ImportSearchView(api: model.api, song: ExternalSong(id: songID.uuidString, title: track.title, artist: track.artist, duration: track.duration, source: track.source)) { selected in
                    candidate = nil; parts = []; errorMessage = nil; video = selected; partRequest += 1; searching = false
                } preview: { model.player.preview($0) }
            }
            .task {
                do { current = try model.database.activeSource(songID: songID) }
                catch { errorMessage = "无法读取当前来源：" + error.localizedDescription }
            }
            .task(id: partRequest) { await loadParts() }
            .onDisappear { model.player.endPreview() }
    }

    private func sourceLabel(_ track: Track) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(track.title).font(.headline).lineLimit(3)
            Text(track.artist).font(.callout).foregroundStyle(.secondary)
            Text("\(track.bvid) · 分 P \(track.cid.map(String.init) ?? "待选择") · \(MD.time(track.duration))")
                .font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(5)
    }

    private func loadParts() async {
        guard let video else { return }
        loadingParts = true
        do {
            let resolved = try await model.api.pages(video)
            try Task.checkCancellation()
            guard !resolved.isEmpty else { throw APIError.unavailable("该视频没有可用的分 P，请选择其他来源。") }
            parts = resolved
            candidate = resolved.count == 1 ? video.withPage(cid: resolved[0].cid!, title: nil, duration: resolved[0].duration) : nil
            loadingParts = false
        } catch {
            guard !Task.isCancelled else { return }
            loadingParts = false
            errorMessage = "读取来源失败：" + error.localizedDescription
        }
    }

    private func save() {
        guard let candidate, !saving else { return }
        saving = true; errorMessage = nil
        // Finish a user-requested audition before committing; do not enqueue the candidate.
        model.player.endPreview()
        let database = model.database
        Task {
            do {
                try await Task.detached { try database.replaceSource(songID: songID, with: candidate) }.value
                model.summary = try? database.summary()
                model.loadSection()
                model.message = "已替换音乐来源，歌单位置和累计记录已保留。当前播放队列保持原来源。"
                saving = false
                dismiss()
            } catch {
                saving = false
                switch error as? SongSourceReplacementError {
                case .candidateAlreadyInLibrary:
                    errorMessage = "该来源已属于资料库中的另一首歌，不能自动合并。请选择其他来源；如要保留两个版本，可直接将它加入歌单。"
                case .unknownSong:
                    errorMessage = "这首歌已不在资料库中。请关闭窗口，刷新歌单后重试。"
                default:
                    errorMessage = "替换未保存，原来源和歌单保持不变。请检查资料目录的写入权限及可用空间后重试。\n" + error.localizedDescription
                }
            }
        }
    }
}
