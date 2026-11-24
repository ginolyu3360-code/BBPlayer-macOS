import { fetch } from 'expo/fetch'

import { parseSubtitleCues } from './subtitles'

const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024

export async function fetchSubtitles(url: string, signal: AbortSignal) {
	const response = await fetch(url, {
		credentials: 'omit',
		redirect: 'error',
		signal,
		headers: { Referer: 'https://www.bilibili.com/' },
	})
	if (!response.ok || !response.body)
		throw new Error('Subtitle download failed')

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	try {
		for (;;) {
			// Reads must be serial to maintain wire order and enforce the byte limit.
			// oxlint-disable-next-line no-await-in-loop
			const { done, value } = await reader.read()
			if (done) break
			totalBytes += value.byteLength
			if (totalBytes > MAX_SUBTITLE_BYTES) {
				// oxlint-disable-next-line no-await-in-loop
				await reader.cancel()
				throw new Error('Subtitle document is too large')
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	const json: unknown = JSON.parse(new TextDecoder().decode(bytes))
	return parseSubtitleCues(json)
}
