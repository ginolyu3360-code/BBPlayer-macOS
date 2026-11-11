import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import vm from 'node:vm'
const protocolSource = stripTypeScriptTypes(
	readFileSync(new URL('../src/lib/sync/protocol.ts', import.meta.url), 'utf8'),
)
	.replace(/^import .*$/gm, '')
	.replace(/^export /gm, '')
const protocol = new vm.Script(
	`${protocolSource};({canonicalJSON,validateSyncOperation,wireSourceKey,mobileSourceKey})`,
).runInNewContext({ Buffer, URL })
const engineSource = stripTypeScriptTypes(
	readFileSync(new URL('../src/lib/sync/engine.ts', import.meta.url), 'utf8'),
	{ mode: 'transform' },
)
	.replace(/^import[\s\S]*?from ['"][^'"]+['"];?$/gm, '')
	.replace(/^export /gm, '')
const { SyncEngine } = new vm.Script(
	`${engineSource};({SyncEngine})`,
).runInNewContext({ ...protocol, Buffer })
const seed = JSON.parse(
	readFileSync(
		new URL(
			'../../macos/Tests/BBPlayerCoreTests/Fixtures/sync-v1.json',
			import.meta.url,
		),
		'utf8',
	),
)
const actorA = '00000000-0000-0000-0000-000000000001'
const actorB = '00000000-0000-0000-0000-000000000002'
function fixture(actor = actorB, project = () => {}) {
	const db = new DatabaseSync(':memory:')
	db.exec(
		readFileSync(
			new URL('../drizzle/0025_lan_sync_log.sql', import.meta.url),
			'utf8',
		),
	)
	const adapter = {
		getAllSync: (sql, args = []) => db.prepare(sql).all(...args),
		getFirstSync: (sql, args = []) => db.prepare(sql).get(...args),
		runSync: (sql, args = []) => db.prepare(sql).run(...args),
		withTransactionSync(body) {
			db.exec('BEGIN')
			try {
				body()
				db.exec('COMMIT')
			} catch (error) {
				db.exec('ROLLBACK')
				throw error
			}
		},
	}
	let counter = 200
	const engine = new SyncEngine(
		adapter,
		actor,
		() => `00000000-0000-0000-0000-${String(counter++).padStart(12, '0')}`,
		project,
	)
	return { db, engine }
}
void test('Swift fixture survives reordered delivery, idempotent retries and durable per-peer acknowledgements', () => {
	const h = fixture()
	try {
		assert.equal(h.engine.receive(seed.operations.slice(1)).length, 0)
		assert.equal(h.engine.exportSeed().operations.length, 0)
		h.engine.receive([seed.operations[0]])
		assert.equal(h.engine.exportSeed().operations.length, 4)
		assert.equal(h.engine.receive(seed.operations).length, 4)
		assert.equal(h.engine.outbox('peer1').length, 4)
		h.engine.acknowledge(
			'peer1',
			seed.operations.map((op) => op.id),
		)
		assert.equal(h.engine.outbox('peer1').length, 0)
		assert.equal(h.engine.outbox('peer2').length, 4)
		assert.equal(
			h.db.prepare('SELECT COUNT(*) AS n FROM sync_operation').get().n,
			4,
		)
	} finally {
		h.db.close()
	}
})
void test('concurrent title edits remain visible conflicts until a causal resolution supersedes both', () => {
	const h = fixture()
	try {
		h.engine.applySeed(seed)
		const local = h.engine.record(seed.operations[1].entity, 'title', {
			text: 'Local',
		})
		const remote = {
			...seed.operations[1],
			id: '00000000-0000-0000-0000-000000000999',
			sequence: 5,
			context: { [actorA]: 4 },
			value: { text: 'Remote' },
		}
		h.engine.receive([remote])
		assert.equal(
			h.engine.conflicts().filter((conflict) => conflict.field === 'title')
				.length,
			1,
		)
		const resolution = h.engine.record(local.entity, 'title', {
			text: 'Resolved',
		})
		assert.equal(resolution.context[actorA], 5)
		assert.equal(h.engine.conflicts().length, 0)
	} finally {
		h.db.close()
	}
})
void test('projection failure atomically rolls back the log, revisions, and acknowledgement eligibility', () => {
	const h = fixture(actorB, () => {
		throw new Error('source ownership conflict')
	})
	try {
		assert.throws(() => h.engine.applySeed(seed), /source ownership/)
		assert.equal(
			h.db.prepare('SELECT COUNT(*) AS n FROM sync_operation').get().n,
			0,
		)
		assert.equal(
			h.db.prepare('SELECT COUNT(*) AS n FROM sync_revision').get().n,
			0,
		)
	} finally {
		h.db.close()
	}
})
void test('collision, malformed values and paused-after-restore writes are rejected', () => {
	const h = fixture()
	try {
		h.engine.applySeed(seed)
		assert.throws(
			() =>
				h.engine.receive([
					{ ...seed.operations[1], value: { text: 'tampered' } },
				]),
			/collision/,
		)
		assert.throws(
			() =>
				protocol.validateSyncOperation({
					...seed.operations[1],
					value: { text: 'text', flag: true },
				}),
			/Invalid/,
		)
		h.db.exec("INSERT INTO sync_meta VALUES('paused','true')")
		assert.throws(
			() => h.engine.record('playlist:x', 'title', { text: 'blocked' }),
			/同步已暂停/,
		)
	} finally {
		h.db.close()
	}
})
void test('source key conversion retains default-video identity even when actual CID is known', () => {
	assert.equal(protocol.wireSourceKey('bilibili::BV1'), 'bilibili:BV1:video')
	assert.equal(protocol.wireSourceKey('bilibili::BV1::77'), 'bilibili:BV1:77')
	assert.equal(protocol.mobileSourceKey('bilibili:BV1:video'), 'bilibili::BV1')
	assert.equal(protocol.mobileSourceKey('bilibili:BV1:77'), 'bilibili::BV1::77')
	protocol.validateSyncOperation(seed.operations[0])
	assert.throws(
		() =>
			protocol.validateSyncOperation({
				...seed.operations[0],
				value: {
					source: {
						...seed.operations[0].value.source,
						track: {
							...seed.operations[0].value.source.track,
							localFileURL: 'file:///private',
						},
					},
				},
			}),
		/Invalid/,
	)
})

void test('a one-operation page sends causal predecessors before a lexically earlier actor', () => {
	const h = fixture(actorA)
	try {
		const prerequisite = {
			...seed.operations[1],
			id: '00000000-0000-0000-0000-000000000801',
			actor: actorB,
			sequence: 1,
			context: {},
		}
		h.engine.receive([prerequisite])
		h.engine.record(prerequisite.entity, 'title', { text: 'Dependent edit' })
		assert.equal(h.engine.outbox('new-peer', 1)[0]?.id, prerequisite.id)
	} finally {
		h.db.close()
	}
})
