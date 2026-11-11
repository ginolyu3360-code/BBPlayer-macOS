import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
const source = stripTypeScriptTypes(
	readFileSync(new URL('../src/lib/sync/order.ts', import.meta.url), 'utf8'),
)
	.replace(/^import .*$/gm, '')
	.replace(/^export /gm, '')
const causalNetworkOrder = new vm.Script(
	source + ';causalNetworkOrder',
).runInNewContext()
const fixture = JSON.parse(
	readFileSync(
		new URL(
			'../../macos/Tests/BBPlayerCoreTests/Fixtures/sync-order-v1.json',
			import.meta.url,
		),
		'utf8',
	),
)
const operations = fixture.operations
void test('new and re-added entries append once; only later explicit order changes move them; causal replay is batch independent', () => {
	for (const { sequence, expected } of fixture.cases) {
		const history = operations.filter((op) => op.sequence <= sequence)
		const winner = history.at(-1)
		assert.deepEqual(Array.from(causalNetworkOrder(winner, history)), expected)
		assert.deepEqual(
			Array.from(causalNetworkOrder(winner, history.toReversed())),
			expected,
		)
	}
})
