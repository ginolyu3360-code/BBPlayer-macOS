import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { Appbar, List, RadioButton, Text, TextInput } from 'react-native-paper'

import Button from '@/components/common/Button'
import { alert } from '@/components/modals/AlertModal'
import { useGetVideoDetails } from '@/hooks/queries/bilibili/video'
import { createProtectionBackup } from '@/lib/backup/automatic'
import { queryClient } from '@/lib/config/queryClient'
import { expoDb } from '@/lib/db/db'
import { replaceSongSource } from '@/lib/services/songIdentityService'
import { trackService } from '@/lib/services/trackService'
import { toastAndLogError } from '@/utils/error-handling'
import { returnOrThrowAsync } from '@/utils/neverthrow-utils'
import toast from '@/utils/toast'

export default function ReplaceSourcePage() {
	const router = useRouter()
	const { trackId } = useLocalSearchParams<{ trackId: string }>()
	const id = Number(trackId)
	const [input, setInput] = useState('')
	const [bvid, setBvid] = useState<string>()
	const [cid, setCid] = useState<number>()
	const [saving, setSaving] = useState(false)
	const original = useQuery({
		queryKey: ['db', 'tracks', 'sourceReplacement', id],
		queryFn: () => returnOrThrowAsync(trackService.getTrackById(id)),
		enabled: Number.isSafeInteger(id) && id > 0,
	})
	const details = useGetVideoDetails(bvid)
	const page = details.data?.pages.find((item) => item.cid === cid)
	const save = async () => {
		if (!original.data || !details.data || !page || saving) return
		setSaving(true)
		try {
			await createProtectionBackup()
			const candidate = await returnOrThrowAsync(
				trackService.findOrCreateTrack({
					source: 'bilibili',
					title: original.data.title,
					artistId: original.data.artist?.id,
					coverUrl: original.data.coverUrl,
					duration: page.duration,
					bilibiliMetadata: {
						bvid: details.data.bvid,
						cid: page.cid,
						isMultiPage: true,
						mainTrackTitle: details.data.title,
						videoIsValid: true,
					},
				}),
			)
			replaceSongSource(expoDb, original.data.id, candidate.id)
			await queryClient.invalidateQueries({ queryKey: ['db'] })
			toast.success('来源已替换；当前播放继续使用原来源')
			router.back()
		} catch (error) {
			toastAndLogError('换源失败', error, 'UI.ReplaceSource')
		} finally {
			setSaving(false)
		}
	}
	return (
		<View style={styles.container}>
			<Appbar.Header>
				<Appbar.BackAction
					disabled={saving}
					onPress={() => router.back()}
				/>
				<Appbar.Content title='替换播放来源' />
			</Appbar.Header>
			<ScrollView contentContainerStyle={styles.content}>
				<Text variant='titleMedium'>{original.data?.title ?? '读取歌曲…'}</Text>
				<Text>
					保留歌曲身份、歌单顺序和累计历史。旧下载和旧歌词不会套用到新来源。
				</Text>
				{original.isError && <Text>无法读取歌曲，请返回后重试。</Text>}
				<TextInput
					label='视频链接或 BV 号'
					value={input}
					onChangeText={setInput}
					disabled={saving}
					autoCapitalize='none'
					mode='outlined'
				/>
				<Button
					disabled={saving}
					loading={details.isFetching}
					onPress={() => {
						const match = input.match(/BV[0-9A-Za-z]{10}/)
						if (!match) {
							toast.error('请输入完整 BV 号或包含它的视频链接')
							return
						}
						setCid(undefined)
						setBvid(match[0])
					}}
				>
					读取来源
				</Button>
				{details.isError && (
					<Text>无法读取视频，请检查链接、登录状态或网络后重试。</Text>
				)}
				{details.data && (
					<>
						<Text variant='titleMedium'>{details.data.title}</Text>
						<Text>{details.data.owner.name}</Text>
						{details.data.pages.map((item, index) => (
							<List.Item
								key={item.cid}
								title={`${index + 1}. ${item.part}`}
								description={`${item.duration} 秒`}
								disabled={saving}
								onPress={() => setCid(item.cid)}
								left={() => (
									<RadioButton
										value={String(item.cid)}
										status={item.cid === cid ? 'checked' : 'unchecked'}
										onPress={() => setCid(item.cid)}
									/>
								)}
							/>
						))}
					</>
				)}
				<Button
					mode='contained'
					disabled={
						!page ||
						!original.data ||
						original.data.source !== 'bilibili' ||
						saving ||
						details.isFetching
					}
					loading={saving}
					onPress={() =>
						alert(
							'确认换源',
							`将使用「${page?.part}」作为这首歌的新来源。当前播放保持原来源；再次从歌单播放时使用新来源。`,
							[{ text: '取消' }, { text: '替换', onPress: () => void save() }],
						)
					}
				>
					替换来源
				</Button>
			</ScrollView>
		</View>
	)
}
const styles = StyleSheet.create({
	container: { flex: 1 },
	content: { padding: 20, gap: 16, paddingBottom: 120 },
})
