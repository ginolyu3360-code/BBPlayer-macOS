import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import vm from 'node:vm'

import { expoClient } from './helpers/expoDriver.mjs'

const code = stripTypeScriptTypes(
	readFileSync(
		new URL('../src/lib/services/songIdentityService.ts', import.meta.url),
		'utf8',
	),
)
	.replace(/^import .*$/gm, '')
	.replace(/^export /gm, '')
const { replaceSongSource } = new vm.Script(
	`${code}\n;({replaceSongSource})`,
).runInNewContext({ localRecorder: () => undefined })
function fixture() {
	const db = new DatabaseSync(':memory:', {
		enableDoubleQuotedStringLiterals: true,
	})
	const directory = new URL('../drizzle/', import.meta.url)
	for (const file of readdirSync(directory)
		.filter((name) => /^\d+.*\.sql$/.test(name))
		.sort())
		db.exec(readFileSync(new URL(file, directory), 'utf8'))
	db.exec('ALTER TABLE playlist_tracks DROP COLUMN [order]')
	db.exec(
		"PRAGMA foreign_keys=ON; INSERT INTO tracks(id,unique_key,title,source) VALUES(1,'bili:old','Old','bilibili'),(2,'bili:new','New','bilibili'); INSERT INTO playlists(id,title,type) VALUES(1,'Test','local'); INSERT INTO playlist_tracks(playlist_id,track_id,sort_key) VALUES(1,1,'a0'); INSERT INTO play_history(id,track_id,start_time,duration_played,completed) VALUES(1,1,1000,12,0)",
	)
	const adapter = {
		getFirstSync: (sql, args = []) => db.prepare(sql).get(...args),
		getAllSync: (sql, args = []) => db.prepare(sql).all(...args),
		runSync: (sql, args = []) => db.prepare(sql).run(...args),
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
	}
	return { db, adapter }
}

void test('replacement keeps song identity and list position, old history and source remain intact', () => {
	const { db, adapter } = fixture()
	try {
		const original = db
			.prepare("SELECT song_id FROM song_sources WHERE source_key='bili:old'")
			.get().song_id
		const history = db.prepare('SELECT * FROM history_source_snapshots').get()
		assert.equal(replaceSongSource(adapter, 1, 2), original)
		assert.deepEqual(
			{ ...db.prepare('SELECT track_id,sort_key FROM playlist_tracks').get() },
			{ track_id: 2, sort_key: 'a0' },
		)
		assert.deepEqual(
			db.prepare('SELECT * FROM history_source_snapshots').get(),
			history,
		)
		assert.equal(
			db.prepare('SELECT duration_played FROM play_history').get()
				.duration_played,
			12,
		)
		assert.equal(
			db.prepare('SELECT COUNT(*) AS count FROM tracks').get().count,
			2,
		)
		db.exec(
			'INSERT INTO play_history(track_id,start_time,duration_played,completed) VALUES(2,3000,8,0)',
		)
		const total = db
			.prepare(
				'SELECT SUM(h.duration_played) AS duration FROM play_history h JOIN history_source_snapshots s ON s.history_id=h.id WHERE s.song_id=?',
			)
			.get(original)
		assert.equal(total.duration, 20)
		assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		db.close()
	}
})

void test('already used independent source is never silently merged', () => {
	const { db, adapter } = fixture()
	try {
		db.exec(
			'INSERT INTO play_history(track_id,start_time,duration_played,completed) VALUES(2,2000,2,0)',
		)
		assert.throws(() => replaceSongSource(adapter, 1, 2), /独立版本/)
		assert.equal(
			db.prepare('SELECT track_id FROM playlist_tracks').get().track_id,
			1,
		)
		assert.equal(
			db.prepare('SELECT COUNT(*) AS count FROM library_songs').get().count,
			2,
		)
	} finally {
		db.close()
	}
})

async function serviceFor(db, serviceKind = 'track') {
	const { createRequire } = await import('node:module')
	const require = createRequire(new URL('../package.json', import.meta.url))
	const orm = require('drizzle-orm')
	const sqlite = require('drizzle-orm/sqlite-core')
	const { drizzle } = require('drizzle-orm/expo-sqlite/driver')
	const schemaSource = stripTypeScriptTypes(
		readFileSync(new URL('../src/lib/db/schema.ts', import.meta.url), 'utf8'),
	)
	const names = [...schemaSource.matchAll(/export const (\w+)/g)].map(
		(match) => match[1],
	)
	const schemaCode = schemaSource
		.replace(
			/^import \{([\s\S]*?)\} from '([^']+)'/gm,
			(_, fields, id) =>
				`const {${fields.replaceAll(' as ', ': ')}} = imports[${JSON.stringify(id)}]`,
		)
		.replace(/^export /gm, '')
	const schema = new vm.Script(
		`${schemaCode}\n;({${names.join(',')}})`,
	).runInNewContext({
		imports: { 'drizzle-orm': orm, 'drizzle-orm/sqlite-core': sqlite },
	})
	const driver = drizzle(expoClient(db), { schema })
	const bridgeSource = stripTypeScriptTypes(
		readFileSync(
			new URL('../src/lib/sync/drizzleRecording.ts', import.meta.url),
			'utf8',
		),
	)
		.replace(/^import .*$/gm, '')
		.replace(/^export /gm, '')
	const { drizzleSyncDatabase } = new vm.Script(
		`${bridgeSource};({drizzleSyncDatabase})`,
	).runInNewContext({ sql: orm.sql })

	const modules = {
		'@/lib/sync/drizzleRecording': { drizzleSyncDatabase },
		'@/lib/sync/localRecording': {
			localRecorder: () => undefined,
			playlistState: () => ({ network: [] }),
		},
		'@sentry/react-native': { startSpan: (_, callback) => callback() },
		'drizzle-orm': orm,
		neverthrow: require('neverthrow'),
		'@/lib/db/db': driver,
		'@/lib/db/schema': schema,
		'@/lib/errors': { ServiceError: Error },
		'@/lib/errors/service': { DatabaseError: Error },
		'@/utils/log': { extend: () => ({ warning() {} }) },
		'./genKey': () => {},
		'./trackService': { trackService: {} },
		'fractional-indexing': require('fractional-indexing'),
	}
	const raw = stripTypeScriptTypes(
		readFileSync(
			new URL(`../src/lib/services/${serviceKind}Service.ts`, import.meta.url),
			'utf8',
		),
		{ mode: 'transform' },
	)
		.replace(
			/^import \* as (\w+) from '([^']+)'/gm,
			(_, name, id) => `const ${name} = imports[${JSON.stringify(id)}]`,
		)
		.replace(
			/^import \{([\s\S]*?)\} from '([^']+)'/gm,
			(_, fields, id) =>
				`const {${fields.replaceAll(' as ', ': ')}} = imports[${JSON.stringify(id)}]`,
		)
		.replace(
			/^import (\w+) from '([^']+)'/gm,
			(_, name, id) => `const ${name} = imports[${JSON.stringify(id)}]`,
		)
		.replace(/^import '[^']+';?$/gm, '')
		.replace(/^export /gm, '')
	return new vm.Script(`${raw}\n;${serviceKind}Service`).runInNewContext({
		imports: modules,
	})
}

void test('actual history ranking queries combine old and new sources under active source', async () => {
	const { db, adapter } = fixture()
	try {
		db.exec(
			"INSERT INTO bilibili_metadata(track_id,bvid,cid,is_multi_page) VALUES(1,'BVold',1,1),(2,'BVnew',2,1)",
		)
		replaceSongSource(adapter, 1, 2)
		db.exec(
			`UPDATE play_history SET start_time=${Date.now()}; INSERT INTO play_history(track_id,start_time,duration_played,completed) VALUES(2,${Date.now()},8,0)`,
		)
		const service = await serviceFor(db)
		const countResult = await service.getPlayCountHistoryPaginated({
			limit: 10,
			onlyCompleted: false,
		})
		assert.equal(
			countResult.isOk(),
			true,
			String(countResult.error?.cause?.stack ?? countResult.error),
		)
		assert.equal(countResult.value.items.length, 1)
		assert.equal(countResult.value.items[0].track.id, 2)
		assert.equal(countResult.value.items[0].playCount, 2)
		const durationResult = await service.getMostPlayedTracksInLastDays({
			limit: 10,
			days: 7,
		})
		assert.equal(
			durationResult.isOk(),
			true,
			String(durationResult.error?.cause?.stack ?? durationResult.error),
		)
		assert.equal(durationResult.value[0].track.id, 2)
		assert.equal(durationResult.value[0].totalDuration, 20)
	} finally {
		db.close()
	}
})

void test('changing back to a retained source collapses duplicate slots to the earliest position', () => {
	const { db, adapter } = fixture()
	try {
		replaceSongSource(adapter, 1, 2)
		db.exec(
			"INSERT INTO playlist_tracks(playlist_id,track_id,sort_key) VALUES(1,1,'Z0')",
		)
		replaceSongSource(adapter, 2, 1)
		assert.deepEqual(
			{ ...db.prepare('SELECT track_id,sort_key FROM playlist_tracks').get() },
			{ track_id: 1, sort_key: 'a0' },
		)
		assert.equal(
			db.prepare('SELECT COUNT(*) AS count FROM playlist_tracks').get().count,
			1,
		)
		assert.equal(
			db.prepare('SELECT item_count FROM playlists').get().item_count,
			1,
		)
	} finally {
		db.close()
	}
})

void test('a failed source selection update rolls back song ownership and all memberships', () => {
	const { db, adapter } = fixture()
	try {
		db.exec(
			"CREATE TRIGGER reject_source_change BEFORE UPDATE OF active_source_key ON library_songs WHEN NEW.active_source_key='bili:new' BEGIN SELECT RAISE(ABORT,'simulated save failure'); END",
		)
		assert.throws(
			() => replaceSongSource(adapter, 1, 2),
			/simulated save failure/,
		)
		assert.equal(
			db.prepare('SELECT track_id FROM playlist_tracks').get().track_id,
			1,
		)
		assert.equal(
			db.prepare('SELECT COUNT(*) AS count FROM library_songs').get().count,
			2,
		)
		assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		db.close()
	}
})

void test('stale source imports add only the selected library source and retain membership queries', async () => {
	const { db, adapter } = fixture()
	try {
		replaceSongSource(adapter, 1, 2)
		db.exec("INSERT INTO playlists(id,title,type) VALUES(2,'Import','local')")
		const service = await serviceFor(db, 'playlist')
		const result = await service.addManyTracksToLocalPlaylist(2, [1, 2])
		assert.equal(
			result.isOk(),
			true,
			String(result.error?.cause?.stack ?? result.error),
		)
		assert.equal(
			db
				.prepare(
					'SELECT COUNT(*) AS count FROM playlist_tracks WHERE playlist_id=2',
				)
				.get().count,
			1,
		)
		assert.equal(
			db
				.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id=2')
				.get().track_id,
			2,
		)
		const containing = await service.getLocalPlaylistsContainingTrackById(1)
		assert.equal(
			containing.isOk(),
			true,
			String(containing.error?.cause?.stack ?? containing.error),
		)
		assert.equal(containing.value.length, 2)
		const replaced = await service.replacePlaylistAllTracks(2, [1, 2])
		assert.equal(
			replaced.isOk(),
			true,
			String(replaced.error?.cause?.stack ?? replaced.error),
		)
		assert.equal(
			db
				.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id=2')
				.get().track_id,
			2,
		)
	} finally {
		db.close()
	}
})
