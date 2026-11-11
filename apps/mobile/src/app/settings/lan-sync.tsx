import { discoverLANPeersAsync } from '@bbplayer/native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ScrollView, View } from 'react-native'
import {
	Appbar,
	Card,
	List,
	Text,
	TextInput,
	useTheme,
} from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import Button from '@/components/common/Button'
import { alert } from '@/components/modals/AlertModal'
import { queryClient } from '@/lib/config/queryClient'
import { expoDb } from '@/lib/db/db'
import {
	disconnectLAN,
	getLANStatus,
	pairWithMac,
	subscribeLANStatus,
	synchronizeLAN,
} from '@/lib/sync/client'
import { localRecorder } from '@/lib/sync/localRecording'
import type { SyncConflict, SyncOperation } from '@/lib/sync/protocol'
import toast from '@/utils/toast'

function describe(operation: SyncOperation): string {
	if (operation.value.text) return '标题：' + operation.value.text
	if (operation.value.source)
		return (
			'来源：' +
			operation.value.source.track.title +
			' · ' +
			operation.value.source.track.bvid
		)
	if (operation.value.lyrics)
		return `歌词（${operation.value.lyrics.lines.length} 行，偏移 ${operation.value.lyrics.offset} 秒）`
	if (operation.value.order)
		return `歌曲顺序（${operation.value.order.length} 首）`
	return operation.field === 'deleted'
		? operation.value.flag
			? '删除歌单'
			: '保留歌单'
		: operation.value.flag
			? '保留修改'
			: '确认移除'
}
export default function LANSyncSettings() {
	const router = useRouter(),
		params = useLocalSearchParams<{ pair?: string }>(),
		theme = useTheme(),
		insets = useSafeAreaInsets()
	const status = useSyncExternalStore(subscribeLANStatus, getLANStatus)
	const [pairing, setPairing] = useState(''),
		[discovering, setDiscovering] = useState(false),
		[found, setFound] = useState<{ name: string; endpoint: string }[]>([])
	const [conflicts, setConflicts] = useState<SyncConflict[]>([])
	const refresh = useCallback(
		() =>
			setConflicts(
				status.initializing || status.restartRequired
					? []
					: (localRecorder(expoDb)?.engine.conflicts() ?? []),
			),
		[status.initializing, status.restartRequired],
	)
	useEffect(() => {
		if (params.pair)
			setPairing('bbplayer-personal://settings/lan-sync?pair=' + params.pair)
	}, [params.pair])
	useEffect(() => {
		refresh()
	}, [refresh, status])
	const connect = () =>
		alert(
			'以 Mac 资料库开始同步？',
			'手机本地歌单中的网络歌曲和喜欢将采用 Mac 基准，已有纯网络本地歌单会被替换。原始音频、含原始音频的歌单和播放历史保留，播放会暂停，并先创建保护备份。首次接收完成后需重启一次，之后两端修改会双向同步。',
			[
				{ text: '取消' },
				{
					text: '备份并配对',
					onPress: () => {
						void pairWithMac(pairing)
							.then(() => {
								setPairing('')
							})
							.catch(() => toast.error('配对未完成，请查看页面上的连接状态'))
					},
				},
			],
		)
	const discover = async () => {
		setDiscovering(true)
		try {
			setFound(await discoverLANPeersAsync())
		} catch {
			toast.error('未能发现设备，请使用 Mac 配对码')
		} finally {
			setDiscovering(false)
		}
	}
	const resolve = (conflict: SyncConflict, variant: SyncOperation) => {
		try {
			localRecorder(expoDb)?.engine.resolveConflict(conflict, variant.id)
			refresh()
			void queryClient.invalidateQueries({ queryKey: ['db'] })
			void synchronizeLAN()
		} catch {
			toast.error('冲突内容可能已更新，请刷新后重新选择')
		}
	}
	return (
		<View style={{ flex: 1, backgroundColor: theme.colors.background }}>
			<Appbar.Header>
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title='设备间同步' />
			</Appbar.Header>
			<ScrollView
				contentContainerStyle={{
					padding: 16,
					gap: 16,
					paddingBottom: insets.bottom + 100,
				}}
			>
				<Text>
					仅在局域网同步网络歌单、应用内喜欢和手动歌词。原始音频、下载、历史、进度、设置和登录信息不发送到另一台设备。
				</Text>
				<Card>
					<Card.Content>
						<Text variant='titleMedium'>{status.message}</Text>
					</Card.Content>
					<Card.Actions>
						<Button
							disabled={status.busy || !status.paired}
							loading={status.busy}
							onPress={() => void synchronizeLAN()}
						>
							立即同步
						</Button>
						{status.paired && (
							<Button
								disabled={status.busy}
								onPress={() =>
									alert(
										'断开设备配对？',
										'手机会停止连接。Mac 离线时，请在 Mac 上也撤销该设备的连接权限。',
										[
											{ text: '取消' },
											{
												text: '断开',
												onPress: () =>
													void disconnectLAN().catch(() =>
														toast.error('无法清除配对，请重试'),
													),
											},
										],
									)
								}
							>
								断开配对
							</Button>
						)}
					</Card.Actions>
				</Card>
				<Text variant='titleMedium'>与 Mac 配对</Text>
				<Text>
					在 Mac
					设置的“设备间同步”中生成配对码。可用系统相机扫描二维码打开此页，也可粘贴
					Mac 复制的配对内容。配对码只能使用一次，五分钟后失效。
				</Text>
				<TextInput
					label='粘贴配对内容'
					value={pairing}
					onChangeText={setPairing}
					multiline
					autoCapitalize='none'
					autoCorrect={false}
					disabled={status.busy}
				/>
				<Button
					mode='contained'
					onPress={connect}
					disabled={!pairing.trim() || status.busy}
				>
					确认基准并配对
				</Button>
				<Button
					mode='outlined'
					loading={discovering}
					disabled={discovering}
					onPress={() => void discover()}
				>
					查找同一网络中的 Mac
				</Button>
				{found.map((peer) => (
					<List.Item
						key={peer.endpoint}
						title={peer.name}
						description={peer.endpoint}
					/>
				))}
				{found.length > 0 && (
					<Text>发现的地址仅供参考，仍需通过 Mac 配对码验证身份。</Text>
				)}
				{conflicts.length > 0 && (
					<Text variant='titleMedium'>需要选择的修改</Text>
				)}
				{conflicts.map((conflict, index) => (
					<Card key={conflict.entity + '|' + conflict.field}>
						<Card.Content>
							<Text variant='titleMedium'>冲突 {index + 1}</Text>
							{conflict.variants.map((variant) => (
								<View
									key={variant.id}
									style={{ marginTop: 12, gap: 6 }}
								>
									<Text>{describe(variant)}</Text>
									{variant.value.lyrics && (
										<Text numberOfLines={8}>
											{variant.value.lyrics.lines
												.map((line) => line.text)
												.join('\n')}
										</Text>
									)}
									{variant.value.order && (
										<Text numberOfLines={8}>
											{variant.value.order
												.map(
													(id) =>
														expoDb.getFirstSync<{ title: string }>(
															'SELECT t.title FROM library_songs s JOIN tracks t ON t.unique_key=s.active_source_key WHERE UPPER(s.id)=?',
															[id],
														)?.title ?? '未找到的歌曲',
												)
												.join(' → ')}
										</Text>
									)}
									<Button
										mode='outlined'
										disabled={status.busy}
										onPress={() => resolve(conflict, variant)}
									>
										采用此版本
									</Button>
								</View>
							))}
						</Card.Content>
					</Card>
				))}
			</ScrollView>
		</View>
	)
}
