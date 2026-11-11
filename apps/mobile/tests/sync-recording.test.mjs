import assert from 'node:assert/strict'
import { test } from 'node:test'

import { syncServiceFixture } from './helpers/syncServiceFixture.mjs'

const addTracks = (db) =>
	db.exec(
		"INSERT INTO tracks(id,unique_key,title,source,duration) VALUES(1,'bilibili::first','First','bilibili',180),(2,'bilibili::second::88','Second','bilibili',240),(3,'local::private-local','Private local','local',60); INSERT INTO bilibili_metadata(track_id,bvid,cid,is_multi_page) VALUES(1,'first',77,0),(2,'second',88,1); INSERT INTO local_metadata(track_id,local_path) VALUES(3,'file:///private/media/fixture.wav')",
	)
const unwrap = (result) => {
	assert.equal(
		result.isOk(),
		true,
		String(result.error?.cause?.stack ?? result.error),
	)
	return result.value
}
const ids = (h, playlist) =>
	h.db
		.prepare(
			'SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY sort_key DESC',
		)
		.all(playlist)
		.map((row) => row.track_id)

void test('actual synchronous Drizzle playlist services capture membership/order/title/delete in the same transaction', async () => {
	const h = syncServiceFixture(),
		peer = syncServiceFixture()
	try {
		addTracks(h.db)
		const playlist = unwrap(
			await h.playlists.createPlaylist({ title: 'Library', type: 'local' }),
		)
		unwrap(
			await h.playlists.addManyTracksToLocalPlaylist(playlist.id, [1, 2, 3]),
		)
		assert.deepEqual(ids(h, playlist.id), [1, 2, 3])
		const maximum = h.db
			.prepare(
				'SELECT MAX(sort_key) AS value FROM playlist_tracks WHERE playlist_id=?',
			)
			.get(playlist.id).value
		unwrap(
			await h.playlists.reorderSingleLocalPlaylistTrack(playlist.id, {
				trackId: 2,
				prevSortKey: maximum,
				nextSortKey: null,
			}),
		)
		assert.deepEqual(ids(h, playlist.id), [2, 1, 3])
		unwrap(await h.tracks.updateTrack({ id: 2, title: 'Edited second' }))
		unwrap(
			await h.playlists.updatePlaylistMetadata(playlist.id, {
				title: 'Renamed',
			}),
		)
		unwrap(
			await h.playlists.batchRemoveTracksFromLocalPlaylist(playlist.id, [1]),
		)
		peer.recorder.engine.applySeed(h.recorder.engine.exportSeed())
		assert.equal(
			peer.db
				.prepare('SELECT title FROM tracks WHERE unique_key=?')
				.get('bilibili::second::88').title,
			'Edited second',
		)
		assert.equal(
			peer.db.prepare('SELECT title FROM playlists').get().title,
			'Renamed',
		)
		assert.equal(
			peer.db
				.prepare("SELECT COUNT(*) AS n FROM tracks WHERE source='local'")
				.get().n,
			0,
		)
		assert.equal(
			peer.recorder.engine
				.exportSeed()
				.operations.some((op) => op.actor === peer.recorder.actor),
			false,
		)
		const previous = h.recorder.engine.exportSeed().operations.length
		h.db.exec(
			"CREATE TRIGGER fail_outbox BEFORE INSERT ON sync_operation BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
		)
		assert.equal(
			(
				await h.playlists.updatePlaylistMetadata(playlist.id, {
					title: 'Must roll back',
				})
			).isErr(),
			true,
		)
		assert.equal(
			h.db.prepare('SELECT title FROM playlists WHERE id=?').get(playlist.id)
				.title,
			'Renamed',
		)
		assert.equal(h.recorder.engine.exportSeed().operations.length, previous)
		h.db.exec('DROP TRIGGER fail_outbox')
		unwrap(await h.playlists.deletePlaylist(playlist.id))
		peer.recorder.engine.applySeed(h.recorder.engine.exportSeed())
		assert.equal(
			peer.db.prepare('SELECT COUNT(*) AS n FROM playlists').get().n,
			0,
		)
	} finally {
		h.db.close()
		peer.db.close()
	}
})

void test('source replacement, likes and manual old-source lyric choices survive a fresh peer seed without native-CID guesses', async () => {
	const h = syncServiceFixture(),
		peer = syncServiceFixture()
	try {
		addTracks(h.db)
		const playlist = unwrap(
			await h.playlists.createPlaylist({ title: 'Source', type: 'local' }),
		)
		unwrap(await h.playlists.addManyTracksToLocalPlaylist(playlist.id, [1]))
		unwrap(await h.tracks.setLiked(1, true))
		const document = {
			source: 'manual',
			offset: 0.2,
			lines: [{ start: 1, end: 3, text: 'Correction', words: [] }],
		}
		h.saveManualLyrics(h.raw, 'bilibili::first', document)
		const song = h.replaceSongSource(h.raw, 1, 2)
		h.saveManualLyrics(h.raw, 'bilibili::first', { ...document, offset: 0.3 })
		assert.equal(h.tracks.isLiked(2), true)
		peer.recorder.engine.applySeed(h.recorder.engine.exportSeed())
		assert.equal(
			peer.db
				.prepare(
					'SELECT active_source_key FROM library_songs WHERE UPPER(id)=?',
				)
				.get(song.toUpperCase()).active_source_key,
			'bilibili::second::88',
		)
		assert.equal(
			JSON.parse(
				peer.db
					.prepare('SELECT payload FROM sync_lyric WHERE source_key=?')
					.get('bilibili::first').payload,
			).offset,
			0.3,
		)
		assert.equal(
			peer.db.prepare('SELECT COUNT(*) AS n FROM play_history').get().n,
			0,
		)
		const first = h.recorder.engine
			.exportSeed()
			.operations.find(
				(op) => op.value.source?.track.id === 'bilibili:first:video',
			)
		assert.equal(first.value.source.track.cid, 77)
		assert.equal(
			h.recorder.engine
				.exportSeed()
				.operations.some((op) => JSON.stringify(op).includes('private-local')),
			false,
		)
		h.db.exec(
			"CREATE TRIGGER fail_lyric_log BEFORE INSERT ON sync_operation BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
		)
		assert.throws(() =>
			h.saveManualLyrics(h.raw, 'bilibili::first', { ...document, offset: 9 }),
		)
		assert.equal(
			JSON.parse(
				h.db
					.prepare('SELECT payload FROM sync_lyric WHERE source_key=?')
					.get('bilibili::first').payload,
			).offset,
			0.3,
		)
	} finally {
		h.db.close()
		peer.db.close()
	}
})

void test('actor persists, paused local edits do not dispatch, and explicit rebaseline rotates identities and includes current data', async () => {
	const h = syncServiceFixture(),
		peer = syncServiceFixture()
	try {
		addTracks(h.db)
		assert.equal(h.activateLocalSync(h.raw).actor, h.recorder.actor)
		h.db.exec("INSERT INTO sync_meta(key,value) VALUES('paused','true')")
		assert.equal(h.activateLocalSync(h.raw), undefined)
		const playlist = unwrap(
			await h.playlists.createPlaylist({
				title: 'Offline changes',
				type: 'local',
			}),
		)
		unwrap(await h.playlists.addManyTracksToLocalPlaylist(playlist.id, [1, 3]))
		assert.throws(() => h.recorder.engine.exportSeed())
		const next = h.rebaselineLocalSync(h.raw)
		assert.notEqual(next.actor, h.recorder.actor)
		assert.throws(() => h.recorder.engine.exportSeed())
		peer.recorder.engine.applySeed(next.engine.exportSeed())
		assert.equal(
			peer.db.prepare('SELECT COUNT(*) AS n FROM playlist_tracks').get().n,
			1,
		)
		assert.equal(
			peer.db.prepare('SELECT title FROM playlists').get().title,
			'Offline changes',
		)
	} finally {
		h.db.close()
		peer.db.close()
	}
})

void test('live conflict resolution rejects stale versions and keeps a concurrent edit with one transactional decision', async () => {
	const h = syncServiceFixture(),
		peer = syncServiceFixture()
	try {
		addTracks(h.db)
		const playlist = unwrap(
			await h.playlists.createPlaylist({ title: 'Base', type: 'local' }),
		)
		unwrap(await h.playlists.addManyTracksToLocalPlaylist(playlist.id, [1, 2]))
		peer.recorder.engine.applySeed(h.recorder.engine.exportSeed())
		const peerID = peer.db.prepare('SELECT id FROM playlists').get().id
		unwrap(
			await h.playlists.updatePlaylistMetadata(playlist.id, { title: 'Left' }),
		)
		unwrap(
			await peer.playlists.updatePlaylistMetadata(peerID, { title: 'Right' }),
		)
		h.recorder.engine.receive(peer.recorder.engine.exportSeed().operations)
		peer.recorder.engine.receive(h.recorder.engine.exportSeed().operations)
		const conflict = h.recorder.engine
			.conflicts()
			.find((value) => value.field === 'title')
		assert.equal(conflict.variants.length, 2)
		const chosen = conflict.variants.find(
			(value) => value.value.text === 'Right',
		)
		const resolved = h.recorder.engine.resolveConflict(conflict, chosen.id)
		assert.equal(resolved.length, 1)
		assert.equal(
			h.db.prepare('SELECT title FROM playlists WHERE id=?').get(playlist.id)
				.title,
			'Right',
		)
		assert.throws(() => h.recorder.engine.resolveConflict(conflict, chosen.id))
		peer.recorder.engine.receive(resolved)
		unwrap(await h.playlists.deletePlaylist(playlist.id))
		unwrap(
			await peer.playlists.updatePlaylistMetadata(peerID, {
				title: 'Keep edited',
			}),
		)
		h.recorder.engine.receive(peer.recorder.engine.exportSeed().operations)
		peer.recorder.engine.receive(h.recorder.engine.exportSeed().operations)
		const deletionConflict = h.recorder.engine
			.conflicts()
			.find((value) => value.field === 'delete/edit')
		const edit = deletionConflict.variants.find(
			(value) => value.field === 'title',
		)
		const kept = h.recorder.engine.resolveConflict(deletionConflict, edit.id)
		assert.equal(kept.length, 2)
		peer.recorder.engine.receive(kept)
		assert.equal(
			h.db.prepare('SELECT title FROM playlists').get().title,
			'Keep edited',
		)
		assert.equal(h.recorder.engine.conflicts().length, 0)
		assert.equal(peer.recorder.engine.conflicts().length, 0)
	} finally {
		h.db.close()
		peer.db.close()
	}
})
