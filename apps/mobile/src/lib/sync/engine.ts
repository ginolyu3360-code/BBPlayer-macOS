import { Buffer } from 'buffer'

import { canonicalJSON, validateSyncOperation } from './protocol'
import type {
	SyncConflict,
	SyncOperation,
	SyncSeed,
	SyncValue,
} from './protocol'

export interface SyncDatabase {
	getAllSync<T>(query: string): T[]
	getAllSync<T>(query: string, args: (string | number | null)[]): T[]
	// SQL callers supply the decoded row shape, matching Expo SQLite.
	// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
	getFirstSync<T>(query: string): T | null
	// SQL callers supply the decoded row shape, matching Expo SQLite.
	// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
	getFirstSync<T>(query: string, args: (string | number | null)[]): T | null
	runSync(query: string): { changes: number; lastInsertRowId: number }
	runSync(
		query: string,
		args: (string | number | null)[],
	): { changes: number; lastInsertRowId: number }
	withTransactionSync(body: () => void): void
}

/** Durable causal log. Projection runs inside the same SQLite transaction as receipt. */
export class SyncEngine {
	constructor(
		private readonly database: SyncDatabase,
		readonly actor: string,
		private readonly makeID: () => string,
		private readonly project: (
			heads: SyncOperation[],
			historicalSources: SyncOperation[],
			historicalOrders: SyncOperation[],
		) => void,
	) {}
	private checkPaused() {
		if (
			this.database.getFirstSync<{ value: string }>(
				"SELECT value FROM sync_meta WHERE key='paused'",
			)?.value === 'true'
		)
			throw new Error('同步已暂停，请重新连接并确认资料库')
		const actor = this.database.getFirstSync<{ value: string }>(
			"SELECT value FROM sync_meta WHERE key='actor'",
		)?.value
		if (actor && actor !== this.actor)
			throw new Error('同步身份已更新，请重新建立连接')
	}
	private revisions(): Record<string, number> {
		return Object.fromEntries(
			this.database
				.getAllSync<{ actor: string; sequence: number }>(
					'SELECT actor,sequence FROM sync_revision',
				)
				.map((row) => [row.actor, row.sequence]),
		)
	}
	private operations(
		sql: string,
		args: (string | number)[] = [],
	): SyncOperation[] {
		return this.database
			.getAllSync<{ payload: string }>(sql, args)
			.map((row) => JSON.parse(row.payload) as SyncOperation)
	}
	heads(): SyncOperation[] {
		return this.operations(
			'SELECT o.payload FROM sync_head h JOIN sync_operation o ON o.id=h.operation_id ORDER BY h.entity,h.field,o.id',
		)
	}
	/** Caller must already own the SQLite transaction containing the library edit. */
	recordInTransaction(
		entity: string,
		field: string,
		value: SyncValue,
	): SyncOperation {
		this.checkPaused()
		const context = this.revisions()
		const operation: SyncOperation = {
			version: 1,
			id: this.makeID().toUpperCase(),
			actor: this.actor,
			sequence: (context[this.actor] ?? 0) + 1,
			context,
			entity,
			field,
			value,
		}
		this.ingest([operation], 10_000, 16 * 1024 * 1024, false)
		if (field === 'order')
			this.database.runSync(
				'INSERT INTO sync_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
				['sync-projection:' + entity, operation.id],
			)
		return operation
	}
	revision(): Record<string, number> {
		this.checkPaused()
		return this.revisions()
	}
	resolveConflict(conflict: SyncConflict, variantID: string): SyncOperation[] {
		this.checkPaused()
		const created: SyncOperation[] = []
		this.database.withTransactionSync(() => {
			const live = this.conflicts().find(
				(candidate) =>
					candidate.entity === conflict.entity &&
					candidate.field === conflict.field,
			)
			if (
				!live ||
				canonicalJSON(live.variants.map((variant) => variant.id).sort()) !==
					canonicalJSON(conflict.variants.map((variant) => variant.id).sort())
			)
				throw new Error('同步冲突已变化，请刷新后重新选择')
			const chosen = live.variants.find((variant) => variant.id === variantID)
			if (!chosen) throw new Error('所选冲突版本已不存在')
			const append = (entity: string, field: string, value: SyncValue) =>
				created.push(this.recordInTransaction(entity, field, value))
			if (conflict.field === 'delete/edit') {
				if (chosen.field === 'deleted' && chosen.value.flag === true)
					append(conflict.entity, 'deleted', { flag: true })
				else {
					append(conflict.entity, 'deleted', { flag: false })
					append(chosen.entity, chosen.field, chosen.value)
				}
			} else if (conflict.field.startsWith('entry-delete/edit:')) {
				const entry =
					'entry:' + conflict.field.slice('entry-delete/edit:'.length)
				if (
					chosen.entity === conflict.entity &&
					chosen.field === entry &&
					chosen.value.flag === false
				)
					append(conflict.entity, entry, { flag: false })
				else {
					append(conflict.entity, entry, { flag: true })
					append(chosen.entity, chosen.field, chosen.value)
				}
			} else append(chosen.entity, chosen.field, chosen.value)
			this.projectAccepted()
		})
		return created
	}
	record(entity: string, field: string, value: SyncValue): SyncOperation {
		this.checkPaused()
		let operation: SyncOperation
		this.database.withTransactionSync(() => {
			const context = this.revisions()
			operation = {
				version: 1,
				id: this.makeID().toUpperCase(),
				actor: this.actor,
				sequence: (context[this.actor] ?? 0) + 1,
				context,
				entity,
				field,
				value,
			}
			this.ingest([operation])
		})
		return operation!
	}
	receive(operations: SyncOperation[]): string[] {
		this.checkPaused()
		let acknowledged: string[] = []
		this.database.withTransactionSync(() => {
			this.ingest(operations)
			acknowledged = operations
				.filter(
					(operation) =>
						this.database.getFirstSync<{ applied: number }>(
							'SELECT applied FROM sync_operation WHERE id=?',
							[operation.id],
						)?.applied === 1,
				)
				.map((operation) => operation.id)
		})
		return acknowledged
	}
	private ingest(
		operations: SyncOperation[],
		maximumOperations = 10_000,
		maximumBytes = 16 * 1024 * 1024,
		projectLibrary = true,
	) {
		if (
			operations.length > maximumOperations ||
			Buffer.byteLength(JSON.stringify(operations), 'utf8') > maximumBytes
		)
			throw new Error('Sync batch too large')
		for (const operation of operations) {
			validateSyncOperation(operation)
			const payload = canonicalJSON(operation)
			const existing = this.database.getFirstSync<{
				id: string
				payload: string
			}>(
				'SELECT id,payload FROM sync_operation WHERE id=? OR (actor=? AND sequence=?)',
				[operation.id, operation.actor, operation.sequence],
			)
			if (existing) {
				if (existing.id !== operation.id || existing.payload !== payload)
					throw new Error('Sync operation collision')
				continue
			}
			this.database.runSync(
				'INSERT INTO sync_operation(id,actor,sequence,payload) VALUES(?,?,?,?)',
				[operation.id, operation.actor, operation.sequence, payload],
			)
		}
		let progressed = true
		let appliedAny = false
		while (progressed) {
			progressed = false
			for (const operation of this.operations(
				'SELECT payload FROM sync_operation WHERE applied=0 ORDER BY actor,sequence',
			)) {
				const revision = this.revisions()
				if (
					operation.sequence !== (revision[operation.actor] ?? 0) + 1 ||
					!Object.entries(operation.context).every(
						([actor, sequence]) => (revision[actor] ?? 0) >= sequence,
					)
				)
					continue
				for (const head of this.operations(
					'SELECT o.payload FROM sync_head h JOIN sync_operation o ON o.id=h.operation_id WHERE h.entity=? AND h.field=?',
					[operation.entity, operation.field],
				).filter(
					(candidate) =>
						candidate.entity === operation.entity &&
						candidate.field === operation.field &&
						(operation.context[candidate.actor] ?? 0) >= candidate.sequence,
				))
					this.database.runSync('DELETE FROM sync_head WHERE operation_id=?', [
						head.id,
					])
				this.database.runSync(
					'INSERT INTO sync_head(entity,field,operation_id) VALUES(?,?,?)',
					[operation.entity, operation.field, operation.id],
				)
				this.database.runSync(
					'UPDATE sync_operation SET applied=1 WHERE id=?',
					[operation.id],
				)
				this.database.runSync(
					'INSERT INTO sync_revision(actor,sequence) VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET sequence=excluded.sequence',
					[operation.actor, operation.sequence],
				)
				progressed = true
				appliedAny = true
			}
		}
		if (
			(this.database.getFirstSync<{ count: number }>(
				'SELECT COUNT(*) AS count FROM sync_operation WHERE applied=0',
			)?.count ?? 0) > 10_000
		)
			throw new Error('Too many pending sync operations')
		if (projectLibrary && appliedAny) this.projectAccepted()
	}
	private projectAccepted() {
		this.project(
			this.heads(),
			this.operations(
				"SELECT payload FROM sync_operation WHERE applied=1 AND (json_extract(payload,'$.field')='source' OR json_extract(payload,'$.field') LIKE 'archive:%') ORDER BY actor,sequence",
			),
			this.operations(
				"SELECT payload FROM sync_operation WHERE applied=1 AND (json_extract(payload,'$.field')='order' OR json_extract(payload,'$.field') LIKE 'entry:%') ORDER BY actor,sequence",
			),
		)
	}
	outbox(peer: string, limit = 1000): SyncOperation[] {
		this.checkPaused()
		return this.operations(
			"SELECT payload FROM sync_operation o WHERE applied=1 AND NOT EXISTS(SELECT 1 FROM sync_ack a WHERE a.peer=? AND a.operation_id=o.id) ORDER BY (SELECT COALESCE(SUM(value),0) FROM json_each(o.payload,'$.context')),o.actor,o.sequence LIMIT ?",
			[peer, Math.max(0, Math.min(limit, 10_000))],
		)
	}
	acknowledge(peer: string, ids: string[]) {
		this.checkPaused()
		this.database.withTransactionSync(() => {
			for (const id of ids) {
				if (
					this.database.getFirstSync<{ applied: number }>(
						'SELECT applied FROM sync_operation WHERE id=?',
						[id],
					)?.applied !== 1
				)
					throw new Error('Cannot acknowledge unapplied operation')
				this.database.runSync(
					'INSERT OR IGNORE INTO sync_ack(peer,operation_id) VALUES(?,?)',
					[peer, id],
				)
			}
		})
	}
	exportSeed(): SyncSeed {
		this.checkPaused()
		return {
			version: 1,
			operations: this.operations(
				'SELECT payload FROM sync_operation WHERE applied=1 ORDER BY actor,sequence',
			),
		}
	}
	applySeed(seed: SyncSeed) {
		if (seed.version !== 1) throw new Error('Unsupported sync version')
		this.checkPaused()
		this.database.withTransactionSync(() =>
			this.ingest(seed.operations, 100_000, 128 * 1024 * 1024),
		)
		return seed.operations
			.filter(
				(operation) =>
					this.database.getFirstSync<{ applied: number }>(
						'SELECT applied FROM sync_operation WHERE id=?',
						[operation.id],
					)?.applied === 1,
			)
			.map((operation) => operation.id)
	}
	conflicts(): SyncConflict[] {
		return syncConflicts(this.heads())
	}
}
export function concurrent(a: SyncOperation, b: SyncOperation): boolean {
	return (
		(a.context[b.actor] ?? 0) < b.sequence &&
		(b.context[a.actor] ?? 0) < a.sequence &&
		a.id !== b.id
	)
}
export function syncConflicts(heads: SyncOperation[]): SyncConflict[] {
	const groups = new Map<string, SyncOperation[]>()
	for (const head of heads) {
		const key = head.entity + '\0' + head.field
		groups.set(key, [...(groups.get(key) ?? []), head])
	}
	const conflicts: SyncConflict[] = []
	for (const variants of groups.values())
		if (variants.length > 1)
			conflicts.push({
				entity: variants[0].entity,
				field: variants[0].field,
				variants,
			})
	for (const deletion of heads.filter(
		(head) =>
			(head.value.flag === true && head.field === 'deleted') ||
			(head.value.flag === false && head.field.startsWith('entry:')),
	)) {
		const playlist = deletion.field === 'deleted'
		const song = deletion.field.slice(6)
		const edits = heads.filter(
			(edit) =>
				concurrent(deletion, edit) &&
				(playlist
					? edit.entity === deletion.entity && edit.field !== 'deleted'
					: (edit.entity === deletion.entity &&
							edit.field === 'order' &&
							edit.value.order?.includes(song)) ||
						(edit.entity === 'song:' + song && edit.field === 'source')),
		)
		if (edits.length)
			conflicts.push({
				entity: deletion.entity,
				field: playlist ? 'delete/edit' : 'entry-delete/edit:' + song,
				variants: [deletion, ...edits],
			})
	}
	return conflicts.sort(
		(a, b) =>
			a.entity.localeCompare(b.entity) || a.field.localeCompare(b.field),
	)
}
