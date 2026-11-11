import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
const CryptoJS = createRequire(new URL('../package.json', import.meta.url))(
	'crypto-js',
)

// The loader below uses explicit bindings, preserving the real restore implementation.
const bindings = {
	'@bbplayer/orpheus': '{ Orpheus }',
	'crypto-js': 'CryptoJS',
	'expo-file-system': '{ Directory, File, Paths }',
	'expo-sqlite': 'SQLite',
	jszip: 'JSZip',
	'@/hooks/stores/playbackContextStore': '{ restorePlaybackContextState }',
	'@/lib/db/db': '{ expoDb, libraryRestoreGate, restoreDatabase }',
	'@/utils/log': 'log',
	'@/utils/mmkv': '{ storage }',
	'./preferences':
		'{ exportPreferences, mergePreferences, portableNativePreferences }',
	'./types': '{ BACKUP_VERSION }',
	'./upgrade': '{ upgradeBackupSchema }',
	'./merge': '{ mergeLibraryDatabases }',
}
const raw = stripTypeScriptTypes(
	readFileSync(new URL('../src/lib/backup/import.ts', import.meta.url), 'utf8'),
)
	.replace(
		/^import[\s\S]*?from ['"]([^'"]+)['"];?$/gm,
		(_, id) => `const ${bindings[id]} = imports[${JSON.stringify(id)}]`,
	)
	.replace(/^export /gm, '')

function harness({
	invalid = false,
	failPreferences = false,
	artwork = false,
	corruptArtwork = false,
} = {}) {
	const artworkName = CryptoJS.SHA256('AQ==').toString() + '.img'
	const directories = new Set()
	const restoredCovers = []
	let live = 'original'
	let commits = 0
	let restarted = false
	const files = new Map()
	class File {
		constructor(...parts) {
			this.uri = parts.map((p) => p.uri ?? p).join('/')
		}
		bytesSync() {
			return files.get(this.uri) ?? new Uint8Array([1])
		}
		write(value) {
			files.set(this.uri, value)
		}
	}
	class Directory {
		constructor(...parts) {
			this.uri = parts.map((p) => p.uri ?? p).join('/')
		}
		get exists() {
			return directories.has(this.uri)
		}
		create() {
			directories.add(this.uri)
		}
		delete() {
			directories.delete(this.uri)
			for (const path of files.keys())
				if (path.startsWith(this.uri + '/')) files.delete(path)
		}
	}
	const values = new Map([['app-storage', '{"local":"preserved"}']])
	const schema = [{ name: 'tracks', sql: 'CREATE TABLE tracks(id)' }]
	const db = (value) => ({
		value,
		closeSync() {},
		getFirstSync() {
			return { invalid: 0 }
		},
		runSync(_sql, args) {
			restoredCovers.push(args[0])
		},
		execSync() {},
		getAllSync(query) {
			if (query.includes('cover_url'))
				return artwork && query.includes('tracks')
					? [{ id: 1, cover_url: 'backup-artwork://' + artworkName }]
					: []
			return query.includes('quick_check')
				? [{ quick_check: invalid ? 'corrupt' : 'ok' }]
				: query.includes('foreign_key_check')
					? []
					: schema
		},
	})
	const expoDb = { ...db('original'), serializeSync: () => new Uint8Array([2]) }
	const imported = {
		version: 2,
		mmkv: { 'app-storage': '{}' },
		orpheus: { playerQueue: {} },
	}
	const modules = {
		'crypto-js': CryptoJS,
		'@bbplayer/orpheus': {
			Orpheus: {
				pause: async () => {},
				exportData: () => ({ playerQueue: {}, loudness: {} }),
				importData() {},
			},
		},
		'expo-file-system': {
			File,
			Directory,
			Paths: { cache: 'cache', document: 'document' },
		},
		'expo-sqlite': {
			deserializeDatabaseSync: (bytes) =>
				db(bytes[0] === 2 ? 'original' : 'imported'),
			backupDatabaseSync({ sourceDatabase }) {
				commits++
				live = sourceDatabase.value
			},
		},
		jszip: {
			loadAsync: async () => ({
				files: {},
				file: (name) => ({
					async: async (format) =>
						format === 'base64'
							? corruptArtwork
								? 'Ag=='
								: 'AQ=='
							: name === 'manifest.json'
								? JSON.stringify(imported)
								: new Uint8Array([1]),
				}),
			}),
		},
		'@/hooks/stores/playbackContextStore': {
			restorePlaybackContextState() {
				restarted = true
			},
		},
		'@/lib/db/db': {
			expoDb,
			restoreDatabase: expoDb,
			libraryRestoreGate: {
				drain: async () => {},
				resume() {},
				requireRestart() {},
			},
		},
		'@/utils/log': { extend: () => ({ info() {}, warning() {} }) },
		'@/utils/mmkv': {
			storage: {
				getString: (key) => values.get(key),
				set(key, value) {
					if (failPreferences && value === 'imported')
						throw new Error('storage failed')
					values.set(key, value)
				},
				remove: (key) => values.delete(key),
			},
		},
		'./preferences': {
			exportPreferences: () => '{}',
			mergePreferences: () => 'imported',
			portableNativePreferences: () => ({}),
		},
		'./types': { BACKUP_VERSION: 3 },
		'./upgrade': { upgradeBackupSchema: async () => {} },
		'./merge': { mergeLibraryDatabases() {} },
	}
	const { restoreBackup } = new vm.Script(
		`${raw}\n;({restoreBackup})`,
	).runInNewContext({ imports: modules })
	return {
		restoreBackup,
		files,
		restoredCovers,
		state: () => ({
			live,
			commits,
			restarted,
			settings: values.get('app-storage'),
		}),
	}
}

void test('corrupt staged database never touches live database or preferences', async () => {
	const h = harness({ invalid: true })
	await assert.rejects(h.restoreBackup('archive'), /完整性/)
	assert.deepEqual(h.state(), {
		live: 'original',
		commits: 0,
		restarted: false,
		settings: '{"local":"preserved"}',
	})
})

void test('preference failure rolls back live database and retains original settings', async () => {
	const h = harness({ failPreferences: true })
	await assert.rejects(h.restoreBackup('archive'), /storage failed/)
	assert.deepEqual(h.state(), {
		live: 'original',
		commits: 2,
		restarted: false,
		settings: '{"local":"preserved"}',
	})
})

void test('successful restore retains open shared database and requires state reload', async () => {
	const h = harness()
	await h.restoreBackup('archive')
	assert.deepEqual(h.state(), {
		live: 'imported',
		commits: 1,
		restarted: true,
		settings: 'imported',
	})
})

void test('owned artwork restores into a managed directory and remaps the database reference', async () => {
	const h = harness({ artwork: true })
	await h.restoreBackup('archive')
	assert.match(
		h.restoredCovers[0],
		/^document\/covers\/import-\d+\/[a-f0-9]{64}\.img$/,
	)
	assert.equal(h.files.has(h.restoredCovers[0]), true)
})

void test('corrupt artwork is rejected before touching the live database', async () => {
	const h = harness({ artwork: true, corruptArtwork: true })
	await assert.rejects(h.restoreBackup('archive'), /封面内容校验失败/)
	assert.equal(h.state().commits, 0)
})

void test('failed restore removes newly staged artwork without changing original references', async () => {
	const h = harness({ artwork: true, failPreferences: true })
	await assert.rejects(h.restoreBackup('archive'), /storage failed/)
	assert.equal(h.files.has(h.restoredCovers[0]), false)
	assert.equal(h.state().live, 'original')
})
