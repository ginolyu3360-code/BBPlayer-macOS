import { readAudioFileAsync } from '@bbplayer/native'

import { createProtectionBackup } from '@/lib/backup/automatic'
import { expoDb } from '@/lib/db/db'
import type { Track } from '@/types/core/media'
import { returnOrThrowAsync } from '@/utils/neverthrow-utils'

import { artistService } from './artistService'
import { trackService } from './trackService'

export async function importLocalAudio(
	uri: string,
	name: string,
): Promise<Track> {
	const audio = await readAudioFileAsync(uri, true)
	const artist = audio.artist
		? await returnOrThrowAsync(
				artistService.findOrCreateArtist({
					source: 'local',
					name: audio.artist,
				}),
			)
		: null
	return returnOrThrowAsync(
		trackService.findOrCreateTrack({
			source: 'local',
			title: audio.title?.trim() || name.replace(/\.[^.]+$/, ''),
			artistId: artist?.id,
			duration: audio.duration,
			localMetadata: { localPath: uri },
		}),
	)
}

export async function relinkLocalAudio(
	track: Track,
	uri: string,
): Promise<void> {
	if (track.source !== 'local') throw new Error('只有本地音频可以重新关联文件')
	const audio = await readAudioFileAsync(uri, true)
	await createProtectionBackup()
	expoDb.withTransactionSync(() => {
		const result = expoDb.runSync(
			'UPDATE local_metadata SET local_path=? WHERE track_id=?',
			[audio.uri, track.id],
		)
		if (result.changes !== 1) throw new Error('歌曲已变化，请刷新后重试')
		if (audio.duration > 0)
			expoDb.runSync('UPDATE tracks SET duration=?,updated_at=? WHERE id=?', [
				audio.duration,
				Date.now(),
				track.id,
			])
	})
}
