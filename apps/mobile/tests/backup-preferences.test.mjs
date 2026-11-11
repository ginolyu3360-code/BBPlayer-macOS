import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const source = stripTypeScriptTypes(
	readFileSync(
		new URL('../src/lib/backup/preferences.ts', import.meta.url),
		'utf8',
	),
)
	.replace(/^import .*$/gm, '')
	.replace(/^export /gm, '')
const presentation = stripTypeScriptTypes(
	readFileSync(
		new URL('../src/lib/config/lyricPresentation.ts', import.meta.url),
		'utf8',
	),
).replace(/^export /gm, '')
const { normalizedLyricPresentation } = new vm.Script(
	presentation + ';({normalizedLyricPresentation})',
).runInNewContext()
const policy = new vm.Script(
	`${source}\n;({exportPreferences,mergePreferences,portableNativePreferences})`,
).runInNewContext({ normalizedLyricPresentation })

void test('portable export excludes account secrets and future fields even in legacy backups', () => {
	const raw = JSON.stringify({
		version: 6,
		state: {
			bilibiliCookie: { SESSDATA: 'private-cookie' },
			bbplayerToken: 'private-token',
			settings: {
				enableVerbatimLyrics: true,
				futureSecret: 'secret',
				downloadMaxParallelTasks: 999,
			},
		},
	})
	const result = JSON.parse(policy.exportPreferences(raw))
	assert.deepEqual(result, {
		version: 6,
		state: { settings: { enableVerbatimLyrics: true } },
	})
})

void test('import keeps this device credentials and applies only validated preferences', () => {
	const current = JSON.stringify({
		version: 6,
		state: {
			bbplayerToken: 'local-token',
			bilibiliCookie: { SESSDATA: 'local-cookie' },
			settings: { lyricSource: 'auto', enableDataCollection: false },
		},
	})
	const imported = JSON.stringify({
		state: {
			bbplayerToken: 'foreign-token',
			settings: {
				lyricSource: 'qqmusic',
				enableDataCollection: 'true',
				defaultPlayerMode: 'invalid',
			},
		},
	})
	const result = JSON.parse(policy.mergePreferences(current, imported))
	assert.equal(result.state.bbplayerToken, 'local-token')
	assert.equal(result.state.bilibiliCookie.SESSDATA, 'local-cookie')
	assert.deepEqual(result.state.settings, {
		lyricSource: 'qqmusic',
		enableDataCollection: false,
	})
})

void test('native preferences exclude queue, URIs, position and unknown or malformed values', () => {
	const result = policy.portableNativePreferences({
		saved_queue_json_list: 'private-uri',
		saved_position: 200,
		config_status_bar_lyrics_enabled: true,
		config_status_bar_lyrics_provider: 'unknown',
		config_desktop_lyrics_text_size: Number.NaN,
	})
	assert.deepEqual(JSON.parse(JSON.stringify(result)), {
		config_status_bar_lyrics_enabled: true,
	})
})

void test('malformed preference JSON fails before any restore mutation', () => {
	assert.throws(() => policy.mergePreferences('{}', '{invalid'))
})
