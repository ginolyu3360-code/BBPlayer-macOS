import type { SQLiteDatabase } from 'expo-sqlite'
import { generateKeyBetween } from 'fractional-indexing'

import { syncConflicts } from './engine'
import { causalNetworkOrder } from './order'
import { mobileSourceKey } from './protocol'
import type { SyncOperation } from './protocol'

/** Called only inside the engine receipt transaction; never invokes service mutation hooks. */
export function projectSyncLibrary(
	db: SQLiteDatabase,
	heads: SyncOperation[],
	historicalSources: SyncOperation[] = [],
	historicalOrders: SyncOperation[] = [],
): void {
	const winners = new Map<string, SyncOperation>()
	for (const head of heads) {
		const key = head.entity + '\0' + head.field
		if (!winners.has(key) || winners.get(key)!.id < head.id)
			winners.set(key, head)
	}
	const operations = [...winners.values()]
	const conflicts = syncConflicts(heads)
	const song = (id: string) =>
		db.getFirstSync<{ id: string; track_id: number; source: string }>(
			'SELECT s.id,t.id AS track_id,t.source FROM library_songs s LEFT JOIN tracks t ON t.unique_key=s.active_source_key WHERE UPPER(s.id)=?',
			[id],
		)
	for (const op of [
		...historicalSources,
		...operations.filter(
			(candidate) =>
				candidate.field === 'source' || candidate.field.startsWith('archive:'),
		),
	]) {
		const { songID, track } = op.value.source!
		const key = mobileSourceKey(track.id)
		const owner = db.getFirstSync<{ song_id: string }>(
			'SELECT song_id FROM song_sources WHERE source_key=?',
			[key],
		)
		if (owner && owner.song_id.toUpperCase() !== songID) {
			if (
				db.getFirstSync<{ value: string }>(
					"SELECT value FROM sync_meta WHERE key='accept-mac-baseline'",
				)?.value !== 'true'
			)
				throw new Error('Sync source ownership conflict')
			const identity = song(songID)?.id ?? songID
			db.runSync(
				'UPDATE library_songs SET active_source_key=NULL WHERE id=? AND active_source_key=?',
				[owner.song_id, key],
			)
			db.runSync(
				'INSERT OR IGNORE INTO library_songs(id,active_source_key) VALUES(?,NULL)',
				[identity],
			)
			db.runSync('UPDATE song_sources SET song_id=? WHERE source_key=?', [
				identity,
				key,
			])
		}
		let existing = db.getFirstSync<{ id: number }>(
			'SELECT id FROM tracks WHERE unique_key=?',
			[key],
		)
		db.runSync("INSERT OR IGNORE INTO artists(name,source) VALUES(?,'local')", [
			track.artist,
		])
		const artist = db.getFirstSync<{ id: number }>(
			"SELECT id FROM artists WHERE source='local' AND name=?",
			[track.artist],
		)!
		if (!existing) {
			const result = db.runSync(
				"INSERT INTO tracks(unique_key,title,artist_id,cover_url,duration,source) VALUES(?,?,?,?,?,'bilibili')",
				[key, track.title, artist.id, track.coverURL ?? null, track.duration],
			)
			existing = { id: result.lastInsertRowId }
			const generated = db.getFirstSync<{ song_id: string }>(
				'SELECT song_id FROM song_sources WHERE source_key=?',
				[key],
			)!.song_id
			const identity = song(songID)?.id ?? songID
			db.runSync('UPDATE library_songs SET active_source_key=NULL WHERE id=?', [
				generated,
			])
			db.runSync(
				'INSERT OR IGNORE INTO library_songs(id,active_source_key) VALUES(?,NULL)',
				[identity],
			)
			db.runSync('UPDATE song_sources SET song_id=? WHERE source_key=?', [
				identity,
				key,
			])
			db.runSync('DELETE FROM library_songs WHERE id=?', [generated])
		}
		if (
			!owner &&
			existing &&
			!db.getFirstSync(
				'SELECT source_key FROM song_sources WHERE source_key=?',
				[key],
			)
		) {
			const identity = song(songID)?.id ?? songID
			db.runSync(
				'INSERT OR IGNORE INTO library_songs(id,active_source_key) VALUES(?,NULL)',
				[identity],
			)
			db.runSync('INSERT INTO song_sources(source_key,song_id) VALUES(?,?)', [
				key,
				identity,
			])
		}
		db.runSync(
			'UPDATE tracks SET title=?,artist_id=?,cover_url=?,duration=? WHERE id=?',
			[
				track.title,
				artist.id,
				track.coverURL ?? null,
				track.duration,
				existing.id,
			],
		)
		db.runSync(
			'INSERT INTO bilibili_metadata(track_id,bvid,cid,is_multi_page) VALUES(?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET bvid=excluded.bvid,cid=excluded.cid,is_multi_page=excluded.is_multi_page',
			[
				existing.id,
				track.bvid,
				track.cid ?? null,
				track.id.endsWith(':video') ? 0 : 1,
			],
		)
	}
	for (const active of operations.filter(
		(candidate) => candidate.field === 'source',
	)) {
		db.runSync(
			'UPDATE library_songs SET active_source_key=? WHERE UPPER(id)=?',
			[
				mobileSourceKey(active.value.source!.track.id),
				active.value.source!.songID,
			],
		)
	}
	for (const op of operations.filter(
		(candidate) => candidate.field === 'liked',
	)) {
		const identity = song(op.entity.slice(5))
		if (!identity || identity.source !== 'bilibili')
			throw new Error('Sync like is missing its network source')
		db.runSync(
			'INSERT INTO sync_like(song_id,liked) VALUES(?,?) ON CONFLICT(song_id) DO UPDATE SET liked=excluded.liked',
			[identity.id, op.value.flag ? 1 : 0],
		)
	}
	for (const op of operations.filter(
		(candidate) => candidate.field === 'lyrics',
	)) {
		const key = mobileSourceKey(op.entity.slice(7))
		if (
			!db.getFirstSync(
				'SELECT source_key FROM song_sources WHERE source_key=?',
				[key],
			)
		)
			throw new Error('Sync lyrics are missing their source')
		db.runSync(
			'INSERT INTO sync_lyric(source_key,payload) VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET payload=excluded.payload',
			[key, JSON.stringify(op.value.lyrics)],
		)
	}
	for (const entity of new Set(
		operations
			.filter((op) => op.entity.startsWith('playlist:'))
			.map((op) => op.entity),
	)) {
		const identity = entity.slice(9),
			fields = operations.filter((op) => op.entity === entity)
		let playlist = db.getFirstSync<{ id: number; type: string }>(
			'SELECT p.id,p.type FROM playlists p JOIN playlist_identities i ON i.playlist_id=p.id WHERE i.id=?',
			[identity],
		)
		if (playlist && playlist.type !== 'local')
			throw new Error('Sync cannot modify a remote playlist')
		const old = playlist
			? db.getAllSync<{ track_id: number; source: string; song_id: string }>(
					'SELECT pt.track_id,t.source,ss.song_id FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id LEFT JOIN song_sources ss ON ss.source_key=t.unique_key WHERE pt.playlist_id=? ORDER BY pt.sort_key DESC',
					[playlist.id],
				)
			: []
		const deleted =
			fields.find((op) => op.field === 'deleted')?.value.flag === true &&
			!conflicts.some(
				(conflict) =>
					conflict.entity === entity && conflict.field === 'delete/edit',
			)
		if (deleted && old.every((entry) => entry.source === 'bilibili')) {
			if (playlist)
				db.runSync('DELETE FROM playlists WHERE id=?', [playlist.id])
			continue
		}
		const title = fields.find((op) => op.field === 'title')?.value.text
		if (!playlist) {
			const result = db.runSync(
				"INSERT INTO playlists(title,type) VALUES(?,'local')",
				[title ?? '同步歌单'],
			)
			playlist = { id: result.lastInsertRowId, type: 'local' }
			db.runSync('UPDATE playlist_identities SET id=? WHERE playlist_id=?', [
				identity,
				playlist.id,
			])
		} else if (title)
			db.runSync('UPDATE playlists SET title=? WHERE id=?', [
				title,
				playlist.id,
			])
		const mentioned = new Set(
			fields
				.filter((op) => op.field.startsWith('entry:'))
				.map((op) => op.field.slice(6)),
		)
		const included = new Set(
			heads
				.filter(
					(op) =>
						op.entity === entity &&
						op.field.startsWith('entry:') &&
						op.value.flag === true,
				)
				.map((op) => op.field.slice(6)),
		)
		for (const entry of old)
			if (
				entry.source === 'bilibili' &&
				!mentioned.has(entry.song_id.toUpperCase())
			)
				included.add(entry.song_id.toUpperCase())
		for (const conflict of conflicts)
			if (
				conflict.entity === entity &&
				conflict.field.startsWith('entry-delete/edit:')
			)
				included.add(conflict.field.slice('entry-delete/edit:'.length))
		if (deleted) included.clear()
		const requested = causalNetworkOrder(
			fields.find((op) => op.field === 'order'),
			historicalOrders,
		)
		const desired = [
			...requested.filter((id) => included.has(id)),
			...old
				.filter((entry) => entry.source === 'bilibili')
				.map((entry) => entry.song_id.toUpperCase())
				.filter(
					(id, index, ids) =>
						included.has(id) &&
						!requested.includes(id) &&
						ids.indexOf(id) === index,
				),
			...Array.from(included)
				.filter(
					(id) =>
						!requested.includes(id) &&
						!old.some(
							(entry) =>
								entry.source === 'bilibili' &&
								entry.song_id.toUpperCase() === id,
						),
				)
				.sort(),
		]
		const oldNetwork = new Set(
			old
				.filter((entry) => entry.source === 'bilibili')
				.map((entry) => entry.song_id.toUpperCase()),
		)
		const existingSlots = desired.filter((id) => oldNetwork.has(id)).values()
		const tracks: number[] = []
		const activeID = (id: string) => {
			const current = song(id)
			if (!current || current.source !== 'bilibili')
				throw new Error('Sync playlist is missing its source')
			return current.track_id
		}
		for (const entry of old) {
			if (entry.source !== 'bilibili') tracks.push(entry.track_id)
			else {
				const next = existingSlots.next()
				if (!next.done) tracks.push(activeID(next.value))
			}
		}
		for (const id of desired) if (!oldNetwork.has(id)) tracks.push(activeID(id))
		db.runSync('DELETE FROM playlist_tracks WHERE playlist_id=?', [playlist.id])
		let key: string | null = null
		for (const id of tracks) {
			key = generateKeyBetween(null, key)
			db.runSync(
				'INSERT OR IGNORE INTO playlist_tracks(playlist_id,track_id,sort_key) VALUES(?,?,?)',
				[playlist.id, id, key],
			)
		}
		db.runSync(
			'UPDATE playlists SET item_count=(SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id=?) WHERE id=?',
			[playlist.id, playlist.id],
		)
	}
}
