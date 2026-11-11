import { Orpheus } from '@bbplayer/orpheus'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { RadioButton, Text } from 'react-native-paper'

import toast from '@/utils/toast'

export default function AudioQualitySettings() {
	const [quality, setQuality] = useState(Orpheus.audioQuality)
	const [info, setInfo] = useState({
		mime: '',
		codec: '',
		sampleRate: -1,
		bitrate: -1,
		channels: -1,
		fallback: false,
	})
	useEffect(() => {
		const timer = setInterval(
			() =>
				void Orpheus.getStreamInfo()
					.then(setInfo)
					.catch(() => {}),
			1000,
		)
		return () => clearInterval(timer)
	}, [])
	return (
		<View>
			<Text variant='titleMedium'>网络音轨</Text>
			<RadioButton.Group
				value={quality}
				onValueChange={(value) => {
					if (value !== 'aac' && value !== 'lossless' && value !== 'dolby')
						return
					try {
						Orpheus.audioQuality = value
						setQuality(value)
					} catch {
						toast.error('无法保存音轨设置')
					}
				}}
			>
				<RadioButton.Item
					label='最高可用常规 AAC（默认）'
					value='aac'
				/>
				<RadioButton.Item
					label='优先无损（来源和解码器支持时）'
					value='lossless'
				/>
				<RadioButton.Item
					label='优先 Dolby 音轨（来源和解码器支持时）'
					value='dolby'
				/>
			</RadioButton.Group>
			<Text>
				在下次加入或加载网络来源时采用此选择。不能提供或解码时回退
				AAC；不改变已有下载，也不转码。
			</Text>
			{info.mime !== '' && (
				<Text>
					当前输入：{info.codec || info.mime}
					{info.sampleRate > 0 ? ' · ' + info.sampleRate / 1000 + ' kHz' : ''}
					{info.bitrate > 0
						? ' · ' + Math.round(info.bitrate / 1000) + ' kbps'
						: ''}
					{info.channels > 0 ? ' · ' + info.channels + ' 声道' : ''}
				</Text>
			)}
			{info.fallback && (
				<Text>当前使用 AAC：所选规格未提供、未受支持或解码失败。</Text>
			)}
		</View>
	)
}
