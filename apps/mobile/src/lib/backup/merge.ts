import type { SQLiteDatabase } from 'expo-sqlite'
import { generateKeyBetween } from 'fractional-indexing'

type Value = string | number | null | Uint8Array
type Row = Record<string, Value>

/** Merge into a private, validated destination copy. Never call with the live database. */
export function mergeLibraryDatabases(
	destination: SQLiteDatabase,
	incoming: SQLiteDatabase,
	preferImportedMetadata = false,
): void {
	const all = (db: SQLiteDatabase, table: string) =>
		db.getAllSync<Row>(`SELECT * FROM ${table}`)
	const one = (query: string, ...args: Value[]) =>
		destination.getFirstSync<Row>(query, args)
	const insert = (table: string, row: Row, omitID = true): number => {
		const fields = Object.keys(row).filter((key) => !omitID || key !== 'id')
		// Field names originate from the validated schema, not archive text or user input.
		return destination.runSync(
			`INSERT INTO ${table} (${fields.map((key) => `"${key}"`).join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
			fields.map((key) => row[key]),
		).lastInsertRowId
	}
	const update = (table: string, row: Row, id: Value) => {
		const fields = Object.keys(row).filter((key) => key !== 'id')
		destination.runSync(
			`UPDATE ${table} SET ${fields.map((key) => `"${key}"=?`).join(',')} WHERE id=?`,
			[...fields.map((key) => row[key]), id],
		)
	}
	const sources = all(incoming, 'song_sources')
	// Validate the entire identity graph before making even staged changes.
	for (const source of sources) {
		const existing = one(
			'SELECT song_id FROM song_sources WHERE source_key=?',
			source.source_key,
		)
		if (existing && existing.song_id !== source.song_id)
			throw new Error(
				'相同播放来源属于不同歌曲身份，无法安全合并。请使用完整恢复，或重新导出同一资料库的备份。',
			)
	}
	const artistMap = new Map<Value, number>()
	const trackMap = new Map<Value, number>()
	const playlistMap = new Map<Value, number>()
	destination.withTransactionSync(() => {
		for (const artist of all(incoming, 'artists')) {
			const existing =
				artist.source === 'local'
					? one(
							"SELECT id FROM artists WHERE source='local' AND name=?",
							artist.name,
						)
					: one(
							'SELECT id FROM artists WHERE source=? AND remote_id=?',
							artist.source,
							artist.remote_id,
						)
			const id = existing ? Number(existing.id) : insert('artists', artist)
			if (existing && preferImportedMetadata) update('artists', artist, id)
			artistMap.set(artist.id, id)
		}
		for (const song of all(incoming, 'library_songs'))
			destination.runSync(
				'INSERT OR IGNORE INTO library_songs(id,active_source_key) VALUES(?,NULL)',
				[song.id],
			)
		for (const track of all(incoming, 'tracks')) {
			const existing = one(
				'SELECT id FROM tracks WHERE unique_key=?',
				track.unique_key,
			)
			const mapped = {
				...track,
				artist_id: artistMap.get(track.artist_id) ?? null,
			}
			const id = existing ? Number(existing.id) : insert('tracks', mapped)
			if (existing && preferImportedMetadata) update('tracks', mapped, id)
			trackMap.set(track.id, id)
		}
		for (const source of sources) {
			const generated = one(
				'SELECT song_id FROM song_sources WHERE source_key=?',
				source.source_key,
			)
			if (generated?.song_id !== source.song_id) {
				destination.runSync(
					'UPDATE library_songs SET active_source_key=NULL WHERE id=?',
					[generated!.song_id],
				)
				destination.runSync(
					'UPDATE song_sources SET song_id=? WHERE source_key=?',
					[source.song_id, source.source_key],
				)
				destination.runSync('DELETE FROM library_songs WHERE id=?', [
					generated!.song_id,
				])
			}
		}
		for (const song of all(incoming, 'library_songs')) {
			const current = one(
				'SELECT active_source_key FROM library_songs WHERE id=?',
				song.id,
			)
			if (!current?.active_source_key || preferImportedMetadata)
				destination.runSync(
					'UPDATE library_songs SET active_source_key=? WHERE id=?',
					[song.active_source_key, song.id],
				)
		}
		for (const table of ['bilibili_metadata', 'local_metadata']) {
			for (const row of all(incoming, table)) {
				const id = trackMap.get(row.track_id)!
				const existing = one(
					`SELECT track_id FROM ${table} WHERE track_id=?`,
					id,
				)
				if (!existing) insert(table, { ...row, track_id: id }, false)
				// A reference to an original file is device-specific; keep an existing usable reference.
				else if (preferImportedMetadata && table === 'bilibili_metadata') {
					destination.runSync(`DELETE FROM ${table} WHERE track_id=?`, [id])
					insert(table, { ...row, track_id: id }, false)
				}
			}
		}
		const identities = new Map(
			all(incoming, 'playlist_identities').map((row) => [
				row.playlist_id,
				row.id,
			]),
		)
		for (const playlist of all(incoming, 'playlists')) {
			const identity = identities.get(playlist.id)
			if (!identity) throw new Error('备份歌单缺少稳定身份，无法合并')
			const existing = one(
				'SELECT p.id,p.type FROM playlists p JOIN playlist_identities i ON i.playlist_id=p.id WHERE i.id=?',
				identity,
			)
			if (existing && existing.type !== playlist.type)
				throw new Error('歌单身份对应的类型冲突，无法合并')
			const mapped = {
				...playlist,
				author_id: artistMap.get(playlist.author_id) ?? null,
				share_id: null,
				share_role: null,
				last_share_sync_at: null,
				last_synced_at: null,
			}
			const id = existing ? Number(existing.id) : insert('playlists', mapped)
			if (existing && preferImportedMetadata) update('playlists', mapped, id)
			if (!existing)
				destination.runSync(
					'UPDATE playlist_identities SET id=? WHERE playlist_id=?',
					[identity, id],
				)
			playlistMap.set(playlist.id, id)
		}
		// Normalize old source slots to the chosen active source, retaining the earliest visible slot.
		destination.execSync(`CREATE TEMP TABLE merge_memberships AS SELECT pt.playlist_id, COALESCE(t.id,pt.track_id) AS track_id,MAX(pt.sort_key) AS sort_key,MIN(pt.created_at) AS created_at FROM playlist_tracks pt JOIN tracks original ON original.id=pt.track_id LEFT JOIN song_sources ss ON ss.source_key=original.unique_key LEFT JOIN library_songs ls ON ls.id=ss.song_id LEFT JOIN tracks t ON t.unique_key=ls.active_source_key GROUP BY pt.playlist_id,COALESCE(t.id,pt.track_id);
DELETE FROM playlist_tracks; INSERT INTO playlist_tracks(playlist_id,track_id,sort_key,created_at) SELECT * FROM merge_memberships; DROP TABLE merge_memberships;`)
		for (const entry of incoming.getAllSync<Row>(
			'SELECT * FROM playlist_tracks ORDER BY playlist_id,sort_key DESC',
		)) {
			const playlistID = playlistMap.get(entry.playlist_id)!
			const trackID = trackMap.get(entry.track_id)!
			const active = one(
				'SELECT active.id FROM tracks t JOIN song_sources ss ON ss.source_key=t.unique_key JOIN library_songs ls ON ls.id=ss.song_id LEFT JOIN tracks active ON active.unique_key=ls.active_source_key WHERE t.id=?',
				trackID,
			)
			const chosen = Number(active?.id ?? trackID)
			if (
				one(
					'SELECT track_id FROM playlist_tracks WHERE playlist_id=? AND track_id=?',
					playlistID,
					chosen,
				)
			)
				continue
			const minimum = one(
				'SELECT MIN(sort_key) AS key FROM playlist_tracks WHERE playlist_id=?',
				playlistID,
			)?.key
			insert(
				'playlist_tracks',
				{
					...entry,
					playlist_id: playlistID,
					track_id: chosen,
					sort_key: generateKeyBetween(
						null,
						typeof minimum === 'string' ? minimum : null,
					),
				},
				false,
			)
		}
		for (const row of all(incoming, 'dynamic_playlist_sources')) {
			destination.runSync(
				'INSERT OR IGNORE INTO dynamic_playlist_sources(playlist_id,source_playlist_id,position,created_at) VALUES(?,?,?,?)',
				[
					playlistMap.get(row.playlist_id)!,
					playlistMap.get(row.source_playlist_id)!,
					row.position,
					row.created_at,
				],
			)
		}
		const snapshots = new Map(
			all(incoming, 'history_source_snapshots').map((row) => [
				row.history_id,
				row,
			]),
		)
		for (const history of all(incoming, 'play_history')) {
			const trackID = trackMap.get(history.track_id)!
			const existing = one(
				'SELECT id FROM play_history WHERE track_id=? AND start_time=?',
				trackID,
				history.start_time,
			)
			if (existing) {
				destination.runSync(
					'UPDATE play_history SET duration_played=MAX(duration_played,?),completed=MAX(completed,?) WHERE id=?',
					[history.duration_played, history.completed, existing.id],
				)
				continue
			}
			const id = insert('play_history', { ...history, track_id: trackID })
			const snapshot = snapshots.get(history.id)
			if (snapshot)
				destination.runSync(
					'UPDATE history_source_snapshots SET song_id=?,source_key=?,payload=?,evidence=? WHERE history_id=?',
					[
						snapshot.song_id,
						snapshot.source_key,
						snapshot.payload,
						snapshot.evidence,
						id,
					],
				)
		}
		for (const lyric of all(incoming, 'sync_lyric')) {
			if (
				preferImportedMetadata ||
				!one(
					'SELECT source_key FROM sync_lyric WHERE source_key=?',
					lyric.source_key,
				)
			)
				destination.runSync(
					'INSERT INTO sync_lyric(source_key,payload) VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET payload=excluded.payload',
					[lyric.source_key, lyric.payload],
				)
		}
		for (const like of all(incoming, 'sync_like')) {
			const current = one(
				'SELECT song_id FROM sync_like WHERE song_id=?',
				like.song_id,
			)
			if (!current || preferImportedMetadata)
				destination.runSync(
					'INSERT INTO sync_like(song_id,liked) VALUES(?,?) ON CONFLICT(song_id) DO UPDATE SET liked=excluded.liked',
					[like.song_id, like.liked],
				)
		}
		destination.execSync(
			'UPDATE playlists SET item_count=(SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id=playlists.id); DELETE FROM playlist_sync_queue;',
		)
	})
}
