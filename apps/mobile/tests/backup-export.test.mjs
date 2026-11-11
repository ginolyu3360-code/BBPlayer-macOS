import assert from 'node:assert/strict'
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	existsSync,
	rmSync,
} from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import vm from 'node:vm'
const require = createRequire(new URL('../package.json', import.meta.url))
const CryptoJS = require('crypto-js'),
	JSZip = require('jszip')
const source = stripTypeScriptTypes(
	readFileSync(new URL('../src/lib/backup/export.ts', import.meta.url), 'utf8'),
)
	.replace(
		/^import[\s\S]*?from ['"]([^'"]+)['"];?$/gm,
		(_, id) =>
			`const ${{ '@bbplayer/orpheus': '{ Orpheus }', 'crypto-js': 'CryptoJS', 'expo-file-system': '{ Directory, File, Paths }', 'expo-sqlite': 'SQLite', jszip: 'JSZip', '@/lib/db/db': '{ expoDb }', '@/utils/log': 'log', '@/utils/mmkv': '{ storage }', '@/utils/startup-screen': '{ getStartupScreen }', './preferences': '{ exportPreferences, portableNativePreferences }', './types': '{ BACKUP_VERSION }' }[id]} = imports[${JSON.stringify(id)}]`,
	)
	.replace(/^export /gm, '')
void test('portable export carries owned cover bytes, removes sync runtime and fingerprints only library content', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'bbplayer-export-'))
	const documents = path.join(root, 'documents'),
		cache = path.join(root, 'cache')
	mkdirSync(path.join(documents, 'covers', 'tracks'), { recursive: true })
	mkdirSync(cache)
	class File {
		constructor(...parts) {
			this.path = path.join(
				...parts.map((part) =>
					typeof part === 'string'
						? part.startsWith('file://')
							? fileURLToPath(part)
							: part
						: part.path,
				),
			)
			this.uri = pathToFileURL(this.path).href
			this.name = path.basename(this.path)
		}
		get exists() {
			return existsSync(this.path)
		}
		write(data) {
			writeFileSync(this.path, data)
		}
		bytesSync() {
			return new Uint8Array(readFileSync(this.path))
		}
		base64Sync() {
			return readFileSync(this.path).toString('base64')
		}
		delete() {
			rmSync(this.path)
		}
	}
	class Directory extends File {
		list() {
			return readdirSync(this.path).map((name) => new File(this, name))
		}
	}
	const live = new DatabaseSync(path.join(root, 'live.db'), {
		enableDoubleQuotedStringLiterals: true,
	})
	try {
		const migrationDir = new URL('../drizzle/', import.meta.url)
		for (const filename of readdirSync(migrationDir)
			.filter((name) => /^\d+.*\.sql$/.test(name))
			.sort())
			live.exec(readFileSync(new URL(filename, migrationDir), 'utf8'))
		const cover = new File(documents, 'covers', 'tracks', 'owned.png')
		cover.write(new Uint8Array([137, 80, 78, 71]))
		live
			.prepare(
				"INSERT INTO tracks(unique_key,title,source,cover_url) VALUES('bilibili::BV1','Song','bilibili',?)",
			)
			.run(cover.uri)
		live.exec(
			"INSERT INTO sync_operation(id,actor,sequence,payload) VALUES('runtime1','actor',1,'private-runtime-marker')",
		)
		let copies = 0
		const api = new vm.Script(
			`${source};({createBackupArtifact})`,
		).runInNewContext({
			imports: {
				'@bbplayer/orpheus': {
					Orpheus: { exportData: () => ({ playerQueue: {} }) },
				},
				'crypto-js': CryptoJS,
				jszip: JSZip,
				'expo-file-system': {
					File,
					Directory,
					Paths: { cache, document: documents },
				},
				'expo-sqlite': {
					deserializeDatabaseSync(bytes) {
						const location = path.join(root, `staged-${copies++}.db`)
						writeFileSync(location, bytes)
						const db = new DatabaseSync(location)
						return {
							execSync: (sql) => db.exec(sql),
							runSync: (sql, args) => db.prepare(sql).run(...args),
							getAllSync: (sql) => db.prepare(sql).all(),
							serializeSync: () => new Uint8Array(readFileSync(location)),
							closeSync: () => db.close(),
						}
					},
				},
				'@/lib/db/db': { expoDb: { execSync: (sql) => live.exec(sql) } },
				'@/utils/log': { extend: () => ({ debug() {}, info() {} }) },
				'@/utils/mmkv': { storage: { getString: () => '{}' } },
				'@/utils/startup-screen': { getStartupScreen: () => 'home' },
				'./preferences': {
					exportPreferences: () => '{}',
					portableNativePreferences: () => ({}),
				},
				'./types': { BACKUP_VERSION: 3 },
			},
		})
		const first = await api.createBackupArtifact()
		const zip = await JSZip.loadAsync(new File(first.uri).bytesSync())
		const artworks = Object.keys(zip.files).filter((name) =>
			name.endsWith('.img'),
		)
		assert.equal(artworks.length, 1)
		assert.deepEqual(
			await zip.file(artworks[0]).async('uint8array'),
			cover.bytesSync(),
		)
		const databaseBytes = await zip.file('database.db').async('uint8array')
		assert.equal(
			Buffer.from(databaseBytes).includes(
				Buffer.from('private-runtime-marker'),
			),
			false,
		)
		const inspection = path.join(root, 'inspection.db')
		writeFileSync(inspection, databaseBytes)
		const inspected = new DatabaseSync(inspection)
		try {
			assert.match(
				inspected.prepare('SELECT cover_url FROM tracks').get().cover_url,
				/^backup-artwork:\/\/[a-f0-9]{64}\.img$/,
			)
			assert.equal(
				inspected.prepare('SELECT COUNT(*) AS n FROM sync_operation').get().n,
				0,
			)
		} finally {
			inspected.close()
		}
		live.exec("UPDATE sync_operation SET payload='different-runtime-marker'")
		const second = await api.createBackupArtifact()
		assert.equal(first.fingerprint, second.fingerprint)
	} finally {
		live.close()
		rmSync(root, { recursive: true, force: true })
	}
})
