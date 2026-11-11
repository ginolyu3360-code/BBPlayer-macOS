import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync, readdirSync } from 'node:fs'
import { stripTypeScriptTypes, createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import vm from 'node:vm'
const require = createRequire(new URL('../package.json', import.meta.url))
const load = (name, bindings = {}) => {
	const source = stripTypeScriptTypes(
		readFileSync(
			new URL(`../src/lib/sync/${name}.ts`, import.meta.url),
			'utf8',
		),
		{ mode: 'transform' },
	)
		.replace(/^import[\s\S]*?from ['"][^'"]+['"];?$/gm, '')
		.replace(/^export /gm, '')
	return new vm.Script(
		source +
			`;({${name === 'protocol' ? 'canonicalJSON,validateSyncOperation,mobileSourceKey' : name === 'engine' ? 'SyncEngine,syncConflicts' : 'projectSyncLibrary'}})`,
	).runInNewContext({ ...bindings, Buffer, URL })
}
const protocol = load('protocol'),
	engineModule = load('engine', protocol)
const orderSource = stripTypeScriptTypes(
	readFileSync(new URL('../src/lib/sync/order.ts', import.meta.url), 'utf8'),
)
	.replace(/^import .*$/gm, '')
	.replace(/^export /gm, '')
const { causalNetworkOrder } = new vm.Script(
	orderSource + ';({causalNetworkOrder})',
).runInNewContext()
const { projectSyncLibrary } = load('libraryProjection', {
	...protocol,
	...engineModule,
	causalNetworkOrder,
	generateKeyBetween: require('fractional-indexing').generateKeyBetween,
})
const seed = JSON.parse(
	readFileSync(
		new URL(
			'../../macos/Tests/BBPlayerCoreTests/Fixtures/sync-v1.json',
			import.meta.url,
		),
		'utf8',
	),
)
function fixture() {
	const db = new DatabaseSync(':memory:', {
		enableDoubleQuotedStringLiterals: true,
	})
	const dir = new URL('../drizzle/', import.meta.url)
	for (const name of readdirSync(dir)
		.filter((filename) => /^\d+.*\.sql$/.test(filename))
		.sort())
		db.exec(readFileSync(new URL(name, dir), 'utf8'))
	db.exec('ALTER TABLE playlist_tracks DROP COLUMN [order]')
	const api = {
		getAllSync: (sql, args = []) => db.prepare(sql).all(...args),
		getFirstSync: (sql, args = []) => db.prepare(sql).get(...args),
		runSync: (sql, args = []) => {
			const r = db.prepare(sql).run(...args)
			return { ...r, lastInsertRowId: Number(r.lastInsertRowid) }
		},
		withTransactionSync(body) {
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
	let counter = 500
	const engine = new engineModule.SyncEngine(
		api,
		'00000000-0000-0000-0000-000000000002',
		() => `00000000-0000-0000-0000-${String(counter++).padStart(12, '0')}`,
		(heads, historicalSources, historicalOrders) =>
			projectSyncLibrary(api, heads, historicalSources, historicalOrders),
	)
	return { db, engine }
}
void test('Swift seed projects real Android tables without splitting default source identity, and retains local audio on remote deletion', () => {
	const h = fixture()
	try {
		h.engine.applySeed(seed)
		const track = h.db
			.prepare(
				'SELECT t.id,t.unique_key,b.cid,b.is_multi_page FROM tracks t JOIN bilibili_metadata b ON b.track_id=t.id',
			)
			.get()
		assert.equal(track.unique_key, 'bilibili::fixture')
		assert.equal(track.cid, 77)
		assert.equal(track.is_multi_page, 0)
		const list = h.db.prepare('SELECT id FROM playlists').get().id
		h.db.exec(
			"INSERT INTO tracks(id,unique_key,title,source) VALUES(99,'local::fixture','Original file','local'); INSERT INTO local_metadata VALUES(99,'content://original');",
		)
		h.db
			.prepare(
				"INSERT INTO playlist_tracks(playlist_id,track_id,sort_key) VALUES(?,99,'a1')",
			)
			.run(list)
		h.engine.record(seed.operations[1].entity, 'deleted', { flag: true })
		assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM playlists').get().n, 1)
		assert.deepEqual(
			h.db
				.prepare('SELECT track_id FROM playlist_tracks')
				.all()
				.map((row) => row.track_id),
			[99],
		)
		assert.equal(
			h.db.prepare('SELECT local_path FROM local_metadata').get().local_path,
			'content://original',
		)
		assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), [])
	} finally {
		h.db.close()
	}
})
void test('remote source replacement preserves old source history and stable song, while source collisions roll back', () => {
	const h = fixture()
	try {
		h.engine.applySeed(seed)
		const old = h.db.prepare('SELECT id FROM tracks').get().id
		h.db
			.prepare(
				'INSERT INTO play_history(track_id,start_time,duration_played,completed) VALUES(?,1000,12,0)',
			)
			.run(old)
		const history = h.db
			.prepare('SELECT payload FROM history_source_snapshots')
			.get().payload
		const source = {
			songID: seed.operations[0].value.source.songID,
			track: {
				...seed.operations[0].value.source.track,
				id: 'bilibili:next:video',
				bvid: 'next',
				cid: 88,
				title: 'New source',
			},
		}
		h.engine.record(seed.operations[0].entity, 'source', { source })
		assert.equal(
			h.db.prepare('SELECT COUNT(*) AS n FROM library_songs').get().n,
			1,
		)
		assert.equal(
			h.db.prepare('SELECT active_source_key FROM library_songs').get()
				.active_source_key,
			'bilibili::next',
		)
		assert.equal(
			h.db.prepare('SELECT payload FROM history_source_snapshots').get()
				.payload,
			history,
		)
		assert.equal(
			h.db
				.prepare(
					'SELECT t.unique_key FROM playlist_tracks p JOIN tracks t ON t.id=p.track_id',
				)
				.get().unique_key,
			'bilibili::next',
		)
		h.engine.record('source:bilibili:fixture:video', 'lyrics', {
			lyrics: {
				source: 'manual',
				offset: 0,
				lines: [{ start: 0, end: 2, text: 'Original source lyric', words: [] }],
			},
		})
		const fresh = fixture()
		try {
			fresh.engine.applySeed(h.engine.exportSeed())
			assert.equal(
				fresh.db.prepare('SELECT active_source_key FROM library_songs').get()
					.active_source_key,
				'bilibili::next',
			)
			assert.equal(
				fresh.db
					.prepare(
						"SELECT COUNT(*) AS n FROM song_sources WHERE source_key='bilibili::fixture'",
					)
					.get().n,
				1,
			)
			assert.equal(
				fresh.db
					.prepare(
						"SELECT COUNT(*) AS n FROM sync_lyric WHERE source_key='bilibili::fixture'",
					)
					.get().n,
				1,
			)
			assert.equal(
				fresh.db.prepare('SELECT COUNT(*) AS n FROM play_history').get().n,
				0,
			)
		} finally {
			fresh.db.close()
		}
		const count = h.db
			.prepare('SELECT COUNT(*) AS n FROM sync_operation')
			.get().n
		assert.throws(
			() =>
				h.engine.record('song:00000000-0000-0000-0000-000000000999', 'source', {
					source: { ...source, songID: '00000000-0000-0000-0000-000000000999' },
				}),
			/ownership/,
		)
		assert.equal(
			h.db.prepare('SELECT COUNT(*) AS n FROM sync_operation').get().n,
			count,
		)
	} finally {
		h.db.close()
	}
})
