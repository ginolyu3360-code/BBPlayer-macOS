import BBPlayerCore
import SwiftUI

struct LocalMusicView: View {
    @Bindable var model: AppModel
    @State private var tracks: [Track] = []
    @State private var query = ""
    @State private var editing: Track?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Button("选择本地音频…") { model.chooseLocalAudio() }.buttonStyle(.borderedProminent)
                TextField("歌名或歌手", text: $query)
            }
            Text("引用原文件，不复制音频。文件移动或权限失效时，可从右键菜单重新关联；不会删除歌曲资料。")
                .font(.caption).foregroundStyle(.secondary)
            List(Array(tracks.filter { query.isEmpty || ($0.title + " " + $0.artist).localizedCaseInsensitiveContains(query) }.enumerated()), id: \.element.id) { item in
                HStack { TrackRow(model: model, track: item.element, index: item.offset + 1); Button("编辑资料") { editing = item.element } }
            }
        }.padding(24)
            .sheet(item: $editing) { track in LocalAudioMetadataEditor(model: model, track: track) }
            .task(id: model.localFilesRevision) { do { tracks = try model.database.localTracks() } catch { model.message = error.localizedDescription } }
    }
}

private struct LocalAudioMetadataEditor: View {
    @Bindable var model: AppModel
    let track: Track
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var artist: String
    init(model: AppModel, track: Track) { self.model = model; self.track = track; _title = State(initialValue: track.title); _artist = State(initialValue: track.artist) }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("编辑歌曲资料").font(.headline)
            TextField("歌名", text: $title)
            TextField("歌手", text: $artist)
            Text("只修改资料库，不改写音频标签或原文件。").font(.caption).foregroundStyle(.secondary)
            HStack { Button("取消") { dismiss() }; Spacer(); Button("保存") { var edited = track; edited.title = title.trimmingCharacters(in: .whitespacesAndNewlines); edited.artist = artist; if model.editLocalAudio(edited) { dismiss() } }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        }.padding(24).frame(width: 450).disabled(model.isRestoringLibrary)
    }
}
