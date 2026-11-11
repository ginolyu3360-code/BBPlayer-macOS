import type { SQLiteDatabase } from 'expo-sqlite'

import { SyncEngine } from './engine'
import type { SyncDatabase } from './engine'
import { projectSyncLibrary } from './libraryProjection'
import { canonicalJSON, wireSourceKey } from './protocol'
import type { SyncLyrics, SyncTrack, SyncValue } from './protocol'

export interface LocalPlaylistState {
	identity?: string
	title?: string
	network: string[]
}
interface SourceRow {
	song_id: string
	active_source_key: string
	unique_key: string
	title: string
	artist: string
	cover_url: string | null
	duration: number | null
	source: string
	bvid: string | null
	cid: number | null
}
const sourceQuery = `SELECT s.id AS song_id,s.active_source_key,t.unique_key,t.title,COALESCE(a.name,'') AS artist,t.cover_url,t.duration,t.source,b.bvid,b.cid
FROM library_songs s JOIN tracks t ON t.unique_key=s.active_source_key LEFT JOIN artists a ON a.id=t.artist_id LEFT JOIN bilibili_metadata b ON b.track_id=t.id`
function makeSQLiteID(db: SyncDatabase): string {
	// IDs are public uniqueness tokens, not authentication secrets. Match existing DB UUID generation.
	return db.getFirstSync<{ id: string }>(
		"SELECT UPPER(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-8'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))) AS id",
	)!.id
}

export function playlistState(
	db: SyncDatabase,
	id: number,
): LocalPlaylistState {
	const playlist = db.getFirstSync<{
		identity: string
		title: string
		type: string
	}>(
		'SELECT i.id AS identity,p.title,p.type FROM playlists p JOIN playlist_identities i ON i.playlist_id=p.id WHERE p.id=?',
		[id],
	)
	if (!playlist || playlist.type !== 'local') return { network: [] }
	const rows = db.getAllSync<{ song_id: string }>(
		"SELECT s.song_id FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id JOIN song_sources s ON s.source_key=t.unique_key WHERE pt.playlist_id=? AND t.source='bilibili' ORDER BY pt.sort_key DESC",
		[id],
	)
	return {
		identity: playlist.identity,
		title: playlist.title,
		network: [...new Set(rows.map((row) => row.song_id.toUpperCase()))],
	}
}

/** Records existing service edits without invoking incoming SQL projection. */
export class LocalSyncRecorder {
	readonly engine: SyncEngine
	constructor(
		private readonly db: SyncDatabase,
		readonly actor: string,
		makeID = () => makeSQLiteID(db),
	) {
		// Projection only uses the four synchronous methods provided by SyncDatabase.
		this.engine = new SyncEngine(
			db,
			actor,
			makeID,
			(heads, historical, orders) =>
				projectSyncLibrary(db as SQLiteDatabase, heads, historical, orders),
		)
	}
	private append(entity: string, field: string, value: SyncValue) {
		return this.engine.recordInTransaction(entity, field, value)
	}
	private wireTrack(row: SourceRow): SyncTrack {
		if (row.source !== 'bilibili' || !row.bvid)
			throw new Error('同步来源缺少网络歌曲元数据')
		let coverURL: string | undefined
		if (row.cover_url) {
			try {
				const url = new URL(row.cover_url)
				if (
					url.protocol === 'https:' &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash
				)
					coverURL = url.toString()
			} catch {
				/* File paths and untrusted cover addresses stay local. */
			}
		}
		return {
			id: wireSourceKey(row.unique_key),
			bvid: row.bvid,
			cid: row.cid ?? undefined,
			title: row.title,
			artist: row.artist,
			coverURL,
			duration: row.duration ?? 0,
			source: 'bilibili',
		}
	}
	captureSource(song: string): void {
		const row = this.db.getFirstSync<SourceRow>(
			sourceQuery + ' WHERE s.id IN (?,?)',
			[song.toUpperCase(), song.toLowerCase()],
		)
		if (!row || row.source !== 'bilibili') return
		const entity = 'song:' + song.toUpperCase(),
			value: SyncValue = {
				source: { songID: song.toUpperCase(), track: this.wireTrack(row) },
			}
		const previous = this.db.getFirstSync<{ payload: string }>(
			"SELECT o.payload FROM sync_head h JOIN sync_operation o ON o.id=h.operation_id WHERE h.entity=? AND h.field='source' ORDER BY o.id DESC LIMIT 1",
			[entity],
		)
		const winner = previous
			? (JSON.parse(previous.payload) as import('./protocol').SyncOperation)
			: undefined
		if (winner && canonicalJSON(winner.value) === canonicalJSON(value)) return
		this.append(entity, 'source', value)
	}
	capturePlaylist(id: number, before: LocalPlaylistState): void {
		const after = playlistState(this.db, id),
			identity = after.identity ?? before.identity
		if (!identity) return
		const entity = 'playlist:' + identity
		if (before.title === undefined && after.title !== undefined)
			this.append(entity, 'deleted', { flag: false })
		if (before.title !== undefined && after.title === undefined) {
			this.append(entity, 'deleted', { flag: true })
			return
		}
		if (after.title !== undefined && before.title !== after.title)
			this.append(entity, 'title', { text: after.title })
		for (const song of after.network) this.captureSource(song)
		for (const song of before.network.filter(
			(candidate) => !after.network.includes(candidate),
		))
			this.append(entity, 'entry:' + song, { flag: false })
		for (const song of after.network.filter(
			(candidate) => !before.network.includes(candidate),
		))
			this.append(entity, 'entry:' + song, { flag: true })
		if (canonicalJSON(before.network) !== canonicalJSON(after.network))
			this.append(entity, 'order', { order: after.network })
	}
	captureLyrics(key: string, document: SyncLyrics): void {
		const owner = this.db.getFirstSync<{
			song_id: string
			active_source_key: string
			source: string
		}>(
			'SELECT m.song_id,s.active_source_key,t.source FROM song_sources m JOIN library_songs s ON s.id=m.song_id JOIN tracks t ON t.unique_key=m.source_key WHERE m.source_key=?',
			[key],
		)
		if (!owner || owner.source !== 'bilibili')
			throw new Error('歌词对应的网络歌曲尚未保存，请刷新歌曲后重试')
		const song = owner.song_id.toUpperCase()
		this.captureSource(song)
		if (owner.active_source_key !== key) {
			const row = this.db.getFirstSync<SourceRow>(
				`SELECT s.id AS song_id,s.active_source_key,t.unique_key,t.title,COALESCE(a.name,'') AS artist,t.cover_url,t.duration,t.source,b.bvid,b.cid FROM song_sources m JOIN library_songs s ON s.id=m.song_id JOIN tracks t ON t.unique_key=m.source_key LEFT JOIN artists a ON a.id=t.artist_id LEFT JOIN bilibili_metadata b ON b.track_id=t.id WHERE m.source_key=?`,
				[key],
			)!
			this.append('song:' + song, 'archive:' + wireSourceKey(key), {
				source: { songID: song, track: this.wireTrack(row) },
			})
		}
		this.append('source:' + wireSourceKey(key), 'lyrics', { lyrics: document })
	}
	captureLike(song: string, liked: boolean): void {
		this.captureSource(song)
		this.append('song:' + song.toUpperCase(), 'liked', { flag: liked })
	}
	seedIfEmpty(): void {
		if (
			this.db.getFirstSync<{ count: number }>(
				'SELECT COUNT(*) AS count FROM sync_operation',
			)!.count
		)
			return
		for (const row of this.db.getAllSync<{ id: number }>(
			"SELECT id FROM playlists WHERE type='local' ORDER BY id",
		))
			this.capturePlaylist(row.id, { network: [] })
		for (const row of this.db.getAllSync<{ song_id: string }>(
			"SELECT l.song_id FROM sync_like l JOIN library_songs s ON s.id=l.song_id JOIN tracks t ON t.unique_key=s.active_source_key WHERE l.liked=1 AND t.source='bilibili'",
		))
			this.captureLike(row.song_id, true)
		for (const row of this.db.getAllSync<{
			source_key: string
			payload: string
		}>(
			"SELECT l.source_key,l.payload FROM sync_lyric l JOIN song_sources m ON m.source_key=l.source_key JOIN tracks t ON t.unique_key=l.source_key WHERE t.source='bilibili'",
		))
			this.captureLyrics(row.source_key, JSON.parse(row.payload) as SyncLyrics)
	}
}

export function localRecorder(
	db: SyncDatabase,
	makeID = () => makeSQLiteID(db),
): LocalSyncRecorder | undefined {
	if (
		db.getFirstSync<{ value: string }>(
			"SELECT value FROM sync_meta WHERE key='paused'",
		)?.value === 'true'
	)
		return undefined
	const actor = db.getFirstSync<{ value: string }>(
		"SELECT value FROM sync_meta WHERE key='actor'",
	)?.value
	return actor ? new LocalSyncRecorder(db, actor, makeID) : undefined
}
export function activateLocalSync(
	db: SyncDatabase,
	makeID = () => makeSQLiteID(db),
): LocalSyncRecorder | undefined {
	let recorder: LocalSyncRecorder | undefined
	db.withTransactionSync(() => {
		if (
			db.getFirstSync<{ value: string }>(
				"SELECT value FROM sync_meta WHERE key='paused'",
			)?.value === 'true'
		)
			return
		const actor =
			db.getFirstSync<{ value: string }>(
				"SELECT value FROM sync_meta WHERE key='actor'",
			)?.value ?? makeID().toUpperCase()
		db.runSync(
			"INSERT INTO sync_meta(key,value) VALUES('actor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			[actor],
		)
		recorder = new LocalSyncRecorder(db, actor, makeID)
		recorder.seedIfEmpty()
	})
	return recorder
}
/** Explicit reconnect decision; all peers must discard the previous baseline. */
export function rebaselineLocalSync(
	db: SyncDatabase,
	makeID = () => makeSQLiteID(db),
): LocalSyncRecorder {
	let recorder: LocalSyncRecorder
	db.withTransactionSync(() => {
		for (const table of [
			'sync_ack',
			'sync_head',
			'sync_operation',
			'sync_revision',
		])
			db.runSync(`DELETE FROM ${table}`)
		db.runSync(
			"DELETE FROM sync_meta WHERE key='paused' OR key LIKE 'sync-projection:%'",
		)
		const actor = makeID().toUpperCase()
		db.runSync(
			"INSERT INTO sync_meta(key,value) VALUES('actor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			[actor],
		)
		recorder = new LocalSyncRecorder(db, actor, makeID)
		recorder.seedIfEmpty()
	})
	return recorder!
}

/** SQL is authoritative for explicit network lyric choices, including skipped lyrics. */
export function saveManualLyrics(
	db: SyncDatabase,
	key: string,
	document: SyncLyrics,
	makeID = () => makeSQLiteID(db),
): boolean {
	let network = false
	db.withTransactionSync(() => {
		const track = db.getFirstSync<{ source: string }>(
			'SELECT source FROM tracks WHERE unique_key=?',
			[key],
		)
		if (!track) throw new Error('歌词对应的歌曲尚未保存，请刷新歌曲后重试')
		if (track.source !== 'bilibili') return
		network = true
		db.runSync(
			'INSERT INTO sync_lyric(source_key,payload) VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET payload=excluded.payload',
			[key, JSON.stringify(document)],
		)
		localRecorder(db, makeID)?.captureLyrics(key, document)
	})
	return network
}
