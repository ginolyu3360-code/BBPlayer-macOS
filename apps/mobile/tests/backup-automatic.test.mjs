import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const raw = stripTypeScriptTypes(
	readFileSync(
		new URL('../src/lib/backup/automatic.ts', import.meta.url),
		'utf8',
	),
)
	.replace(
		"import { Directory, File, Paths } from 'expo-file-system'",
		'const { Directory, File, Paths } = imports.fs',
	)
	.replace(
		"import { mmkv } from '@/utils/mmkv-instance'",
		'const mmkv = imports.storage',
	)
	.replace(
		"import { createBackupArtifact } from './export'",
		'const createBackupArtifact = imports.artifact',
	)
	.replace(/^export /gm, '')

function harness({ unchanged = false, fail = false } = {}) {
	const store = new Map(unchanged ? [['backup.daily.fingerprint', 'same']] : [])
	const files = new Set([
		'manual-export.bbplayer',
		...Array.from({ length: 12 }, (_, i) => `automatic-${1000 + i}.bbplayer`),
	])
	let attempts = 0
	class File {
		constructor(_parent, name = 'temporary') {
			this.name = name
		}
		get exists() {
			return true
		}
		copySync(destination) {
			if (fail) throw new Error('disk full')
			files.add(destination.name)
		}
		delete() {
			files.delete(this.name)
		}
	}
	class Directory {
		create() {}
		list() {
			return [...files].map((name) => new File(this, name))
		}
	}
	const imports = {
		fs: { Directory, File, Paths: { document: 'docs' } },
		storage: {
			getString: (key) => store.get(key),
			set: (key, value) => store.set(key, value),
		},
		artifact: async () => {
			attempts++
			return { uri: 'temp', fingerprint: 'same' }
		},
	}
	const api = new vm.Script(`${raw}\n;({createDailyBackup})`).runInNewContext({
		imports,
	})
	return { api, files, store, attempts: () => attempts }
}

void test('daily backup keeps ten automatic archives and preserves manual exports', async () => {
	const h = harness()
	await h.api.createDailyBackup()
	await h.api.createDailyBackup()
	assert.equal(h.attempts(), 1)
	assert.equal(
		[...h.files].filter((name) => name.startsWith('automatic-')).length,
		10,
	)
	assert.equal(h.files.has('manual-export.bbplayer'), true)
})

void test('unchanged contents do not create another archive', async () => {
	const h = harness({ unchanged: true })
	await h.api.createDailyBackup()
	assert.equal(h.files.size, 13)
})

void test('failed write leaves daily marker unset and can be retried', async () => {
	const h = harness({ fail: true })
	await assert.rejects(h.api.createDailyBackup(), /disk full/)
	await assert.rejects(h.api.createDailyBackup(), /disk full/)
	assert.equal(h.attempts(), 2)
	assert.equal(h.store.has('backup.daily.date'), false)
})
