import { Orpheus } from '@bbplayer/orpheus'
import CryptoJS from 'crypto-js'
import { Directory, File, Paths } from 'expo-file-system'
import * as SQLite from 'expo-sqlite'
import JSZip from 'jszip'

import { restorePlaybackContextState } from '@/hooks/stores/playbackContextStore'
import { expoDb, libraryRestoreGate, restoreDatabase } from '@/lib/db/db'
import log from '@/utils/log'
import { storage } from '@/utils/mmkv'

import { mergeLibraryDatabases } from './merge'
import {
	exportPreferences,
	mergePreferences,
	portableNativePreferences,
} from './preferences'
import { BACKUP_VERSION } from './types'
import type { BackupManifest } from './types'
import { upgradeBackupSchema } from './upgrade'

const logger = log.extend('backup.import')
let restoring = false

const schema = (db: SQLite.SQLiteDatabase) =>
	db.getAllSync<{ name: string; sql: string }>(
		"SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
	)

function validateDatabase(database: SQLite.SQLiteDatabase, reference = expoDb) {
	const checks = database.getAllSync<{ quick_check: string }>(
		'PRAGMA quick_check',
	)
	if (
		checks.length !== 1 ||
		checks[0].quick_check !== 'ok' ||
		database.getAllSync('PRAGMA foreign_key_check').length
	)
		throw new Error('备份数据库完整性检查失败')
	const invalidIdentity = database.getFirstSync<{ invalid: number }>(`
		SELECT (
		EXISTS(SELECT 1 FROM tracks t LEFT JOIN song_sources ss ON ss.source_key=t.unique_key WHERE ss.song_id IS NULL)
		OR EXISTS(SELECT 1 FROM library_songs s LEFT JOIN song_sources ss ON ss.source_key=s.active_source_key WHERE s.active_source_key IS NOT NULL AND (ss.song_id IS NULL OR ss.song_id<>s.id))
		OR EXISTS(SELECT 1 FROM playlists p LEFT JOIN playlist_identities i ON i.playlist_id=p.id WHERE i.id IS NULL)
		OR EXISTS(SELECT 1 FROM play_history h JOIN tracks t ON t.id=h.track_id LEFT JOIN history_source_snapshots hs ON hs.history_id=h.id WHERE hs.history_id IS NULL OR hs.source_key<>t.unique_key)
		OR EXISTS(SELECT 1 FROM sync_like l LEFT JOIN library_songs s ON s.id=l.song_id WHERE s.id IS NULL)
		OR EXISTS(SELECT 1 FROM sync_lyric l LEFT JOIN song_sources ss ON ss.source_key=l.source_key WHERE ss.source_key IS NULL)
		) AS invalid`)
	if (invalidIdentity?.invalid) throw new Error('备份歌曲或歌单身份关系无效')
	// Reject incompatible schemas before changing any live data. Existing migration records remain database-owned.

	if (JSON.stringify(schema(database)) !== JSON.stringify(schema(reference)))
		throw new Error('备份数据库结构与当前版本不兼容，请先使用匹配版本升级备份')
}

/** Validate and stage everything first; keep the shared database connection alive. */
export async function restoreBackup(
	filePath: string,
	options: { merge?: boolean; preferImportedMetadata?: boolean } = {},
): Promise<void> {
	if (restoring) throw new Error('正在恢复备份，请勿重复操作')
	restoring = true
	let committed = false
	let gated = false
	let staged: SQLite.SQLiteDatabase | undefined
	const stagingLyrics = new Directory(
		Paths.cache,
		`restore-lyrics-${Date.now()}`,
	)
	const stagingArtwork = new Directory(
		Paths.document,
		'covers',
		`import-${Date.now()}`,
	)
	try {
		const zip = await JSZip.loadAsync(new File(filePath).bytesSync())
		const manifestText = await zip.file('manifest.json')?.async('string')
		const databaseBytes = await zip.file('database.db')?.async('uint8array')
		if (!manifestText || !databaseBytes)
			throw new Error('备份文件缺少清单或数据库')
		const manifest = JSON.parse(manifestText) as BackupManifest
		if (manifest.version !== 2 && manifest.version !== BACKUP_VERSION)
			throw new Error('不支持的备份版本')
		if (
			!manifest.mmkv ||
			typeof manifest.mmkv['app-storage'] !== 'string' ||
			!manifest.orpheus
		)
			throw new Error('备份清单无效')
		let previousSettings = storage.getString('app-storage')
		let importedSettings = mergePreferences(
			previousSettings,
			manifest.mmkv['app-storage'] || '{}',
		)
		let nativeSettings = portableNativePreferences(manifest.orpheus.playerQueue)
		staged = SQLite.deserializeDatabaseSync(databaseBytes)
		if (
			options.merge &&
			!staged.getFirstSync(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='playlist_identities'",
			)
		)
			throw new Error(
				'此备份尚无稳定歌单身份，请使用完整恢复；升级后重新导出的备份可合并。',
			)
		await upgradeBackupSchema(staged)
		validateDatabase(staged)
		staged.execSync(
			'DELETE FROM sync_ack; DELETE FROM sync_head; DELETE FROM sync_operation; DELETE FROM sync_revision; DELETE FROM sync_meta; DELETE FROM playlist_sync_queue;',
		)
		stagingLyrics.create()
		const lyricEntries = Object.values(zip.files).filter(
			(entry) => !entry.dir && entry.name.startsWith('lyrics/'),
		)
		for (const entry of lyricEntries) {
			const name = entry.name.slice('lyrics/'.length)
			if (!/^[^/\\.][^/\\]*\.json$/.test(name) || name.includes('..'))
				throw new Error('备份歌词路径无效')
			// oxlint-disable-next-line no-await-in-loop
			const text = await entry.async('string')
			JSON.parse(text)
			new File(stagingLyrics, name).write(text)
		}
		for (const table of ['tracks', 'playlists']) {
			for (const row of staged.getAllSync<{ id: number; cover_url: string }>(
				`SELECT id,cover_url FROM ${table} WHERE cover_url LIKE 'backup-artwork://%'`,
			)) {
				const name = row.cover_url.slice('backup-artwork://'.length)
				if (!/^[a-f0-9]{64}\.img$/.test(name))
					throw new Error('备份封面路径无效')
				const entry = zip.file(`artworks/${name}`)
				if (!entry) throw new Error('备份缺少封面文件')
				if (
					CryptoJS.SHA256(await entry.async('base64')).toString() + '.img' !==
					name
				)
					throw new Error('备份封面内容校验失败')
				if (!stagingArtwork.exists)
					stagingArtwork.create({ intermediates: true })
				const file = new File(stagingArtwork, name)
				file.write(await entry.async('uint8array'))
				staged.runSync(`UPDATE ${table} SET cover_url=? WHERE id=?`, [
					file.uri,
					row.id,
				])
			}
		}
		await Orpheus.pause()
		await libraryRestoreGate.drain()
		gated = true
		previousSettings = storage.getString('app-storage')
		importedSettings = mergePreferences(
			previousSettings,
			manifest.mmkv['app-storage'] || '{}',
		)
		if (options.merge) {
			const imported = staged
			staged = SQLite.deserializeDatabaseSync(restoreDatabase.serializeSync())
			try {
				mergeLibraryDatabases(staged, imported, options.preferImportedMetadata)
				validateDatabase(staged, restoreDatabase)
			} finally {
				imported.closeSync()
			}
			const existingLyrics = new Directory(Paths.document, 'lyrics')
			if (existingLyrics.exists) {
				for (const entry of existingLyrics.list()) {
					if (!(entry instanceof File) || !entry.name.endsWith('.json'))
						continue
					const target = new File(stagingLyrics, entry.name)
					if (!target.exists || !options.preferImportedMetadata)
						target.write(entry.bytesSync())
				}
			}
			if (!options.preferImportedMetadata) {
				importedSettings = previousSettings ?? '{}'
				nativeSettings = portableNativePreferences(
					Orpheus.exportData().playerQueue,
				)
			}
		}
		staged.execSync(
			"DELETE FROM sync_ack; DELETE FROM sync_head; DELETE FROM sync_operation; DELETE FROM sync_revision; DELETE FROM sync_meta; INSERT INTO sync_meta(key,value) VALUES('paused','true');",
		)
		const rollbackDirectory = new Directory(
			Paths.document,
			'backups',
			`pre-restore-${Date.now()}`,
		)
		rollbackDirectory.create({ intermediates: true })
		const rollbackDatabase = new File(rollbackDirectory, 'database.db')
		rollbackDatabase.write(restoreDatabase.serializeSync())
		const oldNative = Orpheus.exportData()
		const oldStartup = storage.getString('startup_screen')
		new File(rollbackDirectory, 'preferences.json').write(
			JSON.stringify({
				preferences: exportPreferences(previousSettings),
				startupScreen: oldStartup,
				nativePreferences: portableNativePreferences(oldNative.playerQueue),
			}),
		)
		const lyrics = new Directory(Paths.document, 'lyrics')
		const oldLyrics = new Directory(rollbackDirectory, 'lyrics')
		let lyricsMoved = false
		let newLyricsMoved = false
		const rollback = SQLite.deserializeDatabaseSync(
			rollbackDatabase.bytesSync(),
		)
		try {
			// No awaits in the commit section: JS database writers cannot interleave.
			SQLite.backupDatabaseSync({
				sourceDatabase: staged,
				destDatabase: restoreDatabase,
			})
			if (manifest.version === BACKUP_VERSION || options.merge) {
				if (lyrics.exists) {
					lyrics.moveSync(oldLyrics)
					lyricsMoved = true
				}
				stagingLyrics.moveSync(new Directory(Paths.document, 'lyrics'))
				newLyricsMoved = true
			}
			storage.set('app-storage', importedSettings)
			if (
				(!options.merge || options.preferImportedMetadata) &&
				(manifest.mmkv.startup_screen === 'home' ||
					manifest.mmkv.startup_screen === 'library')
			)
				storage.set('startup_screen', manifest.mmkv.startup_screen)
			Orpheus.importData({ playerQueue: nativeSettings, loudness: {} })
		} catch (error) {
			SQLite.backupDatabaseSync({
				sourceDatabase: rollback,
				destDatabase: restoreDatabase,
			})
			if (newLyricsMoved) new Directory(Paths.document, 'lyrics').delete()
			if (lyricsMoved)
				oldLyrics.moveSync(new Directory(Paths.document, 'lyrics'))
			if (previousSettings === undefined) storage.remove('app-storage')
			else storage.set('app-storage', previousSettings)
			if (oldStartup === 'home' || oldStartup === 'library')
				storage.set('startup_screen', oldStartup)
			else storage.remove('startup_screen')
			Orpheus.importData({ playerQueue: oldNative.playerQueue, loudness: {} })
			throw error
		} finally {
			rollback.closeSync()
		}
		// Reopening application state is required; old queue callbacks must not overwrite restored state.
		restorePlaybackContextState()
		committed = true
		libraryRestoreGate.requireRestart()
		logger.info('备份已恢复；重启应用后生效，已保留恢复前数据')
		try {
			for (const entry of new Directory(Paths.document, 'backups').list()) {
				if (
					entry instanceof Directory &&
					/^pre-restore-\d+$/.test(entry.name) &&
					entry.uri !== rollbackDirectory.uri
				)
					entry.delete()
			}
		} catch (error) {
			logger.warning('旧恢复副本清理失败，已保留副本', { error })
		}
	} finally {
		if (gated && !committed) libraryRestoreGate.resume()
		staged?.closeSync()
		if (!committed && stagingArtwork.exists) stagingArtwork.delete()
		if (stagingLyrics.exists && stagingLyrics.uri.includes('/restore-lyrics-'))
			stagingLyrics.delete()
		restoring = false
	}
}
