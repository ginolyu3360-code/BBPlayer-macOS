import BBPlayerCore
import SwiftUI

struct EqualizerSettingsView: View {
    @Bindable var model: AppModel
    private var current: AudioEqualizerSettings { model.player.preferences.equalizer ?? AudioEqualizerSettings() }
    var body: some View {
        Section("均衡器") {
            Toggle("启用十段均衡器", isOn: Binding(get: { current.enabled }, set: { value in
                var settings = current; settings.enabled = value; model.player.preferences.equalizer = settings
            }))
            if current.enabled && model.player.equalizerStatus < 0 {
                Text("当前音频格式不支持均衡器，仍可原样播放。").font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup("预设与自定义增益") {
                HStack {
                    ForEach(AudioEqualizerSettings.Preset.allCases, id: \.self) { preset in
                        Button(["flat":"平直","bass":"低音","voice":"人声","bright":"明亮"][preset.rawValue] ?? preset.rawValue) {
                            var settings = current; settings.gains = preset.gains; model.player.preferences.equalizer = settings
                        }
                    }
                }
                ForEach(Array(AudioEqualizerSettings.frequencies.enumerated()), id: \.offset) { index, frequency in
                    HStack {
                        Text("\(frequency) Hz").frame(width: 75, alignment: .leading)
                        Slider(value: Binding(get: { current.normalizedGains[index] }, set: { value in
                            var settings = current; settings.gains = settings.normalizedGains; settings.gains[index] = value
                            model.player.preferences.equalizer = settings
                        }), in: -12...12, step: 0.5).accessibilityLabel("\(frequency) 赫兹增益")
                        Text(current.normalizedGains[index], format: .number.precision(.fractionLength(1))).monospacedDigit().frame(width: 45, alignment: .trailing)
                        Text("dB")
                    }
                }
            }
        }
    }
}
