import type { BilibiliSubtitleTrack } from '@/types/apis/bilibili'

export interface SubtitleCue {
	id: number
	from: number
	to: number
	content: string
}

export function subtitleTrackOptions(
	tracks: BilibiliSubtitleTrack[] | undefined,
) {
	const options = new Map<string, { id: string; url: string; name: string }>()
	if (!Array.isArray(tracks)) return []
	for (const track of tracks) {
		const url = subtitleCDNURL(track?.subtitle_url)
		if (!url) continue
		const language = typeof track.lan === 'string' ? track.lan.trim() : ''
		const label = typeof track.lan_doc === 'string' ? track.lan_doc.trim() : ''
		const id =
			(typeof track.id_str === 'string' && track.id_str.trim()) ||
			(typeof track.id === 'number' && Number.isFinite(track.id)
				? String(track.id)
				: language || url)
		if (!options.has(id))
			options.set(id, { id, url, name: label || language || '字幕' })
	}
	return Array.from(options.values())
}

export function subtitleCDNURL(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > 4096) return
	try {
		const url = new URL(value.startsWith('//') ? 'https:' + value : value)
		const allowedHost =
			url.hostname.endsWith('.hdslb.com') ||
			url.hostname === 'subtitle.bilibili.com'
		if (
			url.protocol === 'https:' &&
			allowedHost &&
			!url.port &&
			!url.username &&
			!url.password
		)
			return url.href
	} catch {
		return undefined
	}
}

export function parseSubtitleCues(value: unknown): SubtitleCue[] {
	if (
		!value ||
		typeof value !== 'object' ||
		!('body' in value) ||
		!Array.isArray(value.body)
	)
		throw new Error('Invalid subtitle response')
	if (value.body.length > 50_000) throw new Error('Too many subtitle cues')

	const cues: SubtitleCue[] = []
	for (const [id, cue] of value.body.entries()) {
		if (!cue || typeof cue !== 'object') continue
		const { from, to, content } = cue as Record<string, unknown>
		if (
			typeof from !== 'number' ||
			!Number.isFinite(from) ||
			from < 0 ||
			typeof to !== 'number' ||
			!Number.isFinite(to) ||
			to <= from ||
			to > 7 * 24 * 60 * 60 ||
			typeof content !== 'string' ||
			!content.trim()
		)
			continue
		cues.push({ id, from, to, content: content.trim() })
	}
	if (value.body.length && !cues.length)
		throw new Error('Invalid subtitle cues')
	return cues.sort((a, b) => a.from - b.from)
}

export function currentSubtitleAt(
	cues: SubtitleCue[],
	seconds: number,
): SubtitleCue | undefined {
	if (!Number.isFinite(seconds) || seconds < 0) return undefined
	let low = 0
	let high = cues.length
	while (low < high) {
		const mid = Math.floor((low + high) / 2)
		if (cues[mid].from <= seconds) low = mid + 1
		else high = mid
	}
	for (let i = low - 1; i >= 0; i--) {
		if (cues[i].to > seconds) return cues[i]
	}
}

function srtTimestamp(seconds: number) {
	const totalMillis = Math.round(seconds * 1000)
	const parts = [
		Math.floor(totalMillis / 3_600_000),
		Math.floor(totalMillis / 60_000) % 60,
		Math.floor(totalMillis / 1000) % 60,
	]
	return (
		parts.map((part) => String(part).padStart(2, '0')).join(':') +
		',' +
		String(totalMillis % 1000).padStart(3, '0')
	)
}

export function formatSubtitlesAsSRT(cues: SubtitleCue[]) {
	return cues
		.map((cue, index) =>
			[
				String(index + 1),
				srtTimestamp(cue.from) +
					' --> ' +
					srtTimestamp(Math.max(cue.to, cue.from + 0.001)),
				cue.content.replace(/\r\n?/g, '\n').replace(/\n(?:[ \t]*\n)+/g, '\n'),
				'',
			].join('\n'),
		)
		.join('\n')
}
