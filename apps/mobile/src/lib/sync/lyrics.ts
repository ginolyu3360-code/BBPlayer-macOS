import { formatSplTime, parseAndMergeLyrics } from '@bbplayer/splash'

import type { LyricFileData } from '@/types/player/lyrics'

import type { SyncLyrics } from './protocol'

const time = (seconds: number) => formatSplTime(seconds * 1000)
const text = (value: string) => value.replace(/[\r\n]/g, ' ')

export function mobileLyrics(
	document: SyncLyrics,
	uniqueKey: string,
): LyricFileData {
	return {
		id: uniqueKey,
		updateTime: Date.now(),
		lrc: document.lines
			.map(
				(line) =>
					`[${time(line.start)}]` +
					(line.words.length
						? line.words
								.map(
									(word) =>
										`<${time(word.start)}>${text(word.text)}<${time(word.end)}>`,
								)
								.join('')
						: text(line.text) + `<${time(Math.max(line.start, line.end))}>`),
			)
			.join('\n'),
		tlyric: document.lines
			.filter((line) => line.translation !== undefined)
			.map((line) => `[${time(line.start)}]${text(line.translation!)}`)
			.join('\n'),
		romalrc: document.lines
			.filter((line) => line.romanization !== undefined)
			.map((line) => `[${time(line.start)}]${text(line.romanization!)}`)
			.join('\n'),
		misc: { userOffset: document.offset },
	}
}
export function wireLyrics(lyrics: LyricFileData): SyncLyrics {
	return {
		source: 'manual',
		offset: lyrics.misc?.userOffset ?? 0,
		lines: parseAndMergeLyrics({
			lrc: lyrics.lrc ?? '',
			tlyric: lyrics.tlyric,
			romalrc: lyrics.romalrc,
		}).map((line) => ({
			start: line.startTime / 1000,
			end: line.endTime / 1000,
			text: line.content,
			words: line.isDynamic
				? line.spans.map((span) => ({
						text: span.text,
						start: span.startTime / 1000,
						end: span.endTime / 1000,
					}))
				: [],
			translation: line.translation,
			romanization: line.romaji,
		})),
	}
}
