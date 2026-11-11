import { readAudioFileAsync } from '@bbplayer/native'
import { useQuery } from '@tanstack/react-query'
import * as DocumentPicker from 'expo-document-picker'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { Appbar, List, Searchbar, Text } from 'react-native-paper'

import Button from '@/components/common/Button'
import { alert } from '@/components/modals/AlertModal'
import { useModalStore } from '@/hooks/stores/useModalStore'
import { queryClient } from '@/lib/config/queryClient'
import database from '@/lib/db/db'
import {
	importLocalAudio,
	relinkLocalAudio,
} from '@/lib/services/localAudioService'
import { trackService } from '@/lib/services/trackService'
import type { Track } from '@/types/core/media'
import { toastAndLogError } from '@/utils/error-handling'
import { addToQueue } from '@/utils/player'
import toast from '@/utils/toast'

const refresh = () => queryClient.invalidateQueries({ queryKey: ['db'] })

export default function LocalAudioPage() {
	const router = useRouter()
	const open = useModalStore((state) => state.open)
	const [busy, setBusy] = useState(false)
	const [query, setQuery] = useState('')
	const library = useQuery({
		queryKey: ['db', 'tracks', 'localAudio'],
		queryFn: async () => {
			const rows = await database.query.tracks.findMany({
				where: (track, { eq }) => eq(track.source, 'local'),
				with: { artist: true, localMetadata: true, bilibiliMetadata: true },
			})
			return rows
				.map((row) => trackService.formatTrack(row))
				.filter((track): track is Track => track !== null)
		},
	})
	const importFiles = async () => {
		setBusy(true)
		try {
			const result = await DocumentPicker.getDocumentAsync({
				type: ['audio/*'],
				multiple: true,
				copyToCacheDirectory: false,
			})
			if (result.canceled) return
			let imported = 0
			const failures: string[] = []
			for (const asset of result.assets) {
				try {
					// oxlint-disable-next-line no-await-in-loop
					await importLocalAudio(asset.uri, asset.name)
					imported++
				} catch {
					failures.push(asset.name)
				}
			}
			await refresh()
			if (imported) toast.success(`已导入 ${imported} 个文件引用`)
			if (failures.length)
				alert(
					'部分文件无法导入',
					`${failures.slice(0, 5).join('、')}。请确认文件仍存在、文件提供方允许长期读取，并使用 MP3、AAC/M4A、FLAC 或 WAV。`,
					[{ text: '知道了' }],
				)
		} catch (error) {
			toastAndLogError('导入本地音频失败', error, 'UI.LocalAudio')
		} finally {
			setBusy(false)
		}
	}
	const commitRelink = async (track: Track, uri: string) => {
		setBusy(true)
		try {
			await relinkLocalAudio(track, uri)
			await refresh()
			toast.success('文件引用已更新，歌曲身份与历史已保留')
		} catch (error) {
			toastAndLogError('重新关联失败', error, 'UI.LocalAudio')
		} finally {
			setBusy(false)
		}
	}
	const chooseRelink = async (track: Track) => {
		try {
			const result = await DocumentPicker.getDocumentAsync({
				type: ['audio/*'],
				multiple: false,
				copyToCacheDirectory: false,
			})
			if (result.canceled) return
			const asset = result.assets[0]
			const audio = await readAudioFileAsync(asset.uri)
			alert(
				'重新关联原文件',
				`将「${track.title}」关联到「${audio.title || asset.name}」（${Math.round(audio.duration)} 秒）。请确认这是同一首音频。歌单位置和历史保留，当前播放不会自动切换。`,
				[
					{ text: '取消' },
					{ text: '关联', onPress: () => void commitRelink(track, asset.uri) },
				],
			)
		} catch (error) {
			toastAndLogError('文件不可读取', error, 'UI.LocalAudio')
		}
	}
	const play = async (track: Track) => {
		if (track.source !== 'local') return
		try {
			await readAudioFileAsync(track.localMetadata.localPath)
			await addToQueue({
				tracks: [track],
				playNow: true,
				clearQueue: false,
				playNext: false,
			})
		} catch {
			alert(
				'文件暂时不可读取',
				'文件可能已移动、存储设备未连接，或读取权限失效。歌曲信息会保留，可以重新关联文件。',
				[
					{ text: '取消' },
					{ text: '重新关联', onPress: () => void chooseRelink(track) },
				],
			)
		}
	}
	const tracks =
		library.data?.filter((track) =>
			`${track.title} ${track.artist?.name ?? ''}`
				.toLowerCase()
				.includes(query.trim().toLowerCase()),
		) ?? []
	return (
		<View style={styles.container}>
			<Appbar.Header>
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title='本地音频' />
			</Appbar.Header>
			<ScrollView contentContainerStyle={styles.content}>
				<Text>
					引用你选择的原文件，不复制音频。编辑标题或封面只修改歌曲资料；移动文件后可以重新关联。
				</Text>
				<Button
					mode='contained'
					disabled={busy}
					loading={busy}
					onPress={() => void importFiles()}
				>
					选择本地音频
				</Button>
				<Searchbar
					placeholder='歌名或歌手'
					value={query}
					onChangeText={setQuery}
				/>
				{library.isError && (
					<Button onPress={() => void library.refetch()}>
						读取失败，点击重试
					</Button>
				)}
				{!library.isPending && !tracks.length && (
					<Text>暂无匹配的本地音频</Text>
				)}
				{tracks.map((track) => (
					<View key={track.id}>
						<List.Item
							title={track.title}
							description={`${track.artist?.name || '未知歌手'} · ${Math.round(track.duration)} 秒`}
							onPress={() => void play(track)}
							disabled={busy}
						/>
						<View style={styles.actions}>
							<Button
								disabled={busy}
								onPress={() => open('UpdateTrackLocalPlaylists', { track })}
							>
								歌单
							</Button>
							<Button
								disabled={busy}
								onPress={() => open('EditTrackMetadata', { track })}
							>
								编辑信息
							</Button>
							<Button
								disabled={busy}
								onPress={() => void chooseRelink(track)}
							>
								重新关联
							</Button>
						</View>
					</View>
				))}
			</ScrollView>
		</View>
	)
}
const styles = StyleSheet.create({
	container: { flex: 1 },
	content: { padding: 20, paddingBottom: 120, gap: 16 },
	actions: { flexDirection: 'row', flexWrap: 'wrap' },
})
