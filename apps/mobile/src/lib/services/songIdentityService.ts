import type { SQLiteDatabase } from 'expo-sqlite'

import { localRecorder } from '@/lib/sync/localRecording'

type IdentityDatabase = Pick<
	SQLiteDatabase,
	'getFirstSync' | 'getAllSync' | 'runSync' | 'withTransactionSync'
>
interface SourceIdentity {
	unique_key: string
	song_id: string
	source: string
	active_source_key: string | null
}

function identity(database: IdentityDatabase, trackId: number): SourceIdentity {
	const source = database.getFirstSync<SourceIdentity>(
		`SELECT t.unique_key,t.source,s.song_id,l.active_source_key FROM tracks t JOIN song_sources s ON s.source_key=t.unique_key JOIN library_songs l ON l.id=s.song_id WHERE t.id=?`,
		[trackId],
	)
	if (!source) throw new Error('歌曲或来源不存在，请刷新歌单')
	return source
}

/** Caller must create a protective backup before this transaction. Playback stays on its current source. */
export function replaceSongSource(
	database: IdentityDatabase,
	originalTrackId: number,
	replacementTrackId: number,
): string {
	let songID = ''
	database.withTransactionSync(() => {
		const original = identity(database, originalTrackId)
		const replacement = identity(database, replacementTrackId)
		if (original.source !== 'bilibili' || replacement.source !== 'bilibili')
			throw new Error('本地文件请使用重新关联文件，网络换源仅支持网络歌曲')
		songID = original.song_id
		if (original.active_source_key === replacement.unique_key) return
		if (replacement.song_id !== songID) {
			const occupied = database.getFirstSync<{ count: number }>(
				`SELECT (SELECT COUNT(*) FROM playlist_tracks p JOIN tracks t ON t.id=p.track_id JOIN song_sources s ON s.source_key=t.unique_key WHERE s.song_id=?) + (SELECT COUNT(*) FROM history_source_snapshots WHERE song_id=?) + (SELECT MAX(COUNT(*)-1,0) FROM song_sources WHERE song_id=?) AS count`,
				[replacement.song_id, replacement.song_id, replacement.song_id],
			)
			if (occupied?.count)
				throw new Error(
					'该来源已属于另一首已使用的歌曲，请选择其他来源或保留为独立版本',
				)
			database.runSync(
				'UPDATE library_songs SET active_source_key=NULL WHERE id=?',
				[replacement.song_id],
			)
			database.runSync('UPDATE song_sources SET song_id=? WHERE source_key=?', [
				songID,
				replacement.unique_key,
			])
			database.runSync('DELETE FROM library_songs WHERE id=?', [
				replacement.song_id,
			])
		}
		// Local playlists sort keys descending; keep the earliest visible song slot.
		const memberships = database.getAllSync<{
			playlist_id: number
			sort_key: string
			created_at: number
		}>(
			`SELECT p.playlist_id,MAX(p.sort_key) AS sort_key,MIN(p.created_at) AS created_at FROM playlist_tracks p JOIN tracks t ON t.id=p.track_id JOIN song_sources s ON s.source_key=t.unique_key WHERE s.song_id=? GROUP BY p.playlist_id`,
			[songID],
		)
		database.runSync(
			`DELETE FROM playlist_tracks WHERE track_id IN (SELECT t.id FROM tracks t JOIN song_sources s ON s.source_key=t.unique_key WHERE s.song_id=?)`,
			[songID],
		)
		for (const membership of memberships) {
			database.runSync(
				'INSERT INTO playlist_tracks(playlist_id,track_id,sort_key,created_at) VALUES(?,?,?,?)',
				[
					membership.playlist_id,
					replacementTrackId,
					membership.sort_key,
					membership.created_at,
				],
			)
			database.runSync(
				'UPDATE playlists SET item_count=(SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id=?) WHERE id=?',
				[membership.playlist_id, membership.playlist_id],
			)
		}

		database.runSync(
			'UPDATE library_songs SET active_source_key=? WHERE id=?',
			[replacement.unique_key, songID],
		)
		localRecorder(database)?.captureSource(songID)
	})
	return songID
}
