/** Drain existing operations and reject stale prepared statements until a restore is restarted. */
export function createRestoreGate<T extends object>(raw: T) {
	let phase: 'ready' | 'draining' | 'restart' = 'ready'
	const pending = new Set<Promise<unknown>>()
	const assertReady = () => {
		if (phase !== 'ready')
			throw new Error('资料恢复正在进行或已完成，请重启应用后继续')
	}
	function wrap<V extends object>(target: V, statement = false): V {
		const methods = new Map<PropertyKey, unknown>()
		return new Proxy(target, {
			get(object, key) {
				const value: unknown = Reflect.get(object, key, object)
				if (typeof value !== 'function') return value
				if (methods.has(key)) return methods.get(key)
				const method = (...args: unknown[]) => {
					const cleanup = statement && /^(finalize|reset)/.test(String(key))
					if (!cleanup) assertReady()
					const result: unknown = Reflect.apply(value, object, args)
					if (key === 'prepareSync') return wrap(result as object, true)
					if (result instanceof Promise) {
						const operation = result.then((output: unknown) =>
							key === 'prepareAsync' ? wrap(output as object, true) : output,
						)
						pending.add(operation)
						void operation.then(
							() => pending.delete(operation),
							() => pending.delete(operation),
						)
						return operation
					}
					return result
				}
				methods.set(key, method)
				return method
			},
		})
	}
	return {
		database: wrap(raw),
		assertReady,
		async drain() {
			assertReady()
			phase = 'draining'
			while (pending.size) await Promise.allSettled(pending)
		},
		resume() {
			phase = 'ready'
		},
		requireRestart() {
			phase = 'restart'
		},
	}
}
