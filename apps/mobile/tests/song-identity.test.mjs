import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const directory = new URL('../drizzle/', import.meta.url)
const identitySQL = readFileSync(
	new URL('0023_library_song_identity.sql', directory),
	'utf8',
)
function legacyDatabase() {
	const db = new DatabaseSync(':memory:', {
		enableDoubleQuotedStringLiterals: true,
	})
	for (const file of readdirSync(directory)
		.filter((name) => /^\d+.*\.sql$/.test(name) && !name.startsWith('0023'))
		.sort())
		db.exec(readFileSync(new URL(file, directory), 'utf8'))
	db.exec(
		"INSERT INTO tracks(id,unique_key,title,source) VALUES(1,'local:a','Original','local'),(2,'local:b','Original','local'); INSERT INTO local_metadata(track_id,local_path) VALUES(1,'/music/a.flac'); INSERT INTO play_history(id,track_id,start_time,duration_played,completed) VALUES(1,1,1000,5,0)",
	)
	return db
}

void test('migration gives same-title sources different valid stable UUIDs and labels legacy evidence', () => {
	const db = legacyDatabase()
	try {
		db.exec(identitySQL)
		const songs = db.prepare('SELECT id FROM library_songs').all()
		assert.equal(songs.length, 2)
		assert.notEqual(songs[0].id, songs[1].id)
		assert.match(
			songs[0].id,
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
		)
		assert.equal(
			db.prepare('SELECT evidence FROM history_source_snapshots').get()
				.evidence,
			'observedAtMigration',
		)
		assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		db.close()
	}
})

void test('new tracks and history get identity automatically, checkpoint updates never rewrite source snapshots', () => {
	const db = legacyDatabase()
	try {
		db.exec(identitySQL)
		db.exec(
			"INSERT INTO tracks(id,unique_key,title,source) VALUES(3,'local:c','Before','local'); INSERT INTO play_history(id,track_id,start_time,duration_played,completed) VALUES(2,3,2000,2,0)",
		)
		const before = db
			.prepare('SELECT * FROM history_source_snapshots WHERE history_id=2')
			.get()
		db.exec(
			"UPDATE tracks SET title='After' WHERE id=3; UPDATE play_history SET duration_played=20 WHERE id=2",
		)
		const after = db
			.prepare('SELECT * FROM history_source_snapshots WHERE history_id=2')
			.get()
		assert.deepEqual(after, before)
		assert.equal(after.evidence, 'recordedAtPlayback')
		assert.equal(JSON.parse(after.payload).title, 'Before')
		assert.equal(
			db.prepare('SELECT COUNT(*) AS count FROM song_sources').get().count,
			3,
		)
	} finally {
		db.close()
	}
})

void test('existing source deletion remains supported without destroying stable song identity', () => {
	const db = legacyDatabase()
	try {
		db.exec(identitySQL)
		const id = db
			.prepare("SELECT song_id FROM song_sources WHERE source_key='local:a'")
			.get().song_id
		db.exec('PRAGMA foreign_keys=ON; DELETE FROM tracks WHERE id=1')
		assert.equal(
			db
				.prepare('SELECT active_source_key FROM library_songs WHERE id=?')
				.get(id).active_source_key,
			null,
		)
		assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		db.close()
	}
})
