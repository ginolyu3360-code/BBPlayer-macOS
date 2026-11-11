import { Orpheus } from '@bbplayer/orpheus'
import { WavySlider } from 'expo-wavy-slider'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Button, List, Switch, Text } from 'react-native-paper'

import toast from '@/utils/toast'

const frequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const presets = [
	{ name: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
	{ name: '低音', gains: [5, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
	{ name: '人声', gains: [-3, -2, -1, 0, 1, 2, 3, 2, 0, -1] },
	{ name: '明亮', gains: [0, 0, 0, 0, 0, 1, 1, 2, 3, 4] },
]
export default function EqualizerSettings() {
	const [settings, setSettings] = useState(() => Orpheus.getEqualizer())
	const [expanded, setExpanded] = useState(false)
	const save = (enabled: boolean, gains: number[]) => {
		try {
			Orpheus.setEqualizer(enabled, gains)
			setSettings({ enabled, gains, status: Orpheus.getEqualizer().status })
		} catch {
			toast.error('无法保存均衡器设置，请重试')
		}
	}
	useEffect(() => {
		if (!settings.enabled) return
		const timer = setInterval(
			() =>
				setSettings((current) => ({
					...current,
					status: Orpheus.getEqualizer().status,
				})),
			1000,
		)
		return () => clearInterval(timer)
	}, [settings.enabled])
	return (
		<View>
			<List.Item
				title='十段均衡器'
				description='默认关闭，设置只保存在此设备'
				right={() => (
					<Switch
						value={settings.enabled}
						onValueChange={(value) => save(value, settings.gains)}
					/>
				)}
			/>
			{settings.enabled && settings.status !== 1 && (
				<Text>
					{settings.status < 0
						? '当前音频格式不支持均衡器，仍可原样播放'
						: '等待播放器输出可处理的音频'}
				</Text>
			)}
			<List.Accordion
				title='预设与自定义增益'
				expanded={expanded}
				onPress={() => setExpanded(!expanded)}
			>
				<View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
					{presets.map((preset) => (
						<Button
							key={preset.name}
							onPress={() => save(settings.enabled, preset.gains)}
						>
							{preset.name}
						</Button>
					))}
				</View>
				{frequencies.map((frequency, index) => (
					<View
						key={frequency}
						style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
					>
						<Text style={{ width: 70 }}>{frequency} Hz</Text>
						<WavySlider
							value={settings.gains[index] ?? 0}
							min={-12}
							max={12}
							waveHeight={0}
							style={{ flex: 1, height: 40 }}
							onValueChangeFinished={(value) => {
								const gains = [...settings.gains]
								gains[index] = Math.round(value * 2) / 2
								save(settings.enabled, gains)
							}}
						/>
						<Text style={{ width: 58, textAlign: 'right' }}>
							{(settings.gains[index] ?? 0).toFixed(1)} dB
						</Text>
					</View>
				))}
			</List.Accordion>
		</View>
	)
}
