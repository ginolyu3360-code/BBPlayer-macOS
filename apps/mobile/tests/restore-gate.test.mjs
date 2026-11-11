import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const source = stripTypeScriptTypes(
	readFileSync(
		new URL('../src/lib/db/restoreGate.ts', import.meta.url),
		'utf8',
	),
).replace(/^export /gm, '')
const { createRestoreGate } = new vm.Script(
	`${source}\n;({createRestoreGate})`,
).runInNewContext({ Promise })

void test('restore waits for existing asynchronous writes and rejects new/stale prepared operations', async () => {
	let complete
	let writes = 0
	const gate = createRestoreGate({
		execAsync: () =>
			new Promise((resolve) => {
				complete = resolve
			}),
		prepareSync: () => ({
			executeSync() {
				writes++
			},
			finalizeSync() {},
		}),
	})
	const statement = gate.database.prepareSync()
	const active = gate.database.execAsync()
	let drained = false
	const waiting = gate.drain().then(() => {
		drained = true
	})
	await Promise.resolve()
	assert.equal(drained, false)
	assert.throws(() => statement.executeSync(), /重启/)
	statement.finalizeSync()
	complete()
	await active
	await waiting
	gate.requireRestart()
	assert.throws(() => gate.database.prepareSync(), /重启/)
	assert.equal(writes, 0)
})

void test('failed restore can resume the same shared database and prepared statements', async () => {
	let writes = 0
	const gate = createRestoreGate({
		prepareSync: () => ({
			executeSync() {
				writes++
			},
		}),
	})
	const statement = gate.database.prepareSync()
	await gate.drain()
	gate.resume()
	statement.executeSync()
	assert.equal(writes, 1)
})
