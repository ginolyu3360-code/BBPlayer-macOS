import { Orpheus } from '@bbplayer/orpheus'
import { useQuery } from '@tanstack/react-query'
import { File, Paths } from 'expo-file-system'
import { useIsFocused, useRouter } from 'expo-router'
import { isAvailableAsync, shareAsync } from 'expo-sharing'
import { useEffect, useMemo, useState } from 'react'
import { AppState, FlatList, StyleSheet, View } from 'react-native'
import {
	ActivityIndicator,
	Appbar,
	Button,
	Menu,
	Searchbar,
	Text,
	TouchableRipple,
	useTheme,
} from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { usePlayerChapters } from '@/features/player/hooks/usePlayerChapters'
import { fetchSubtitles } from '@/features/player/utils/fetchSubtitles'
import {
	currentSubtitleAt,
	formatSubtitlesAsSRT,
	subtitleTrackOptions,
	type SubtitleCue,
} from '@/features/player/utils/subtitles'
import playerProgressEmitter from '@/lib/player/progressListener'
import { seekWithinTrack } from '@/lib/player/seek'
import { toastAndLogError } from '@/utils/error-handling'
import { formatDurationToHHMMSS } from '@/utils/time'

const NO_CUES: SubtitleCue[] = []

export default function PodcastSubtitlesPage() {
	const router = useRouter()
	const theme = useTheme()
	const data = usePlayerChapters()
	return (
		<View style={[styles.page, { backgroundColor: theme.colors.background }]}>
			<Appbar.Header>
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title='播客字幕' />
			</Appbar.Header>
			<SubtitleReader
				key={data.trackId}
				data={data}
			/>
		</View>
	)
}

function SubtitleReader({
	data,
}: {
	data: ReturnType<typeof usePlayerChapters>
}) {
	const focused = useIsFocused()
	const theme = useTheme()
	const insets = useSafeAreaInsets()
	const [search, setSearch] = useState('')
	const [subtitleId, setSubtitleId] = useState<string>()
	const [menuOpen, setMenuOpen] = useState(false)
	const [exporting, setExporting] = useState(false)
	const [refreshing, setRefreshing] = useState(false)
	const [active, setActive] = useState<SubtitleCue>()

	const tracks = useMemo(
		() => subtitleTrackOptions(data.subtitleTracks),
		[data.subtitleTracks],
	)
	const selected = tracks.find((track) => track.id === subtitleId) ?? tracks[0]
	const url = selected?.url
	const transcript = useQuery({
		queryKey: ['podcast-subtitles', data.trackId, url],
		queryFn: ({ signal }) => {
			if (!url) throw new Error('Subtitle track unavailable')
			return fetchSubtitles(url, signal)
		},
		enabled: focused && !!url,
		staleTime: 10 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
		retry: 1,
		meta: { silent: true },
	})
	const cues = transcript.data ?? NO_CUES
	const activeCue = active && cues.includes(active) ? active : undefined
	const visibleCues = useMemo(() => {
		const needle = search.trim().toLowerCase()
		return needle
			? cues.filter((cue) => cue.content.toLowerCase().includes(needle))
			: cues
	}, [cues, search])

	useEffect(() => {
		if (!focused || !cues.length) return
		let revision = 0
		const update = (seconds: number) => {
			setActive(currentSubtitleAt(cues, seconds))
		}
		const sync = () => {
			const request = ++revision
			void Orpheus.getPosition()
				.then((position) => {
					if (request === revision && AppState.currentState === 'active')
						update(position)
				})
				.catch(() => undefined)
		}
		const unsubscribe = playerProgressEmitter.subscribe(
			'progress',
			({ position }) => {
				revision++
				if (AppState.currentState === 'active') update(position)
			},
		)
		const appState = AppState.addEventListener('change', (state) => {
			if (state === 'active') sync()
		})
		sync()
		return () => {
			revision++
			unsubscribe()
			appState.remove()
		}
	}, [cues, focused])

	const retry = async () => {
		setRefreshing(true)
		try {
			const refreshedTracks = subtitleTrackOptions(await data.retry())
			const next =
				refreshedTracks.find((track) => track.id === subtitleId) ??
				refreshedTracks[0]
			// A new signed URL starts a new query automatically.
			if (next && next.url === url) await transcript.refetch()
		} finally {
			setRefreshing(false)
		}
	}

	const exportSubtitles = async () => {
		if (exporting || !cues.length) return
		setExporting(true)
		try {
			if (!(await isAvailableAsync())) throw new Error('Sharing unavailable')
			const file = new File(Paths.cache, 'bbplayer-podcast-subtitles.srt')
			file.create({ overwrite: true })
			file.write(formatSubtitlesAsSRT(cues))
			await shareAsync(file.uri, {
				mimeType: 'application/x-subrip',
				dialogTitle: '导出字幕',
			})
		} catch (error) {
			toastAndLogError('导出字幕失败', error, 'Player.Subtitles')
		} finally {
			setExporting(false)
		}
	}

	const seekToCue = (cue: SubtitleCue) => {
		if (!data.trackId) return
		void seekWithinTrack(data.trackId, cue.from).catch((error) =>
			toastAndLogError('字幕跳转失败', error, 'Player.Subtitles'),
		)
	}

	const isLoading =
		data.isLoading || (!!url && transcript.isPending && !transcript.isPaused)
	const isError = data.isError || transcript.isError || transcript.isPaused

	return (
		<>
			<View style={styles.tools}>
				<View style={styles.actions}>
					{tracks.length > 1 && (
						<Menu
							visible={menuOpen}
							onDismiss={() => setMenuOpen(false)}
							anchor={
								<Button onPress={() => setMenuOpen(true)}>
									{selected?.name}
								</Button>
							}
						>
							{tracks.map((track) => (
								<Menu.Item
									key={track.id}
									title={track.name}
									onPress={() => {
										setSubtitleId(track.id)
										setMenuOpen(false)
									}}
								/>
							))}
						</Menu>
					)}
					{cues.length > 0 && (
						<Button
							disabled={exporting}
							onPress={() => {
								void exportSubtitles()
							}}
						>
							导出 SRT
						</Button>
					)}
				</View>
				{cues.length > 0 && (
					<Searchbar
						placeholder='搜索字幕'
						value={search}
						onChangeText={setSearch}
					/>
				)}
				{activeCue && (
					<Text
						numberOfLines={2}
						style={{ color: theme.colors.primary }}
					>
						{activeCue.content}
					</Text>
				)}
			</View>
			{cues.length > 0 ? (
				<FlatList
					data={visibleCues}
					extraData={activeCue?.id}
					keyExtractor={(cue) => String(cue.id)}
					keyboardShouldPersistTaps='handled'
					contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
					ListEmptyComponent={
						<Text style={styles.message}>没有找到匹配的字幕</Text>
					}
					renderItem={({ item }) => (
						<TouchableRipple
							onPress={() => seekToCue(item)}
							accessibilityRole='button'
							accessibilityState={{ selected: activeCue?.id === item.id }}
							style={
								activeCue?.id === item.id && {
									backgroundColor: theme.colors.secondaryContainer,
								}
							}
						>
							<View style={styles.cue}>
								<Text
									variant='labelMedium'
									style={{ color: theme.colors.onSurfaceVariant }}
								>
									{formatDurationToHHMMSS(item.from)}
								</Text>
								<Text variant='bodyLarge'>{item.content}</Text>
							</View>
						</TouchableRipple>
					)}
				/>
			) : isLoading ? (
				<ActivityIndicator style={styles.message} />
			) : isError ? (
				<View style={styles.message}>
					<Text>暂时无法加载字幕</Text>
					<Button
						disabled={refreshing}
						loading={refreshing}
						onPress={() => {
							void retry()
						}}
					>
						重试
					</Button>
				</View>
			) : (
				<Text style={styles.message}>
					{data.subtitlesRequireLogin
						? '登录 B 站后可查看此视频的字幕'
						: '当前内容没有可用字幕'}
				</Text>
			)}
		</>
	)
}

const styles = StyleSheet.create({
	page: { flex: 1 },
	message: { margin: 20, alignSelf: 'center' },
	tools: { paddingHorizontal: 16, gap: 8, paddingBottom: 8 },
	actions: { flexDirection: 'row', flexWrap: 'wrap' },
	cue: { paddingHorizontal: 20, paddingVertical: 12, gap: 4 },
})
