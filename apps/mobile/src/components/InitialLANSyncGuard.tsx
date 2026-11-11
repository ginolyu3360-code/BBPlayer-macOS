import * as Expo from 'expo'
import { useSyncExternalStore } from 'react'
import { Modal, View } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'

import Button from '@/components/common/Button'
import {
	disconnectLAN,
	getLANStatus,
	subscribeLANStatus,
	synchronizeLAN,
} from '@/lib/sync/client'
import toast from '@/utils/toast'

/** Initial seeding holds the database gate until old JavaScript work is discarded by restart. */
export default function InitialLANSyncGuard() {
	const status = useSyncExternalStore(subscribeLANStatus, getLANStatus),
		theme = useTheme()
	return (
		<Modal
			visible={status.initializing || status.restartRequired}
			transparent
			animationType='fade'
			onRequestClose={() => {}}
		>
			<View
				style={{
					flex: 1,
					justifyContent: 'center',
					padding: 24,
					backgroundColor: '#0009',
				}}
			>
				<View
					style={{
						backgroundColor: theme.colors.surface,
						padding: 24,
						borderRadius: 20,
						gap: 16,
					}}
				>
					<Text variant='titleLarge'>
						{status.restartRequired ? '重启后继续使用' : '首次设备同步'}
					</Text>
					<Text>{status.message}</Text>
					{status.busy && <ActivityIndicator />}
					{status.restartRequired ? (
						<Button
							mode='contained'
							onPress={() =>
								void Expo.reloadAppAsync().catch(() =>
									toast.error('请完全退出后重新打开应用'),
								)
							}
						>
							重启应用
						</Button>
					) : (
						<>
							<Text>
								为避免旧操作覆盖新资料库，接收期间暂停编辑。完成后需重启一次。原始音频和保护备份保留在手机。
							</Text>
							{!status.busy && (
								<Button
									mode='contained'
									onPress={() => void synchronizeLAN()}
								>
									重试连接
								</Button>
							)}
							<Button
								disabled={status.busy}
								onPress={() =>
									void disconnectLAN().catch(() =>
										toast.error('清除配对失败，请重试'),
									)
								}
							>
								取消首次同步
							</Button>
						</>
					)}
				</View>
			</View>
		</Modal>
	)
}
