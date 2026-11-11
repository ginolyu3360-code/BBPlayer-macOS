import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
const source = readFileSync(
	new URL('../src/utils/player.ts', import.meta.url),
	'utf8',
)
const body = source.slice(
	source.indexOf('function getInternalPlayUri'),
	source.indexOf('async function finalizeAndRecordCurrentTrack'),
)
const getInternalPlayUri = new vm.Script(
	stripTypeScriptTypes(body) + ';getInternalPlayUri',
).runInNewContext({ Orpheus: { audioQuality: 'aac' } })
void test('known default-part CID is retained in playback requests without changing stored track identity', () => {
	const track = {
		source: 'bilibili',
		uniqueKey: 'bilibili::BV1',
		bilibiliMetadata: { bvid: 'BV1', cid: 77, isMultiPage: false },
	}
	assert.match(getInternalPlayUri(track), /&cid=77&/)
	assert.equal(track.uniqueKey, 'bilibili::BV1')
	assert.doesNotMatch(
		getInternalPlayUri({
			...track,
			bilibiliMetadata: { ...track.bilibiliMetadata, cid: null },
		}),
		/cid=/,
	)
	assert.equal(
		getInternalPlayUri({
			source: 'local',
			localMetadata: { localPath: 'content://original' },
		}),
		'content://original',
	)
})
