import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
const require = createRequire(new URL('../package.json', import.meta.url))
const { register } = require('tsx/cjs/api')
register()
const { mobileLyrics, wireLyrics } = require('./src/lib/sync/lyrics.ts')
void test('wire lyrics retain word timing, translations, romanization and source-specific offset through the existing SPL parser', () => {
	const input = {
		source: 'manual',
		offset: 0.25,
		lines: [
			{
				start: 1,
				end: 3,
				text: 'Hello world',
				translation: '你好',
				romanization: 'ni hao',
				words: [
					{ text: 'Hello ', start: 1, end: 1.5 },
					{ text: 'world', start: 2, end: 3 },
				],
			},
		],
	}
	const mobile = mobileLyrics(input, 'bilibili::BV1::77')
	const output = wireLyrics(mobile)
	assert.equal(mobile.id, 'bilibili::BV1::77')
	assert.equal(output.offset, 0.25)
	assert.equal(output.lines[0].text, input.lines[0].text)
	assert.equal(output.lines[0].translation, '你好')
	assert.equal(output.lines[0].romanization, 'ni hao')
	assert.deepEqual(
		output.lines[0].words.filter((word) => word.text),
		input.lines[0].words,
	)
})
