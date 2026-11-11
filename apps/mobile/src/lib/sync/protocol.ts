import { Buffer } from 'buffer'

export interface SyncTrack {
	id: string
	bvid: string
	cid?: number
	title: string
	artist: string
	coverURL?: string
	duration: number
	source: 'bilibili'
}
export interface SyncLyrics {
	lines: {
		start: number
		end: number
		text: string
		words: { start: number; end: number; text: string }[]
		translation?: string
		romanization?: string
	}[]
	source: string
	offset: number
}
export interface SyncValue {
	text?: string
	flag?: boolean
	order?: string[]
	source?: { songID: string; track: SyncTrack }
	lyrics?: SyncLyrics
}
export interface SyncOperation {
	version: 1
	id: string
	actor: string
	sequence: number
	context: Record<string, number>
	entity: string
	field: string
	value: SyncValue
}
export interface SyncSeed {
	version: 1
	operations: SyncOperation[]
}
export interface SyncConflict {
	entity: string
	field: string
	variants: SyncOperation[]
}
const uuid = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(value)
const integer = (value: unknown): value is number =>
	typeof value === 'number' &&
	Number.isSafeInteger(value) &&
	value >= 0 &&
	value < Number.MAX_SAFE_INTEGER
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value)

/** Validate before persisting or acknowledging an untrusted peer payload. */
export function validateSyncOperation(
	input: unknown,
): asserts input is SyncOperation {
	if (
		!record(input) ||
		input.version !== 1 ||
		!uuid(input.id) ||
		!uuid(input.actor) ||
		!integer(input.sequence) ||
		input.sequence === 0 ||
		!record(input.context) ||
		Object.keys(input.context).length > 64 ||
		!Object.entries(input.context).every(
			([key, value]) => uuid(key) && integer(value),
		) ||
		(input.context[input.actor] ?? 0) !== input.sequence - 1 ||
		typeof input.entity !== 'string' ||
		typeof input.field !== 'string' ||
		!record(input.value) ||
		bytes(JSON.stringify(input)) > 1_048_576
	)
		throw new Error('Invalid sync operation')
	const { entity, field, value } = input
	if (
		Object.values(value).filter(
			(member) => member !== undefined && member !== null,
		).length !== 1
	)
		throw new Error('Invalid sync value')
	if (
		entity.startsWith('playlist:') &&
		entity.length > 9 &&
		bytes(entity) <= 512
	) {
		if (
			field === 'title' &&
			typeof value.text === 'string' &&
			bytes(value.text) > 0 &&
			bytes(value.text) <= 4096
		)
			return
		if (
			(field === 'deleted' ||
				(field.startsWith('entry:') && uuid(field.slice(6)))) &&
			typeof value.flag === 'boolean'
		)
			return
		if (
			field === 'order' &&
			Array.isArray(value.order) &&
			value.order.length <= 10_000 &&
			value.order.every(uuid) &&
			new Set(value.order).size === value.order.length
		)
			return
	}
	if (entity.startsWith('song:') && uuid(entity.slice(5))) {
		if (field === 'liked' && typeof value.flag === 'boolean') return
		if (
			(field === 'source' || field.startsWith('archive:')) &&
			record(value.source) &&
			value.source.songID === entity.slice(5) &&
			record(value.source.track)
		) {
			const track = value.source.track
			const validCover =
				track.coverURL === undefined ||
				(() => {
					try {
						if (typeof track.coverURL !== 'string') return false
						const url = new URL(track.coverURL)
						return (
							url.protocol === 'https:' &&
							!url.username &&
							!url.password &&
							!url.search &&
							!url.hash
						)
					} catch {
						return false
					}
				})()
			if (
				(!field.startsWith('archive:') || field.slice(8) === track.id) &&
				track.source === 'bilibili' &&
				typeof track.bvid === 'string' &&
				track.bvid.length > 0 &&
				!/[/:]/.test(track.bvid) &&
				(track.id === `bilibili:${track.bvid}:video` ||
					(integer(track.cid) &&
						track.id === `bilibili:${track.bvid}:${track.cid}`)) &&
				(track.cid === undefined || integer(track.cid)) &&
				typeof track.title === 'string' &&
				typeof track.artist === 'string' &&
				typeof track.duration === 'number' &&
				Number.isFinite(track.duration) &&
				track.duration >= 0 &&
				track.localFileURL === undefined &&
				track.localFileBookmark === undefined &&
				validCover
			)
				return
		}
	}
	if (
		entity.startsWith('source:bilibili:') &&
		field === 'lyrics' &&
		record(value.lyrics)
	) {
		const lyrics = value.lyrics
		if (
			typeof lyrics.offset === 'number' &&
			Number.isFinite(lyrics.offset) &&
			typeof lyrics.source === 'string' &&
			Array.isArray(lyrics.lines) &&
			lyrics.lines.every(
				(line: unknown) =>
					record(line) &&
					typeof line.text === 'string' &&
					Number.isFinite(line.start) &&
					Number.isFinite(line.end) &&
					Array.isArray(line.words) &&
					line.words.every(
						(word: unknown) =>
							record(word) &&
							typeof word.text === 'string' &&
							Number.isFinite(word.start) &&
							Number.isFinite(word.end),
					),
			)
		)
			return
	}
	throw new Error('Invalid sync field or value')
}

export function canonicalJSON(value: unknown): string {
	if (Array.isArray(value))
		return '[' + value.map(canonicalJSON).join(',') + ']'
	if (record(value))
		return (
			'{' +
			Object.keys(value)
				.filter((key) => value[key] !== undefined)
				.sort()
				.map((key) => JSON.stringify(key) + ':' + canonicalJSON(value[key]))
				.join(',') +
			'}'
		)
	return JSON.stringify(value)
}

// Source identity is derived from the stored source key, never from the resolved actual CID.
export function wireSourceKey(mobileKey: string): string {
	const parts = mobileKey.split('::')
	if (
		parts[0] !== 'bilibili' ||
		!parts[1] ||
		parts.length < 2 ||
		parts.length > 3 ||
		(parts.length === 3 && !/^\d+$/.test(parts[2]))
	)
		throw new Error('Invalid Bilibili source key')
	return `bilibili:${parts[1]}:${parts[2] ?? 'video'}`
}
export function mobileSourceKey(wireKey: string): string {
	const match = /^bilibili:([^/:]+):(video|\d+)$/.exec(wireKey)
	if (!match) throw new Error('Invalid wire source key')
	return `bilibili::${match[1]}${match[2] === 'video' ? '' : '::' + match[2]}`
}
