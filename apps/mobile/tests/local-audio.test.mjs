import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import vm from 'node:vm'

const raw = stripTypeScriptTypes(
	readFileSync(
		new URL('../src/lib/services/localAudioService.ts', import.meta.url),
		'utf8',
	),
)
	.replace(
		/^import \{([\s\S]*?)\} from '([^']+)'/gm,
		(_, fields, id) => `const {${fields}} = imports[${JSON.stringify(id)}]`,
	)
	.replace(/^export /gm, '')
function fixture({ failBackup = false } = {}) {
	const db = new DatabaseSync(':memory:', {
		enableDoubleQuotedStringLiterals: true,
	})
	const directory = new URL('../drizzle/', import.meta.url)
	for (const file of readdirSync(directory)
		.filter((name) => /^\d+.*\.sql$/.test(name))
		.sort())
		db.exec(readFileSync(new URL(file, directory), 'utf8'))
	db.exec(
		"INSERT INTO tracks(id,unique_key,title,source,duration) VALUES(1,'local:stable','Keep title','local',10); INSERT INTO local_metadata(track_id,local_path) VALUES(1,'content://audio/old'); INSERT INTO play_history(id,track_id,start_time,duration_played,completed) VALUES(1,1,1000,4,0)",
	)
	let backups = 0
	const calls = []
	const imports = {
		'@bbplayer/native': {
			readAudioFileAsync: async (uri, retain) => {
				calls.push({ uri, retain })
				return {
					uri,
					duration: 12,
					title: 'Embedded title',
					artist: 'Embedded artist',
				}
			},
		},
		'@/lib/backup/automatic': {
			createProtectionBackup: async () => {
				if (failBackup) throw new Error('disk full')
				backups++
			},
		},
		'@/lib/db/db': {
			expoDb: {
				runSync(sql, args) {
					return db.prepare(sql).run(...args)
				},
				withTransactionSync(callback) {
					db.exec('BEGIN')
					try {
						callback()
						db.exec('COMMIT')
					} catch (error) {
						db.exec('ROLLBACK')
						throw error
					}
				},
			},
		},
		'@/utils/neverthrow-utils': { returnOrThrowAsync: async (value) => value },
		'./artistService': {
			artistService: { findOrCreateArtist: async () => ({ id: 7 }) },
		},
		'./trackService': {
			trackService: { findOrCreateTrack: async (payload) => payload },
		},
	}
	const api = new vm.Script(
		`${raw}\n;({relinkLocalAudio,importLocalAudio})`,
	).runInNewContext({ imports })
	return { db, api, calls, backups: () => backups }
}

void test('relink changes only location/duration, retaining identity, title and old source history', async () => {
	const h = fixture()
	try {
		const song = h.db.prepare('SELECT id FROM library_songs').get().id
		const history = h.db
			.prepare('SELECT payload FROM history_source_snapshots')
			.get().payload
		await h.api.relinkLocalAudio(
			{ id: 1, source: 'local' },
			'content://audio/new',
		)
		assert.equal(h.db.prepare('SELECT id FROM library_songs').get().id, song)
		assert.equal(
			h.db.prepare('SELECT title FROM tracks').get().title,
			'Keep title',
		)
		assert.equal(
			h.db.prepare('SELECT local_path FROM local_metadata').get().local_path,
			'content://audio/new',
		)
		assert.equal(
			h.db.prepare('SELECT payload FROM history_source_snapshots').get()
				.payload,
			history,
		)
		assert.equal(h.backups(), 1)
		assert.equal(h.calls[0].retain, true)
	} finally {
		h.db.close()
	}
})

void test('failed protective backup blocks relinking and preserves original file reference', async () => {
	const h = fixture({ failBackup: true })
	try {
		await assert.rejects(
			h.api.relinkLocalAudio({ id: 1, source: 'local' }, 'content://audio/new'),
			/disk full/,
		)
		assert.equal(
			h.db.prepare('SELECT local_path FROM local_metadata').get().local_path,
			'content://audio/old',
		)
	} finally {
		h.db.close()
	}
})

void test('import uses embedded metadata and keeps the selected URI as the audio reference', async () => {
	const h = fixture()
	try {
		const payload = await h.api.importLocalAudio(
			'content://audio/original',
			'fallback.flac',
		)
		assert.equal(payload.localMetadata.localPath, 'content://audio/original')
		assert.equal(payload.title, 'Embedded title')
		assert.equal(payload.artistId, 7)
		assert.equal(payload.duration, 12)
	} finally {
		h.db.close()
	}
})
