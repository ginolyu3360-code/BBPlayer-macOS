import type { SyncOperation } from './protocol'

const depth = (operation: SyncOperation) =>
	Object.values(operation.context).reduce((sum, value) => sum + value, 0)

/** Derive insertion/reorder semantics from causal history, independent of batch boundaries. */
export function causalNetworkOrder(
	winner: SyncOperation | undefined,
	history: SyncOperation[],
): string[] {
	if (!winner) return []
	const operations = history.filter(
		(operation) =>
			operation.entity === winner.entity && operation.field === 'order',
	)
	if (!operations.some((operation) => operation.id === winner.id))
		operations.push(winner)
	operations.sort(
		(a, b) => depth(a) - depth(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	)
	const byActor = new Map<string, SyncOperation[]>()
	const previous = new Map<string, SyncOperation>()
	const observed = new Map<string, SyncOperation[]>()
	const memberships = new Map<string, SyncOperation[]>()
	for (const entry of history.filter(
		(operation) =>
			operation.entity === winner.entity &&
			operation.field.startsWith('entry:'),
	)) {
		const id = entry.field.slice(6)
		const entries = memberships.get(id) ?? []
		entries.push(entry)
		memberships.set(id, entries)
	}
	for (const operation of operations) {
		const candidates: SyncOperation[] = []
		for (const [actor, sequence] of Object.entries(operation.context)) {
			const prior = byActor.get(actor) ?? []
			let low = 0,
				high = prior.length
			while (low < high) {
				const mid = (low + high) >>> 1
				if (prior[mid].sequence <= sequence) low = mid + 1
				else high = mid
			}
			if (low > 0) candidates.push(prior[low - 1])
		}
		observed.set(operation.id, candidates)
		const maximal = candidates.filter(
			(candidate) =>
				!candidates.some(
					(other) =>
						other.id !== candidate.id &&
						(other.context[candidate.actor] ?? 0) >= candidate.sequence,
				),
		)
		const selected = maximal
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			.at(-1)
		if (selected) previous.set(operation.id, selected)
		const actorOrders = byActor.get(operation.actor) ?? []
		actorOrders.push(operation)
		byActor.set(operation.actor, actorOrders)
	}
	const chain: SyncOperation[] = []
	let current: SyncOperation | undefined = winner
	while (current) {
		chain.push(current)
		current = previous.get(current.id)
	}
	let rank: string[] = []
	for (let index = chain.length - 1; index >= 0; index--) {
		const operation = chain[index]
		const requested = operation.value.order!,
			requestedSet = new Set(requested)
		const knows = (id: string) => {
			const latest = new Map<string, SyncOperation>()
			for (const entry of memberships.get(id) ?? [])
				if (
					(operation.context[entry.actor] ?? 0) >= entry.sequence &&
					(latest.get(entry.actor)?.sequence ?? 0) < entry.sequence
				)
					latest.set(entry.actor, entry)
			const visible = [...latest.values()]
			const adds = visible.filter(
				(entry) =>
					entry.value.flag === true &&
					!visible.some(
						(other) =>
							other.id !== entry.id &&
							(other.context[entry.actor] ?? 0) >= entry.sequence,
					),
			)
			return (observed.get(operation.id) ?? []).some(
				(prior) =>
					prior.value.order?.includes(id) &&
					adds.every((add) => (prior.context[add.actor] ?? 0) >= add.sequence),
			)
		}
		const known = new Set(requested.filter(knows))
		rank = [
			...requested.filter((id) => known.has(id)),
			...rank.filter((id) => !requestedSet.has(id)),
			...requested.filter((id) => !known.has(id)),
		]
	}
	return rank
}
