import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import vm from 'node:vm'
const require = createRequire(new URL('../package.json', import.meta.url))
const { generateKeyBetween } = require('fractional-indexing')
const source = stripTypeScriptTypes(
	readFileSync(new URL('../src/lib/backup/merge.ts', import.meta.url), 'utf8'),
)
	.replace(/^import .* from .*$/gm, '')
	.replace(/^export /gm, '')
const mergeLibraryDatabases = new vm.Script(
	`${source};mergeLibraryDatabases`,
).runInNewContext({ generateKeyBetween })
function fixture(before = Infinity) {
	const db = new DatabaseSync(':memory:', {
		enableDoubleQuotedStringLiterals: true,
	})
	const directory = new URL('../drizzle/', import.meta.url)
	for (const name of readdirSync(directory)
		.filter(
			(entryName) =>
				/^\d+.*\.sql$/.test(entryName) &&
				Number(entryName.slice(0, 4)) < before,
		)
		.sort())
		db.exec(readFileSync(new URL(name, directory), 'utf8'))
	db.exec('ALTER TABLE playlist_tracks DROP COLUMN [order]')
	const api = {
		getAllSync: (sql, args = []) => db.prepare(sql).all(...args),
		getFirstSync: (sql, args = []) => db.prepare(sql).get(...args),
		runSync: (sql, args = []) => {
			const r = db.prepare(sql).run(...args)
			return { ...r, lastInsertRowId: Number(r.lastInsertRowid) }
		},
		execSync: (sql) => db.exec(sql),
		withTransactionSync: (body) => {
			db.exec('BEGIN')
			try {
				body()
				db.exec('COMMIT')
			} catch (error) {
				db.exec('ROLLBACK')
				throw error
			}
		},
	}
	return { db, api }
}
function track(db, id, key, song, title = key) {
	db.prepare(
		"INSERT INTO tracks(id,unique_key,title,source) VALUES(?,?,?,'bilibili')",
	).run(id, key, title)
	const generated = db
		.prepare('SELECT song_id FROM song_sources WHERE source_key=?')
		.get(key).song_id
	db.prepare('UPDATE library_songs SET id=? WHERE id=?').run(song, generated)
	db.prepare('UPDATE song_sources SET song_id=? WHERE source_key=?').run(
		song,
		key,
	)
	db.prepare(
		'INSERT INTO bilibili_metadata(track_id,bvid,is_multi_page) VALUES(?,?,0)',
	).run(id, key)
}
function playlist(db, id, identity) {
	db.prepare(
		"INSERT INTO playlists(id,title,type) VALUES(?,'List','local')",
	).run(id)
	db.prepare('UPDATE playlist_identities SET id=? WHERE playlist_id=?').run(
		identity,
		id,
	)
}
// Disable immediate foreign keys only while changing fixture identities; production never does this.
function setup(db, body) {
	db.exec('PRAGMA foreign_keys=OFF')
	body()
	db.exec('PRAGMA foreign_keys=ON')
}
void test('merge remaps device IDs, preserves order and stable identities, appends once, and deduplicates history', () => {
	const a = fixture(),
		b = fixture()
	try {
		setup(a.db, () => {
			track(a.db, 1, 'BV1', 'song1', 'Current')
			playlist(a.db, 1, 'list1')
		})
		setup(b.db, () => {
			track(b.db, 9, 'BV1', 'song1', 'Imported')
			track(b.db, 10, 'BV2', 'song2')
			playlist(b.db, 7, 'list1')
		})
		a.db.exec(
			"INSERT INTO playlist_tracks(playlist_id,track_id,sort_key,created_at) VALUES(1,1,'a0',100); INSERT INTO play_history VALUES(1,1,1000,4,0,1000)",
		)
		b.db.exec(
			"INSERT INTO playlist_tracks(playlist_id,track_id,sort_key,created_at) VALUES(7,10,'a1',100),(7,9,'a0',100); INSERT INTO play_history VALUES(8,9,1000,8,1,1000)",
		)
		mergeLibraryDatabases(a.api, b.api)
		mergeLibraryDatabases(a.api, b.api)
		assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM playlists').get().n, 1)
		assert.deepEqual(
			a.db
				.prepare(
					'SELECT t.unique_key FROM playlist_tracks p JOIN tracks t ON t.id=p.track_id ORDER BY sort_key DESC',
				)
				.all()
				.map((r) => r.unique_key),
			['BV1', 'BV2'],
		)
		assert.equal(
			a.db.prepare("SELECT title FROM tracks WHERE unique_key='BV1'").get()
				.title,
			'Current',
		)
		assert.deepEqual(
			{
				...a.db
					.prepare('SELECT duration_played,completed FROM play_history')
					.get(),
			},
			{ duration_played: 8, completed: 1 },
		)
		assert.deepEqual(a.db.prepare('PRAGMA foreign_key_check').all(), [])
		mergeLibraryDatabases(a.api, b.api, true)
		assert.equal(
			a.db.prepare("SELECT title FROM tracks WHERE unique_key='BV1'").get()
				.title,
			'Imported',
		)
	} finally {
		a.db.close()
		b.db.close()
	}
})
void test('same source owned by another song fails before staged changes', () => {
	const a = fixture(),
		b = fixture()
	try {
		setup(a.db, () => track(a.db, 1, 'BV1', 'song1'))
		setup(b.db, () => track(b.db, 2, 'BV1', 'different'))
		assert.throws(() => mergeLibraryDatabases(a.api, b.api), /不同歌曲身份/)
		assert.equal(
			a.db.prepare('SELECT COUNT(*) AS n FROM library_songs').get().n,
			1,
		)
	} finally {
		a.db.close()
		b.db.close()
	}
})
void test('playlist identities backfill existing rows, survive edits and cascade with deletion', () => {
	const h = fixture(24)
	try {
		h.db.exec(
			"INSERT INTO playlists(id,title,type) VALUES(1,'A','local'),(2,'A','local')",
		)
		h.db.exec(
			readFileSync(
				new URL('../drizzle/0024_playlist_identity.sql', import.meta.url),
				'utf8',
			),
		)
		const first = h.db
			.prepare('SELECT id FROM playlist_identities WHERE playlist_id=1')
			.get().id
		assert.match(first, /^[0-9a-f-]{36}$/)
		assert.notEqual(
			first,
			h.db
				.prepare('SELECT id FROM playlist_identities WHERE playlist_id=2')
				.get().id,
		)
		h.db.exec("UPDATE playlists SET title='B' WHERE id=1")
		assert.equal(
			first,
			h.db
				.prepare('SELECT id FROM playlist_identities WHERE playlist_id=1')
				.get().id,
		)
		h.db.exec('DELETE FROM playlists WHERE id=1')
		assert.equal(
			h.db.prepare('SELECT COUNT(*) AS n FROM playlist_identities').get().n,
			1,
		)
	} finally {
		h.db.close()
	}
})
