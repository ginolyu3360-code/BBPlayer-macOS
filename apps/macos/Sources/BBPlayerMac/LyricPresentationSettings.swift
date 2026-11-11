import BBPlayerCore
import SwiftUI

struct LyricPresentationSettings: View {
    @Bindable var model: AppModel
    private var settings: LyricPresentation { (model.player.preferences.lyricPresentation ?? LyricPresentation()).normalized }
    private func binding<T>(_ key: WritableKeyPath<LyricPresentation, T>) -> Binding<T> {
        Binding(get: { settings[keyPath: key] }, set: { value in var next = settings; next[keyPath: key] = value; model.player.preferences.lyricPresentation = next })
    }
    var body: some View {
        DisclosureGroup("歌词外观与实时预览") {
            HStack {
                Button("清晰") { model.player.preferences.lyricPresentation = LyricPresentation() }
                Button("紧凑") { model.player.preferences.lyricPresentation = .compact }
                Button("大字") { model.player.preferences.lyricPresentation = .large }
                Spacer()
                Button("恢复默认") { model.player.preferences.lyricPresentation = nil }
            }
            LabeledContent("字号") { Slider(value: binding(\.fontSize), in: 16...40, step: 1); Text(settings.fontSize, format: .number).frame(width: 35) }
            LabeledContent("行间距") { Slider(value: binding(\.spacing), in: 8...48, step: 1); Text(settings.spacing, format: .number).frame(width: 35) }
            LabeledContent("翻译字号比例") { Slider(value: binding(\.translationRatio), in: 0.4...1, step: 0.05) }
            Toggle("强调逐字高亮", isOn: binding(\.accent))
            Toggle("歌词列表边缘渐隐", isOn: binding(\.edgeMask))
            VStack(alignment: .leading, spacing: settings.spacing / 3) {
                Text("这一句歌词正在播放").font(.system(size: settings.fontSize, weight: .bold)).foregroundStyle(settings.accent ? MD.accent : .primary)
                Text("A live preview of lyric appearance").font(.system(size: settings.fontSize * settings.translationRatio)).foregroundStyle(.secondary)
            }.padding(.vertical, 12)
        }
    }
}
