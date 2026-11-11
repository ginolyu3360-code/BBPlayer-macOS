import { WavySlider } from 'expo-wavy-slider'
import { View } from 'react-native'
import { Button, List, Switch, Text, useTheme } from 'react-native-paper'

import useAppStore from '@/hooks/stores/useAppStore'
import {
	lyricPresets,
	normalizedLyricPresentation,
} from '@/lib/config/lyricPresentation'
import type { LyricPresentation } from '@/lib/config/lyricPresentation'

export default function LyricPresentationSettings() {
	const value = useAppStore((state) => state.settings.lyricPresentation)
	const setSettings = useAppStore((state) => state.setSettings)
	const settings = normalizedLyricPresentation(value),
		colors = useTheme().colors
	const save = (change: Partial<LyricPresentation>) =>
		setSettings({ lyricPresentation: { ...settings, ...change } })
	return (
		<List.Accordion title='歌词外观与实时预览'>
			<View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
				<Button
					onPress={() => setSettings({ lyricPresentation: lyricPresets.clear })}
				>
					清晰
				</Button>
				<Button
					onPress={() =>
						setSettings({ lyricPresentation: lyricPresets.compact })
					}
				>
					紧凑
				</Button>
				<Button
					onPress={() => setSettings({ lyricPresentation: lyricPresets.large })}
				>
					大字
				</Button>
				<Button onPress={() => setSettings({ lyricPresentation: undefined })}>
					恢复默认
				</Button>
			</View>
			<Text>字号 · {settings.fontSize.toFixed(0)}</Text>
			<WavySlider
				value={settings.fontSize}
				min={16}
				max={40}
				waveHeight={0}
				style={{ height: 44 }}
				onValueChange={(fontSize) => save({ fontSize: Math.round(fontSize) })}
			/>
			<Text>行间距 · {settings.spacing.toFixed(0)}</Text>
			<WavySlider
				value={settings.spacing}
				min={8}
				max={48}
				waveHeight={0}
				style={{ height: 44 }}
				onValueChange={(spacing) => save({ spacing: Math.round(spacing) })}
			/>
			<Text>翻译字号比例 · {settings.translationRatio.toFixed(2)}</Text>
			<WavySlider
				value={settings.translationRatio}
				min={0.4}
				max={1}
				waveHeight={0}
				style={{ height: 44 }}
				onValueChange={(translationRatio) =>
					save({ translationRatio: Math.round(translationRatio * 20) / 20 })
				}
			/>
			<List.Item
				title='强调高亮'
				right={() => (
					<Switch
						value={settings.accent}
						onValueChange={(accent) => save({ accent })}
					/>
				)}
			/>
			<List.Item
				title='歌词边缘渐隐'
				right={() => (
					<Switch
						value={settings.edgeMask}
						onValueChange={(edgeMask) => save({ edgeMask })}
					/>
				)}
			/>
			<View style={{ paddingVertical: settings.spacing / 2 }}>
				<Text
					style={{
						fontSize: settings.fontSize,
						lineHeight: settings.fontSize * 1.4,
						color: settings.accent ? colors.primary : colors.onSurface,
					}}
				>
					这一句歌词正在播放
				</Text>
				<Text
					style={{
						fontSize: settings.fontSize * settings.translationRatio,
						lineHeight: settings.fontSize * settings.translationRatio * 1.4,
					}}
				>
					A live preview of lyric appearance
				</Text>
			</View>
		</List.Accordion>
	)
}
