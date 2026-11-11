import SHA256 from 'crypto-js/sha256'
import type { Result } from 'neverthrow'
import { err, ok } from 'neverthrow'

import type { ServiceError } from '@/lib/errors'
import { createValidationError } from '@/lib/errors/service'
import type { TrackSourceData } from '@/types/services/track'

export default function generateUniqueTrackKey(
	payload: TrackSourceData,
): Result<string, ServiceError> {
	switch (payload.source) {
		case 'bilibili': {
			const biliMeta = payload.bilibiliMetadata
			if (!biliMeta.bvid) {
				return err(createValidationError('bvid 不存在'))
			}
			return biliMeta.isMultiPage
				? ok(`${payload.source}::${biliMeta.bvid}::${biliMeta.cid}`)
				: ok(`${payload.source}::${biliMeta.bvid}`)
		}
		case 'local': {
			const uri = payload.localMetadata.localPath
			if (!uri.startsWith('content://') && !uri.startsWith('file://'))
				return err(createValidationError('请选择本地音频文件'))
			return ok(`local::${SHA256(uri).toString()}`)
		}

		default:
			return err(
				createValidationError(
					`未知的 Track source: ${(payload as TrackSourceData).source}}`,
				),
			)
	}
}
