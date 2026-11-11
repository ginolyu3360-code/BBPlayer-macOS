import { Orpheus } from '@bbplayer/orpheus'
import CryptoJS from 'crypto-js'
import { Directory, File, Paths } from 'expo-file-system'
import * as SQLite from 'expo-sqlite'
import JSZip from 'jszip'

import { expoDb } from '@/lib/db/db'
import log from '@/utils/log'
import { storage } from '@/utils/mmkv'
import { getStartupScreen } from '@/utils/startup-screen'

import { exportPreferences, portableNativePreferences } from './preferences'
import { BACKUP_VERSION } from './types'
import type { BackupManifest } from './types'

const logger = log.extend('backup.export')

/**
 * 创建完整备份文件，返回备份文件的 URI。
 *
 * 备份是 ZIP 格式，包含：
 * - `database.db`   — VACUUM INTO 生成的 SQLite 快照
 * - `manifest.json` — 允许导出的偏好，不包含账号凭据或播放队列
 */
export async function createBackup(): Promise<string> {
	return (await createBackupArtifact()).uri
}

export async function createBackupArtifact(): Promise<{
	uri: string
	fingerprint: string
}> {
	const cacheDir = new Directory(Paths.cache)
	const dbBackupFile = new File(cacheDir, `backup-db-${Date.now()}.db`)

	try {
		// 1. SQLite 快照：VACUUM INTO 保证一致性，无需关闭连接
		const dbBackupPath = dbBackupFile.uri.replace('file://', '')
		expoDb.execSync(`VACUUM INTO '${dbBackupPath.replaceAll("'", "''")}'`)
		logger.debug('数据库快照已创建')

		const zip = new JSZip()
		const libraryHash = CryptoJS.algo.SHA256.create()
		const snapshot = SQLite.deserializeDatabaseSync(dbBackupFile.bytesSync())
		try {
			snapshot.execSync(
				'DELETE FROM sync_ack; DELETE FROM sync_head; DELETE FROM sync_operation; DELETE FROM sync_revision; DELETE FROM sync_meta; DELETE FROM playlist_sync_queue; UPDATE playlists SET share_id=NULL,share_role=NULL,last_share_sync_at=NULL,last_synced_at=NULL;',
			)
			const ownedRoot = new Directory(Paths.document, 'covers').uri + '/'
			for (const table of ['tracks', 'playlists']) {
				for (const row of snapshot.getAllSync<{
					id: number
					cover_url: string
				}>(`SELECT id,cover_url FROM ${table} WHERE cover_url IS NOT NULL`)) {
					if (!row.cover_url.startsWith(ownedRoot)) continue
					const file = new File(row.cover_url)
					if (!file.exists) continue
					const name = CryptoJS.SHA256(file.base64Sync()).toString() + '.img'
					zip.file(`artworks/${name}`, file.bytesSync())
					snapshot.runSync(`UPDATE ${table} SET cover_url=? WHERE id=?`, [
						`backup-artwork://${name}`,
						row.id,
					])
				}
			}
			for (const table of [
				'artists',
				'tracks',
				'bilibili_metadata',
				'local_metadata',
				'playlists',
				'playlist_identities',
				'playlist_tracks',
				'dynamic_playlist_sources',
				'play_history',
				'history_source_snapshots',
				'library_songs',
				'song_sources',
				'sync_like',
				'sync_lyric',
			]) {
				libraryHash.update(
					table +
						':' +
						JSON.stringify(
							snapshot
								.getAllSync(`SELECT * FROM ${table}`)
								.map((row) => JSON.stringify(row))
								.sort(),
						),
				)
			}
			// Repack after runtime deletion so deleted log bytes do not enter the archive.
			snapshot.execSync('VACUUM')
			dbBackupFile.write(snapshot.serializeSync())
		} finally {
			snapshot.closeSync()
		}
		const dbBase64 = dbBackupFile.base64Sync()

		const manifest: BackupManifest = {
			version: BACKUP_VERSION,
			exportedAt: new Date().toISOString(),
			mmkv: {
				startup_screen: getStartupScreen(),
				'app-storage': exportPreferences(storage.getString('app-storage')),
				'playback-context-store': '',
				'shared-playlist-members': '',
			},
			orpheus: {
				playerQueue: portableNativePreferences(
					Orpheus.exportData().playerQueue,
				),
				loudness: {},
			},
		}

		const hash = CryptoJS.algo.SHA256.create()
		hash.update(libraryHash.finalize().toString())
		hash.update(JSON.stringify({ ...manifest, exportedAt: undefined }))
		for (const name of Object.keys(zip.files).sort()) {
			const content = await zip.files[name].async('base64')
			hash.update(name + ':' + content)
		}
		const lyrics = new Directory(Paths.document, 'lyrics')
		if (lyrics.exists) {
			for (const file of lyrics
				.list()
				.sort((a, b) => a.name.localeCompare(b.name))) {
				if (file instanceof File && file.name.endsWith('.json')) {
					hash.update(file.name + ':' + file.base64Sync())
					zip.file(`lyrics/${file.name}`, file.bytesSync())
				}
			}
		}
		zip.file('database.db', dbBase64, { base64: true })
		zip.file('manifest.json', JSON.stringify(manifest, null, 2))

		const zipData = await zip.generateAsync({ type: 'uint8array' })
		const zipFile = new File(cacheDir, `bbplayer-backup-${Date.now()}.bbplayer`)
		zipFile.write(zipData)

		logger.info('备份创建完成', { uri: zipFile.uri })
		return { uri: zipFile.uri, fingerprint: hash.finalize().toString() }
	} finally {
		if (dbBackupFile.exists) {
			dbBackupFile.delete()
		}
	}
}
