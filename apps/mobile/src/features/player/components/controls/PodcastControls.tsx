import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { useTheme } from 'react-native-paper'

import IconButton from '@/components/common/IconButton'
import useCurrentTrack from '@/hooks/player/useCurrentTrack'
import useCurrentTrackId from '@/hooks/player/useCurrentTrackId'
import { usePlaybackOptions } from '@/hooks/player/usePlaybackOptions'
import useTrackDuration from '@/hooks/player/useTrackProgress'
import { useModalStore } from '@/hooks/stores/useModalStore'
import { usePlayerChaptersSheetStore } from '@/hooks/stores/usePlayerChaptersSheetStore'
import { usePlayerQueueSheetStore } from '@/hooks/stores/usePlayerQueueSheetStore'
import { seekWithinTrack } from '@/lib/player/seek'
import { toastAndLogError } from '@/utils/error-handling'
import { formatDurationToHHMMSS } from '@/utils/time'

import {
	MainPlaybackControls,
	SecondaryPlaybackControls,
} from './PlayerControlContent'

export function PodcastControls() {
	const router = useRouter()
	const { colors } = useTheme()
	const { speed, sleepEndTime } = usePlaybackOptions()
	const track = useCurrentTrack()
	const trackId = useCurrentTrackId()
	const duration = useTrackDuration()
	const seekBy = (seconds: number) => {
		if (!trackId) return
		void seekWithinTrack(trackId, seconds, true).catch((error) =>
			toastAndLogError('跳转失败', error, 'Player.Podcast'),
		)
	}
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!sleepEndTime) return
		const interval = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(interval)
	}, [sleepEndTime])
	const remaining = sleepEndTime
		? Math.max(0, Math.ceil((sleepEndTime - now) / 1000))
		: 0
	const actions = [
		{
			icon: 'speedometer',
			accessibilityLabel: `倍速，当前 ${speed} 倍`,
			onPress: () => useModalStore.getState().open('PlaybackSpeed', undefined),
		},
		{
			icon: 'timer-outline',
			accessibilityLabel:
				remaining > 0
					? `定时关闭，剩余 ${formatDurationToHHMMSS(remaining)}`
					: '定时关闭',
			onPress: () => useModalStore.getState().open('SleepTimer', undefined),
		},
		{
			icon: 'book-open-page-variant-outline',
			accessibilityLabel: '打开章节列表',
			onPress: () => {
				void usePlayerChaptersSheetStore.getState().open()
			},
		},
		{
			icon: 'format-list-bulleted',
			accessibilityLabel: '打开播放队列',
			onPress: () => {
				void usePlayerQueueSheetStore.getState().open()
			},
		},
	]
	return (
		<View>
			<View style={{ marginTop: 24 }}>
				<MainPlaybackControls
					podcastSeek={{
						enabled: !!trackId && Number.isFinite(duration) && duration > 0,
						onSeek: seekBy,
					}}
				/>
			</View>
			<SecondaryPlaybackControls compact>
				{track?.source === 'bilibili' && track.uniqueKey === trackId && (
					<IconButton
						icon='closed-caption-outline'
						size={24}
						iconColor={colors.onSurfaceVariant}
						onPress={() => router.push('/podcast-subtitles')}
						accessibilityLabel='打开播客字幕'
					/>
				)}
				{actions.map((action) => (
					<IconButton
						key={action.icon}
						icon={action.icon}
						size={24}
						iconColor={colors.onSurfaceVariant}
						onPress={action.onPress}
						accessibilityLabel={action.accessibilityLabel}
					/>
				))}
			</SecondaryPlaybackControls>
		</View>
	)
}
