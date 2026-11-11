import { normalizedLyricPresentation } from '@/lib/config/lyricPresentation'
import type { Settings } from '@/types/core/appStore'

const booleanKeys = [
	'sendPlayHistory',
	'enableDebugLog',
	'enableOldSchoolStyleLyric',
	'enableVerbatimLyrics',
	'enableDataCollection',
	'enableMinimalistMode',
	'allowSimultaneousPlayback',
	'hideStarPrompt',
] as const satisfies readonly (keyof Settings)[]

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	return value as Record<string, unknown>
}

/** A positive allowlist: new storage fields never silently enter a portable backup. */
export function portableSettings(value: unknown): Partial<Settings> {
	const input = record(value)
	const output: Partial<Settings> = {}
	if (record(input.lyricPresentation) === input.lyricPresentation)
		output.lyricPresentation = normalizedLyricPresentation(
			input.lyricPresentation,
		)
	for (const key of booleanKeys) {
		if (typeof input[key] === 'boolean') output[key] = input[key]
	}
	if (
		input.defaultPlayerMode === 'music' ||
		input.defaultPlayerMode === 'podcast'
	)
		output.defaultPlayerMode = input.defaultPlayerMode
	if (
		input.playerBackgroundStyle === 'gradient' ||
		input.playerBackgroundStyle === 'fluid'
	)
		output.playerBackgroundStyle = input.playerBackgroundStyle
	if (
		input.nowPlayingBarStyle === 'float' ||
		input.nowPlayingBarStyle === 'bottom'
	)
		output.nowPlayingBarStyle = input.nowPlayingBarStyle
	if (
		input.lyricSource === 'auto' ||
		input.lyricSource === 'netease' ||
		input.lyricSource === 'qqmusic' ||
		input.lyricSource === 'kugou'
	)
		output.lyricSource = input.lyricSource
	if (
		typeof input.downloadMaxParallelTasks === 'number' &&
		Number.isInteger(input.downloadMaxParallelTasks) &&
		input.downloadMaxParallelTasks >= 1 &&
		input.downloadMaxParallelTasks <= 10
	)
		output.downloadMaxParallelTasks = input.downloadMaxParallelTasks
	if (
		input.expandMultiPageOnSync === null ||
		typeof input.expandMultiPageOnSync === 'boolean'
	)
		output.expandMultiPageOnSync = input.expandMultiPageOnSync
	return output
}

export function exportPreferences(encoded?: string): string {
	const envelope = record(encoded ? JSON.parse(encoded) : {})
	return JSON.stringify({
		state: { settings: portableSettings(record(envelope.state).settings) },
		version: typeof envelope.version === 'number' ? envelope.version : 6,
	})
}

/** Keep this device's account credentials; ignore all account fields in old backups. */
export function mergePreferences(
	current: string | undefined,
	imported: string,
): string {
	const local = record(current ? JSON.parse(current) : {})
	const state = record(local.state)
	const incoming = record(JSON.parse(exportPreferences(imported)))
	return JSON.stringify({
		...local,
		state: {
			...state,
			settings: {
				...record(state.settings),
				...record(record(incoming.state).settings),
			},
		},
		version: local.version ?? 6,
	})
}

const nativeBooleans = [
	'config_equalizer_enabled',
	'config_restore_position_enabled',
	'config_loudness_normalization_enabled',
	'config_autoplay_on_start_enabled',
	'config_spectrum_visualizer_enabled',
	'config_status_bar_lyrics_enabled',
	'config_car_lyrics_enabled',
]
const nativeNumbers = [
	'config_desktop_lyrics_display_mode',
	'config_desktop_lyrics_highlight_color',
	'config_desktop_lyrics_text_size',
	'config_desktop_lyrics_y',
]

export function portableNativePreferences(
	value: unknown,
): Record<string, boolean | string | number> {
	const input = record(value)
	const output: Record<string, boolean | string | number> = {}
	if (['aac', 'lossless', 'dolby'].includes(String(input.config_audio_quality)))
		output.config_audio_quality = String(input.config_audio_quality)
	for (const key of nativeBooleans)
		if (typeof input[key] === 'boolean') output[key] = input[key]
	if (typeof input.config_equalizer_gains === 'string') {
		const gains = input.config_equalizer_gains.split(',').map(Number)
		if (
			gains.length === 10 &&
			gains.every((gain) => Number.isFinite(gain) && gain >= -12 && gain <= 12)
		)
			output.config_equalizer_gains = gains.join(',')
	}
	for (const key of nativeNumbers)
		if (typeof input[key] === 'number' && Number.isFinite(input[key]))
			output[key] = input[key]
	if (
		['superlyric', 'lyricon', 'meizu'].includes(
			String(input.config_status_bar_lyrics_provider),
		)
	)
		output.config_status_bar_lyrics_provider = String(
			input.config_status_bar_lyrics_provider,
		)
	return output
}
