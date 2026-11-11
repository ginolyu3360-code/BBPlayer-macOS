import { Buffer } from 'buffer'

import { discoverLANPeersAsync, requestLANSyncAsync } from '@bbplayer/native'
import { Orpheus } from '@bbplayer/orpheus'
import * as SecureStore from 'expo-secure-store'
import * as SQLite from 'expo-sqlite'
import { AppState } from 'react-native'

import { createProtectionBackup } from '@/lib/backup/automatic'
import { queryClient } from '@/lib/config/queryClient'
import { expoDb, libraryRestoreGate, restoreDatabase } from '@/lib/db/db'

import { LocalSyncRecorder, localRecorder } from './localRecording'
import type { SyncOperation } from './protocol'

interface Offer {
	version: 1
	serverID: string
	endpoint: string
	pin: string
	secret: string
}
interface Profile {
	version: 1
	serverID: string
	serverActor: string
	endpoint: string
	pin: string
	token: string
	deviceID: string
	actor: string
}
interface Exchange {
	version: 1
	deviceID: string
	actor: string
	operations: SyncOperation[]
	acknowledged: string[]
	remaining: boolean
}
export interface LANStatus {
	initializing: boolean
	restartRequired: boolean
	connected: boolean
	busy: boolean
	message: string
	paired: boolean
}
const PROFILE_KEY = 'bbplayer-lan-peer-v1',
	DEVICE_KEY = 'bbplayer-lan-device-v1'
const listeners = new Set<() => void>()
let status: LANStatus = {
	initializing: false,
	restartRequired: false,
	connected: false,
	busy: false,
	message: '尚未配对',
	paired: false,
}
let profile: Profile | undefined
let generation = 0
let running = false
let initialGate = false
let debounce: ReturnType<typeof setTimeout> | undefined
const uuid = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(value)
const freshID = () =>
	expoDb.getFirstSync<{ id: string }>(
		"SELECT UPPER(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-8'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))) AS id",
	)!.id
const publish = (change: Partial<LANStatus>) => {
	status = { ...status, ...change }
	for (const listener of listeners) listener()
}
export const subscribeLANStatus = (listener: () => void) => {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
export const getLANStatus = () => status
const setMeta = (key: string, value: string) =>
	(initialGate ? restoreDatabase : expoDb).runSync(
		'INSERT INTO sync_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
		[key, value],
	)

export function parsePairingOffer(value: string): Offer {
	if (value.length > 4096) throw new Error('配对内容过长')
	const text = value.trim()
	let encoded = text
	if (text.startsWith('bbplayer-personal://')) {
		const link =
			/^bbplayer-personal:\/\/settings\/lan-sync\?pair=([A-Za-z0-9_-]+)$/.exec(
				text,
			)
		if (!link) throw new Error('配对链接无效')
		encoded = link[1]
	}
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('配对内容无效')
	let offer: Offer
	try {
		offer = JSON.parse(
			Buffer.from(
				encoded.replaceAll('-', '+').replaceAll('_', '/'),
				'base64',
			).toString('utf8'),
		) as Offer
	} catch {
		throw new Error('配对内容无效，请在 Mac 上重新生成')
	}
	if (!offer || typeof offer !== 'object') throw new Error('配对内容无效')
	if (
		offer.version !== 1 ||
		!uuid(offer.serverID) ||
		typeof offer.endpoint !== 'string' ||
		!/^https:\/\/(?:[\d.]+|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(offer.endpoint) ||
		!/^[a-f0-9]{64}$/.test(offer.pin) ||
		!/^[A-Za-z0-9_-]{43}$/.test(offer.secret)
	)
		throw new Error('配对内容无效，请在 Mac 上重新生成')
	return offer
}

/** UI must explain and confirm Mac authority before invoking this operation. */
export async function pairWithMac(value: string): Promise<void> {
	if (running || initialGate) throw new Error('正在接收资料库，请先完成或取消')
	libraryRestoreGate.assertReady()
	const offer = parsePairingOffer(value),
		epoch = ++generation
	running = true
	let committed = false,
		saved = false
	publish({ busy: true, initializing: true, message: '正在创建保护备份并配对' })
	try {
		await createProtectionBackup()
		let deviceID = await SecureStore.getItemAsync(DEVICE_KEY)
		if (!deviceID || !uuid(deviceID)) {
			deviceID = freshID()
			await SecureStore.setItemAsync(DEVICE_KEY, deviceID)
		}
		if (generation !== epoch) throw new Error('配对已取消')
		const actor = freshID()
		const result = JSON.parse(
			await requestLANSyncAsync(
				offer.endpoint,
				offer.pin,
				'/v1/pair',
				null,
				JSON.stringify({ version: 1, deviceID, actor, secret: offer.secret }),
			),
		) as { version: number; deviceID: string; actor: string; token: string }
		if (
			result.version !== 1 ||
			result.deviceID !== offer.serverID ||
			!uuid(result.actor) ||
			!/^[A-Za-z0-9_-]{43}$/.test(result.token)
		)
			throw new Error('Mac 返回的配对身份无效')
		if (generation !== epoch) throw new Error('配对已取消')
		const next: Profile = {
			version: 1,
			serverID: offer.serverID,
			serverActor: result.actor,
			endpoint: offer.endpoint,
			pin: offer.pin,
			token: result.token,
			deviceID,
			actor,
		}
		await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(next))
		saved = true
		await Orpheus.pause()
		if (generation !== epoch) throw new Error('配对已取消')
		await libraryRestoreGate.drain()
		initialGate = true
		if (generation !== epoch) throw new Error('配对已取消')
		restoreDatabase.withTransactionSync(() => {
			// Keep original file references, downloads and actual history on this device.
			restoreDatabase.runSync(
				"DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE type='local') AND track_id IN (SELECT id FROM tracks WHERE source='bilibili')",
			)
			restoreDatabase.runSync(
				"DELETE FROM playlists WHERE type='local' AND NOT EXISTS(SELECT 1 FROM playlist_tracks WHERE playlist_id=playlists.id)",
			)
			for (const table of [
				'sync_ack',
				'sync_head',
				'sync_operation',
				'sync_revision',
				'sync_like',
				'sync_lyric',
				'sync_meta',
			])
				restoreDatabase.runSync(`DELETE FROM ${table}`)
			setMeta('actor', actor)
			setMeta('accept-mac-baseline', 'true')
			new LocalSyncRecorder(restoreDatabase, actor).seedIfEmpty()
		})
		committed = true
		profile = next
		publish({
			paired: true,
			connected: false,
			message: '已配对，正在接收 Mac 资料库',
		})
	} catch (error) {
		if (!committed) {
			if (initialGate) {
				initialGate = false
				libraryRestoreGate.resume()
			}
			if (saved) {
				profile = undefined
				await SecureStore.deleteItemAsync(PROFILE_KEY).catch(() => {})
			}
			publish({
				initializing: false,
				connected: false,
				message:
					'配对未完成，手机资料库未被替换。请检查配对码、网络或备份空间后重试',
			})
		}
		throw error
	} finally {
		running = false
		publish({ busy: false })
	}
	await synchronizeLAN()
}

async function exchange(peer: Profile, body: string): Promise<Exchange> {
	const parse = (raw: string) => {
		const result = JSON.parse(raw) as Exchange
		if (
			result.version !== 1 ||
			result.deviceID !== peer.serverID ||
			result.actor !== peer.serverActor ||
			!Array.isArray(result.operations) ||
			!Array.isArray(result.acknowledged) ||
			result.operations.length > 1000 ||
			result.acknowledged.length > 1000 ||
			typeof result.remaining !== 'boolean'
		)
			throw new Error('Mac 同步基准已改变，请重新配对')
		return result
	}
	try {
		return parse(
			await requestLANSyncAsync(
				peer.endpoint,
				peer.pin,
				'/v1/sync',
				peer.token,
				body,
			),
		)
	} catch (error) {
		if (/certificate|SSL|401|基准/i.test(String(error))) throw error
		const found = await discoverLANPeersAsync()
		for (const candidate of found
			.filter((entry) => entry.name === 'BBPlayer-' + peer.serverID.slice(0, 8))
			.slice(0, 3)) {
			if (candidate.endpoint === peer.endpoint) continue
			try {
				const result = parse(
					await requestLANSyncAsync(
						candidate.endpoint,
						peer.pin,
						'/v1/sync',
						peer.token,
						body,
					),
				)
				peer.endpoint = candidate.endpoint
				return result
			} catch {
				/* Advertisements never replace the pinned identity. */
			}
		}
		throw error
	}
}

export async function synchronizeLAN(): Promise<void> {
	if (
		running ||
		status.restartRequired ||
		!profile ||
		AppState.currentState !== 'active'
	)
		return
	const peer = profile,
		epoch = generation
	const database = initialGate ? restoreDatabase : expoDb
	running = true
	publish({ busy: true })
	try {
		const recorder = localRecorder(database)
		if (!recorder || recorder.actor !== peer.actor) {
			publish({
				connected: false,
				message: '资料库已恢复或同步身份改变，请重新配对',
			})
			return
		}
		let finished = false
		for (let page = 0; page < 100; page++) {
			if (!initialGate) libraryRestoreGate.assertReady()
			const pending = JSON.parse(
				database.getFirstSync<{ value: string }>(
					"SELECT value FROM sync_meta WHERE key='transport-acks'",
				)?.value ?? '[]',
			) as string[]
			const candidates = initialGate
				? []
				: recorder.engine.outbox(peer.serverID, 200)
			const outgoing: SyncOperation[] = []
			let bytes = 0
			for (const candidate of candidates) {
				const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
				if (bytes + size > 12 * 1024 * 1024) break
				outgoing.push(candidate)
				bytes += size
			}
			const response = await exchange(
				peer,
				JSON.stringify({
					version: 1,
					deviceID: peer.deviceID,
					operations: outgoing,
					acknowledged: pending,
				}),
			)
			if (generation !== epoch) return
			if (!initialGate) libraryRestoreGate.assertReady()
			const acknowledged = recorder.engine.receive(response.operations)
			if (response.operations.length && !acknowledged.length)
				throw new Error('同步仍缺少前置记录，请在 Mac 重新建立同步后配对')
			recorder.engine.acknowledge(peer.serverID, response.acknowledged)
			setMeta('transport-acks', JSON.stringify(acknowledged))
			if (response.operations.length && !initialGate)
				void queryClient.invalidateQueries({ queryKey: ['db'] })
			if (
				!response.remaining &&
				response.operations.length === 0 &&
				(initialGate ||
					recorder.engine.outbox(peer.serverID, 1).length === 0) &&
				acknowledged.length === 0
			) {
				setMeta('accept-mac-baseline', 'false')
				finished = true
				break
			}
			if (AppState.currentState !== 'active') break
		}
		if (finished && initialGate) {
			libraryRestoreGate.requireRestart()
			publish({
				connected: true,
				initializing: false,
				restartRequired: true,
				message: '首次同步已完成，请重启应用后使用',
			})
		} else {
			publish({
				connected: true,
				message: finished
					? '已同步，等待下一次修改'
					: '仍在接收资料，下一轮将继续',
			})
			if (!finished && AppState.currentState === 'active')
				debounce = setTimeout(() => void synchronizeLAN(), 2000)
		}
	} catch (error) {
		if (generation !== epoch) return
		const text = String(error)
		publish({
			connected: false,
			message: /certificate|SSL/i.test(text)
				? '设备证书已改变，请在两端重新配对'
				: /401/.test(text)
					? '配对已撤销或失效，请重新配对'
					: text.includes('同步') ||
						  text.includes('恢复') ||
						  text.includes('基准')
						? text
						: '暂时无法连接 Mac，请确认两台设备在同一局域网',
		})
	} finally {
		running = false
		publish({ busy: false })
	}
}
export async function disconnectLAN(): Promise<void> {
	if (running || status.restartRequired) return
	running = true
	generation++
	const previous = profile
	publish({ busy: true })
	try {
		await SecureStore.deleteItemAsync(PROFILE_KEY)
		profile = undefined
		if (initialGate) {
			setMeta('accept-mac-baseline', 'false')
			libraryRestoreGate.requireRestart()
			publish({
				initializing: false,
				restartRequired: true,
				message:
					'已停止首次同步，请重启后使用已接收的资料；原资料可从保护备份恢复',
			})
		}
		publish({
			paired: false,
			connected: false,
			...(status.restartRequired ? {} : { message: '已断开配对' }),
		})
		if (previous)
			try {
				await requestLANSyncAsync(
					previous.endpoint,
					previous.pin,
					'/v1/revoke',
					previous.token,
					'{}',
				)
			} catch {
				/* An offline Mac can revoke the peer locally. */
			}
	} finally {
		running = false
		publish({ busy: false })
	}
}
export function startLANScheduler(): () => void {
	let stopped = false
	const loadedGeneration = generation
	void SecureStore.getItemAsync(PROFILE_KEY)
		.then(async (raw) => {
			if (stopped || loadedGeneration !== generation || !raw) return
			const candidate = JSON.parse(raw) as Profile
			if (
				candidate.version !== 1 ||
				!uuid(candidate.serverID) ||
				!uuid(candidate.deviceID) ||
				!uuid(candidate.actor) ||
				!uuid(candidate.serverActor)
			)
				throw new Error('Invalid paired device')
			if (
				expoDb.getFirstSync<{ value: string }>(
					"SELECT value FROM sync_meta WHERE key='accept-mac-baseline'",
				)?.value === 'true'
			) {
				running = true
				publish({
					initializing: true,
					busy: true,
					message: '继续接收未完成的 Mac 资料库',
				})
				try {
					await Orpheus.pause()
					await libraryRestoreGate.drain()
					initialGate = true
				} finally {
					running = false
					publish({ busy: false })
				}
			}
			profile = candidate
			publish({ paired: true, message: '等待 Mac 连接' })
			void synchronizeLAN()
		})
		.catch(() =>
			publish({
				initializing: false,
				connected: false,
				message: '无法读取设备配对，请重新配对',
			}),
		)
	const request = () => {
		if (running || AppState.currentState !== 'active') return
		if (debounce) clearTimeout(debounce)
		debounce = setTimeout(() => void synchronizeLAN(), 2000)
	}
	const changes = SQLite.addDatabaseChangeListener((event) => {
		if (
			[
				'playlists',
				'playlist_tracks',
				'library_songs',
				'sync_like',
				'sync_lyric',
				'sync_operation',
			].includes(event.tableName)
		)
			request()
	})
	const state = AppState.addEventListener('change', (value) => {
		if (value === 'active') void synchronizeLAN()
		else if (debounce) clearTimeout(debounce)
	})
	const timer = setInterval(() => void synchronizeLAN(), 30_000)
	return () => {
		stopped = true
		changes.remove()
		state.remove()
		clearInterval(timer)
		if (debounce) clearTimeout(debounce)
	}
}
