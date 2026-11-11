import AppKit
import BBPlayerCore
import CoreImage.CIFilterBuiltins
import Observation
import SwiftUI

@MainActor @Observable final class LANSyncController {
    @ObservationIgnored private weak var model: AppModel?
    @ObservationIgnored private var server: LANSyncServer?
    @ObservationIgnored private var generation = UUID()
    var enabled = false
    var status = "尚未启用"
    var endpoints: [String] = []
    var endpoint = ""
    var invitation = ""
    var peers: [LANPeer] = []
    var conflicts: [SyncConflict] = []
    init(model: AppModel) { self.model = model }
    func enable(allowInteraction: Bool = true) {
        guard let model, !model.isRestoringLibrary else { return }
        do {
            guard let engine = model.sync else { throw APIError.unavailable("资料库恢复后同步已暂停。请先确认以当前 Mac 数据重新建立同步。") }
            let identity = try LANIdentity.loadOrCreate(allowInteraction: allowInteraction), pairing = try LANPairingStore.persistent(allowInteraction: allowInteraction)
            let next = LANSyncServer(identity: identity, pairing: pairing, library: model.database, engine: engine, onChange: { [weak self] in Task { @MainActor in self?.refreshLibrary() } })
            let generation = UUID(); self.generation = generation
            try next.start { [weak self] port, error in Task { @MainActor in
                guard let self, self.enabled, self.generation == generation else { return }
                if let port {
                    self.endpoints = LANNetwork.endpoints(port: port)
                    self.endpoint = self.endpoints.first ?? ""
                    self.status = self.endpoint.isEmpty ? "已启动，但未找到局域网地址；请连接 Wi-Fi 或热点" : "等待已配对设备连接"
                } else if let error { self.status = error }
            } }
            server?.stop(); server = next; enabled = true
            UserDefaults.standard.set(true, forKey: "lan-sync-enabled")
            refreshLibrary()
        } catch { status = error.localizedDescription; enabled = false }
    }
    func stop() {
        generation = UUID()
        server?.stop(); server = nil; enabled = false; invitation = ""; endpoints = []; endpoint = ""; status = "已停止局域网连接"
        UserDefaults.standard.set(false, forKey: "lan-sync-enabled")
    }
    func pair() {
        guard let server, !endpoint.isEmpty else { return }
        do {
            let secret = try server.pairing.begin()
            let payload: [String: Any] = ["version": 1, "serverID": server.identity.deviceID, "endpoint": endpoint, "pin": server.identity.fingerprint, "secret": secret]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            let code = data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            invitation = "bbplayer-personal://settings/lan-sync?pair=" + code
            status = "配对码 5 分钟内有效，只能使用一次"
        } catch { status = error.localizedDescription }
    }
    func revoke(_ peer: LANPeer) {
        do { try server?.pairing.revoke(peer.id); peers = server?.pairing.list() ?? []; status = "该设备的连接权限已撤销" }
        catch { status = error.localizedDescription }
    }
    func rebaseline() {
        guard let model else { return }
        do {
            stop()
            try LANPairingStore.persistent().revokeAll()
            model.sync = try SyncEngine.rebaseline(library: model.database)
            enable()
        } catch { status = error.localizedDescription }
    }
    func resolve(_ conflict: SyncConflict, variant: SyncOperation) {
        do { try model?.sync?.resolve(conflict, choosing: variant.id); refreshLibrary() }
        catch { status = error.localizedDescription }
    }
    func refreshLibrary() {
        guard let model, !model.isRestoringLibrary else { return }
        peers = server?.pairing.list() ?? []
        conflicts = (try? model.sync?.conflicts()) ?? []
        model.localPlaylists = (try? model.database.playlists()) ?? []
        if model.openedPlaylist != nil { model.loadSection() }
    }
}

struct LANSyncSettingsView: View {
    @Bindable var model: AppModel
    @State private var confirmBaseline = false
    var body: some View {
        @Bindable var connection = model.lan
        Section("设备间同步") {
            Toggle("允许已配对设备通过局域网连接", isOn: Binding(get: { connection.enabled }, set: { $0 ? connection.enable() : connection.stop() }))
            Text("仅同步本地歌单中的网络歌曲、应用内喜欢和手动选择的歌词。原始音频、下载、历史、播放进度、设置和登录信息保留在各设备。").font(.caption).foregroundStyle(.secondary)
            Text(connection.status).font(.callout)
            if connection.enabled {
                if connection.endpoints.count > 1 { Picker("连接地址", selection: $connection.endpoint) { ForEach(connection.endpoints, id: \.self) { Text($0).tag($0) } }.onChange(of: connection.endpoint) { _, _ in connection.invitation = "" } }
                Button("生成新配对码") { connection.pair() }.disabled(connection.endpoint.isEmpty)
                if !connection.invitation.isEmpty {
                    if let image = qr(connection.invitation) { Image(nsImage: image).interpolation(.none).resizable().frame(width: 220, height: 220).accessibilityLabel("设备配对二维码") }
                    Text("用手机系统相机扫描；也可将下面的配对内容粘贴到手机的设备同步页面。请只交给自己的设备。").font(.caption)
                    Text(connection.invitation).font(.system(.caption, design: .monospaced)).textSelection(.enabled).lineLimit(3)
                    Button("复制配对内容") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(connection.invitation, forType: .string) }
                }
                ForEach(connection.peers) { peer in HStack { Text("已配对设备 · " + peer.pairedAt.formatted(date: .abbreviated, time: .shortened)); Spacer(); Button("撤销连接") { connection.revoke(peer) } } }
                Button("刷新连接与冲突") { connection.refreshLibrary() }
            }
            ForEach(Array(connection.conflicts.enumerated()), id: \.offset) { _, conflict in
                VStack(alignment: .leading, spacing: 8) {
                    Text("需要选择：" + fieldName(conflict.field)).fontWeight(.medium)
                    ForEach(conflict.variants, id: \.id) { variant in Button(description(variant)) { connection.resolve(conflict, variant: variant) } }
                }.padding(.vertical, 6)
            }
            Button("以当前 Mac 资料库重新建立同步") { confirmBaseline = true }
                .alert("重新建立设备同步？", isPresented: $confirmBaseline) {
                    Button("取消", role: .cancel) {}
                    Button("确认重新建立") { connection.rebaseline() }
                } message: { Text("将撤销已有配对，以当前显示的资料库为新基准。手机需重新配对；未处理冲突会采用当前显示版本。音频文件和历史不受影响。") }
        }
    }
    private func fieldName(_ field: String) -> String {
        if field.hasPrefix("entry-delete/edit:") { return "歌曲删除与修改" }
        if field.hasPrefix("entry:") { return "歌单歌曲" }
        return ["title":"歌单标题", "order":"歌曲顺序", "source":"播放来源", "liked":"喜欢状态", "lyrics":"歌词", "deleted":"歌单删除", "delete/edit":"歌单删除与修改"][field] ?? "资料修改"
    }
    private func description(_ operation: SyncOperation) -> String {
        if let text = operation.value.text { return "保留标题：" + text }
        if let source = operation.value.source { return "使用来源：" + source.track.title }
        if let lyrics = operation.value.lyrics { return "保留这份歌词（\(lyrics.lines.count) 行，偏移 \(lyrics.offset) 秒）" }
        if let order = operation.value.order { return "采用此顺序（\(order.count) 首）· " + String(operation.id.suffix(6)) }
        if let flag = operation.value.flag { return operation.field == "deleted" ? (flag ? "确认删除歌单" : "保留歌单") : (flag ? "保留这项修改" : "确认移除") }
        return "选择这项修改"
    }
    private func qr(_ value: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(value.utf8)
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }
}
