import Foundation

/// Receipt order and retry boundaries must never change the meaning of a reorder.
enum SyncOrdering {
    static func networkOrder(winner: SyncOperation?, history: [SyncOperation]) -> [String] {
        guard let winner else { return [] }
        var operations = history.filter { $0.entity == winner.entity && $0.field == "order" }
        if !operations.contains(where: { $0.id == winner.id }) { operations.append(winner) }
        func depth(_ op: SyncOperation) -> Int64 { op.context.values.reduce(0, +) }
        operations.sort { depth($0) == depth($1) ? $0.id < $1.id : depth($0) < depth($1) }
        var byActor: [String: [SyncOperation]] = [:], previous: [String: SyncOperation] = [:], observed: [String: [SyncOperation]] = [:]
        let memberships = Dictionary(grouping: history.filter { $0.entity == winner.entity && $0.field.hasPrefix("entry:") }, by: { String($0.field.dropFirst(6)) })
        for operation in operations {
            var candidates: [SyncOperation] = []
            for (actor, sequence) in operation.context {
                let prior = byActor[actor] ?? []
                var low = 0, high = prior.count
                while low < high { let mid = (low + high) / 2; if prior[mid].sequence <= sequence { low = mid + 1 } else { high = mid } }
                if low > 0 { candidates.append(prior[low - 1]) }
            }
            observed[operation.id] = candidates
            let maximal = candidates.filter { candidate in !candidates.contains { other in other.id != candidate.id && (other.context[candidate.actor] ?? 0) >= candidate.sequence } }
            if let selected = maximal.max(by: { $0.id < $1.id }) { previous[operation.id] = selected }
            byActor[operation.actor, default: []].append(operation)
        }
        var chain: [SyncOperation] = [], cursor: SyncOperation? = winner
        while let current = cursor { chain.append(current); cursor = previous[current.id] }
        var rank: [String] = []
        for operation in chain.reversed() {
            let requested = operation.value.order ?? [], requestedSet = Set(requested)
            func knows(_ song: String) -> Bool {
                var latest: [String: SyncOperation] = [:]
                for entry in memberships[song] ?? [] where (operation.context[entry.actor] ?? 0) >= entry.sequence && (latest[entry.actor]?.sequence ?? 0) < entry.sequence { latest[entry.actor] = entry }
                let visible = Array(latest.values)
                let adds = visible.filter { entry in entry.value.flag == true && !visible.contains { other in other.id != entry.id && (other.context[entry.actor] ?? 0) >= entry.sequence } }
                return (observed[operation.id] ?? []).contains { prior in prior.value.order?.contains(song) == true && adds.allSatisfy { (prior.context[$0.actor] ?? 0) >= $0.sequence } }
            }
            let known = Set(requested.filter(knows))
            rank = requested.filter { known.contains($0) } + rank.filter { !requestedSet.contains($0) } + requested.filter { !known.contains($0) }
        }
        return rank
    }
}
