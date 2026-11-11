import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Buffer: mobileBuffer } = require('buffer/')
const imports = {
	'@bbplayer/native': '{ discoverLANPeersAsync, requestLANSyncAsync }',
	'@bbplayer/orpheus': '{ Orpheus }',
	buffer: '{ Buffer }',
	'expo-secure-store': 'SecureStore',
	'expo-sqlite': 'SQLite',
	'react-native': '{ AppState }',
	'@/lib/backup/automatic': '{ createProtectionBackup }',
	'@/lib/config/queryClient': '{ queryClient }',
	'@/lib/db/db': '{ expoDb, libraryRestoreGate, restoreDatabase }',
	'./localRecording': '{ LocalSyncRecorder, localRecorder }',
}
const source = stripTypeScriptTypes(
	readFileSync(new URL('../src/lib/sync/client.ts', import.meta.url), 'utf8'),
)
	.replace(
		/^import[\s\S]*?from ['"]([^'"]+)['"];?$/gm,
		(_, id) => `const ${imports[id]} = deps[${JSON.stringify(id)}]`,
	)
	.replace(/^export /gm, '')
const gateSource = stripTypeScriptTypes(
	readFileSync(
		new URL('../src/lib/db/restoreGate.ts', import.meta.url),
		'utf8',
	),
).replace(/^export /gm, '')
const createRestoreGate = new vm.Script(
	gateSource + ';createRestoreGate',
).runInNewContext()
const serverID = '00000000-0000-0000-0000-000000000001'
const serverActor = '00000000-0000-0000-0000-000000000002'
const endpoint = 'https://192.168.0.2:4321'
const offer = {
	version: 1,
	serverID,
	endpoint,
	pin: 'a'.repeat(64),
	secret: '_'.repeat(43),
}
const invitation =
	'bbplayer-personal://settings/lan-sync?pair=' +
	Buffer.from(JSON.stringify(offer)).toString('base64url')
const profileKey = 'bbplayer-lan-peer-v1'
function harness({ rejectPair = false } = {}) {
	const events = [],
		requests = [],
		meta = new Map(),
		stored = new Map()
	let nextID = 10,
		failing = false,
		deleteFails = false
	const database = {
		getFirstSync(sql) {
			if (sql.includes('randomblob'))
				return {
					id: '00000000-0000-0000-0000-' + String(nextID++).padStart(12, '0'),
				}
			const key = /key='([^']+)'/.exec(sql)?.[1]
			return meta.has(key) ? { value: meta.get(key) } : null
		},
		runSync(sql, args) {
			if (sql.startsWith('INSERT INTO sync_meta')) meta.set(args[0], args[1])
			if (sql.startsWith('DELETE FROM playlist_tracks'))
				events.push('network reset')
		},
		withTransactionSync: (body) => body(),
	}
	const gate = createRestoreGate(database)
	class LocalSyncRecorder {
		seedIfEmpty() {}
	}
	const deps = {
		'@bbplayer/native': {
			discoverLANPeersAsync: async () => [],
			requestLANSyncAsync: async (_endpoint, pin, path, bearer, payload) => {
				const body = JSON.parse(payload)
				assert.equal(pin, offer.pin)
				requests.push({ path, body })
				if (path === '/v1/pair') {
					if (rejectPair) throw new Error('401')
					events.push('paired')
					return JSON.stringify({
						version: 1,
						deviceID: serverID,
						actor: serverActor,
						token: 'b'.repeat(43),
					})
				}
				assert.equal(bearer, 'b'.repeat(43))
				if (path === '/v1/revoke') return '{}'
				assert.throws(gate.assertReady)
				if (failing) throw new Error('unreachable')
				return JSON.stringify({
					version: 1,
					deviceID: serverID,
					actor: serverActor,
					operations: body.acknowledged.length ? [] : [{ id: 'op' }],
					acknowledged: [],
					remaining: false,
				})
			},
		},
		'@bbplayer/orpheus': {
			Orpheus: {
				pause: async () => {
					events.push('paused')
				},
			},
		},
		buffer: { Buffer: mobileBuffer },
		'expo-secure-store': {
			getItemAsync: async (key) => stored.get(key),
			setItemAsync: async (key, value) => {
				stored.set(key, value)
			},
			deleteItemAsync: async (key) => {
				if (deleteFails) throw new Error('key store unavailable')
				stored.delete(key)
			},
		},
		'react-native': { AppState: { currentState: 'active' } },
		'@/lib/backup/automatic': {
			createProtectionBackup: async () => {
				events.push('backup')
			},
		},
		'@/lib/config/queryClient': {
			queryClient: {
				invalidateQueries: async () => {
					events.push('refresh')
				},
			},
		},
		'@/lib/db/db': {
			expoDb: gate.database,
			libraryRestoreGate: gate,
			restoreDatabase: database,
		},
		'./localRecording': {
			LocalSyncRecorder,
			localRecorder: () => ({
				actor: meta.get('actor'),
				engine: {
					outbox: () => [{ id: 'local' }],
					receive: (ops) => ops.map((op) => op.id),
					acknowledge: () => {},
				},
			}),
		},
	}
	const api = new vm.Script(
		source +
			';({pairWithMac,parsePairingOffer,synchronizeLAN,disconnectLAN,getLANStatus})',
	).runInNewContext({ deps })
	return {
		...api,
		events,
		requests,
		stored,
		meta,
		gate,
		setOffline: (v) => {
			failing = v
		},
		setDeleteFails: (v) => {
			deleteFails = v
		},
	}
}
void test('first sync decodes the QR with the Android buffer library and waits for ACK before requiring restart', async () => {
	const h = harness()
	assert.equal(h.parsePairingOffer(invitation).serverID, serverID)
	assert.throws(() => h.parsePairingOffer(invitation + '&extra=yes'))
	await h.pairWithMac(invitation)
	assert.deepEqual(h.events, ['backup', 'paired', 'paused', 'network reset'])
	const sync = h.requests.filter((request) => request.path === '/v1/sync')
	assert.deepEqual(
		sync.map((request) => request.body.acknowledged),
		[[], ['op']],
	)
	assert.ok(sync.every((request) => request.body.operations.length === 0))
	assert.equal(h.getLANStatus().restartRequired, true)
	assert.equal(h.meta.get('accept-mac-baseline'), 'false')
	assert.throws(h.gate.assertReady)
})
void test('authentication failure leaves the phone database open and unchanged', async () => {
	const h = harness({ rejectPair: true })
	await assert.rejects(h.pairWithMac(invitation), /401/)
	assert.deepEqual(h.events, ['backup'])
	assert.equal(h.stored.has(profileKey), false)
	assert.equal(h.getLANStatus().initializing, false)
	h.gate.assertReady()
})
void test('failed initial transfer retains the edit gate and can resume without resetting again', async () => {
	const h = harness()
	h.setOffline(true)
	await h.pairWithMac(invitation)
	assert.equal(h.getLANStatus().initializing, true)
	assert.equal(h.getLANStatus().restartRequired, false)
	assert.throws(h.gate.assertReady)
	h.setOffline(false)
	await h.synchronizeLAN()
	assert.equal(h.getLANStatus().restartRequired, true)
	assert.equal(h.events.filter((e) => e === 'network reset').length, 1)
})
void test('cancelling a partial seed requires restart only after durable unpairing', async () => {
	const h = harness()
	h.setOffline(true)
	await h.pairWithMac(invitation)
	h.setDeleteFails(true)
	await assert.rejects(h.disconnectLAN(), /key store/)
	assert.equal(h.getLANStatus().restartRequired, false)
	assert.equal(h.stored.has(profileKey), true)
	h.setDeleteFails(false)
	await h.disconnectLAN()
	assert.equal(h.stored.has(profileKey), false)
	assert.equal(h.getLANStatus().restartRequired, true)
	assert.throws(h.gate.assertReady)
})
