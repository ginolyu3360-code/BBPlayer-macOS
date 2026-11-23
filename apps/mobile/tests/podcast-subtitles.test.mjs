import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	currentSubtitleAt,
	formatSubtitlesAsSRT,
	parseSubtitleCues,
	subtitleCDNURL,
	subtitleTrackOptions,
} from '../src/features/player/utils/subtitles.ts'

void test('subtitle track identity survives a refreshed download URL', () => {
	const subtitles = [
		{
			id: 1,
			lan: 'zh',
			lan_doc: '中文',
			subtitle_url: '//aisubtitle.hdslb.com/zh.json?token=old',
		},
		{
			id_str: '4294967297',
			lan: 'en',
			subtitle_url: '//aisubtitle.hdslb.com/en.json?token=old',
		},
	]
	const oldSelection = subtitleTrackOptions(subtitles)[1]
	const refreshed = subtitleTrackOptions([
		{
			...subtitles[1],
			subtitle_url: '//aisubtitle.hdslb.com/en.json?token=new',
		},
		subtitles[0],
		{ ...subtitles[0] },
	])
	assert.equal(refreshed.length, 2)
	assert.equal(refreshed[0].id, oldSelection.id)
	assert.equal(refreshed[0].name, oldSelection.name)
	assert.notEqual(refreshed[0].url, oldSelection.url)
})

void test('subtitles accept the HTTPS CDN URL and reject misleading or nonstandard origins', () => {
	assert.equal(
		subtitleCDNURL(
			'//aisubtitle.hdslb.com/bfs/ai_subtitle/a.json?token=example',
		),
		'https://aisubtitle.hdslb.com/bfs/ai_subtitle/a.json?token=example',
	)
	for (const url of [
		'http://aisubtitle.hdslb.com/a',
		'https://aisubtitle.hdslb.com.example.com/a',
		'https://user@aisubtitle.hdslb.com/a',
		'https://aisubtitle.hdslb.com:444/a',
		'https://127.0.0.1/a',
	])
		assert.equal(subtitleCDNURL(url), undefined)
})

void test('subtitle lookup follows sorted intervals through a gap and an overlap', () => {
	const cues = parseSubtitleCues({
		body: [
			{ from: 8, to: 9, content: '结束' },
			{ from: 1, to: 5, content: '开头' },
			{ from: 2, to: 3, content: '插话' },
			{ from: 3, to: 2, content: '无效' },
			{ from: 3, to: 4, content: ' ' },
		],
	})
	assert.equal(cues.length, 3)
	assert.equal(currentSubtitleAt(cues, 0), undefined)
	assert.equal(currentSubtitleAt(cues, 1)?.content, '开头')
	assert.equal(currentSubtitleAt(cues, 2.5)?.content, '插话')
	assert.equal(currentSubtitleAt(cues, 3)?.content, '开头')
	assert.equal(currentSubtitleAt(cues, 5), undefined)
	assert.equal(currentSubtitleAt(cues, 8)?.content, '结束')
	assert.equal(currentSubtitleAt(cues, 9), undefined)
})

void test('malformed documents fail as errors instead of appearing to have no subtitles', () => {
	assert.deepEqual(parseSubtitleCues({ body: [] }), [])
	assert.throws(
		() => parseSubtitleCues({ body: 'invalid' }),
		/Invalid subtitle response/,
	)
	assert.throws(
		() =>
			parseSubtitleCues({ body: [{ from: 0, to: Infinity, content: 'a' }] }),
		/Invalid subtitle cues/,
	)
})

void test('SRT preserves multilingual text and rounds timestamps across minute boundaries', () => {
	const cues = parseSubtitleCues({
		body: [
			{ from: 59.9998, to: 60.042, content: '中文\r\n\r\n第二行' },
			{ from: 3600, to: 3600.0001, content: 'English' },
		],
	})
	assert.equal(
		formatSubtitlesAsSRT(cues),
		'1\n00:01:00,000 --> 00:01:00,042\n中文\n第二行\n\n2\n01:00:00,000 --> 01:00:00,001\nEnglish\n',
	)
})
