import AppKit
import BBPlayerCore
import SwiftUI

struct BackupSettingsView: View {
    @Bindable var model: AppModel
    @State private var working = false
    @State private var restoring = false
    @State private var review = false
    @State private var prepared: PreparedLibraryRestore?
    @State private var status: String?
    @State private var mergeMode = false
    @State private var preferImported = false
    @State private var conflictCount = 0

    var body: some View {
        Section("资料备份与恢复") {
            Text("每天首次启动时，资料有变化才自动备份，保留最近 10 份，并保留最新的恢复前保护备份。手动导出不会自动清理。")
                .font(.callout).foregroundStyle(.secondary)
            Text("包含歌单顺序、歌曲与来源身份、收听历史、歌词和播放偏好。音频、下载、缓存、登录、队列、进度、同步配对及装扮素材不在备份中。封面保留安全的网络地址。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("导出资料备份…") { export() }
                Button("选择备份并检查…") { inspect() }
                Button("合并导入…") { inspect(merge: true) }
                Button("打开自动备份文件夹") {
                    do {
                        try FileManager.default.createDirectory(at: model.backups.directory, withIntermediateDirectories: true)
                        NSWorkspace.shared.open(model.backups.directory)
                    } catch { status = error.localizedDescription }
                }
            }.disabled(working)
            if working && !restoring { ProgressView("正在检查资料…") }
            if let status { Text(status).font(.callout).textSelection(.enabled) }
            Text("合并按歌曲身份和历史事件去重，保留当前歌单顺序并追加新歌曲；原备份文件保持不变。恢复后同步保持暂停。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .alert(mergeMode ? "合并资料库？" : "完整恢复资料库？", isPresented: $review) {
            Button("取消", role: .cancel) { prepared = nil }
            Button(mergeMode ? "保留当前冲突版本并合并" : "保护当前资料并恢复", role: .destructive) { preferImported = false; restore() }
            if mergeMode { Button("使用备份冲突版本并合并", role: .destructive) { preferImported = true; restore() } }
        } message: {
            if let prepared {
                Text(mergeMode ? "发现 \(conflictCount) 项相同身份的数据差异。请选择采用哪一版本；历史累计取较大值，当前歌单顺序保留。合并会暂停播放、清空队列与进度并保留恢复前保护副本。原备份仍可再次导入。" : "已检查 \(prepared.playlistCount) 个歌单、\(prepared.songCount) 首歌曲和 \(prepared.historyCount) 条历史。此操作将替换当前资料库，停止播放和下载，并清空队列及进度。现有音频文件和登录保留。恢复前会另存保护备份。")
            }
        }
        .sheet(isPresented: $restoring) {
            VStack(spacing: 18) {
                ProgressView()
                Text("正在保护并恢复资料库").font(.headline)
                Text("请保持应用打开。播放和后台修改已暂停。")
            }.padding(32).frame(width: 430).interactiveDismissDisabled()
        }
    }

    private func export() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "BBPlayer-\(ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")).bbbackup"
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        working = true; status = nil
        let backups = model.backups
        Task {
            do {
                try await Task.detached {
                    let access = destination.startAccessingSecurityScopedResource()
                    defer { if access { destination.stopAccessingSecurityScopedResource() } }
                    try backups.export(to: destination)
                }.value
                status = "资料备份已导出。请自行妥善保管，其中包含歌单与收听记录。"
            } catch { status = "导出失败：" + error.localizedDescription }
            working = false
        }
    }

    private func inspect(merge: Bool = false) {
        mergeMode = merge
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let file = panel.url else { return }
        working = true; status = nil
        let backups = model.backups
        Task {
            do {
                prepared = try await Task.detached {
                    let access = file.startAccessingSecurityScopedResource()
                    defer { if access { file.stopAccessingSecurityScopedResource() } }
                    return try backups.prepareRestore(from: file)
                }.value
                if merge, let prepared { conflictCount = try backups.mergeConflictCount(prepared) }
                review = true
            } catch { status = "备份检查失败：" + error.localizedDescription }
            working = false
        }
    }

    private func restore() {
        guard let prepared else { return }
        working = true; restoring = true
        Task {
            do {
                try await model.restoreLibrary(prepared, merge: mergeMode, preferImportedMetadata: preferImported)
                status = "资料已恢复。播放保持停止，同步保持暂停。恢复前保护备份保存在自动备份文件夹。"
            } catch { status = "恢复失败，原资料库保留：" + error.localizedDescription }
            self.prepared = nil; restoring = false; working = false
        }
    }
}
