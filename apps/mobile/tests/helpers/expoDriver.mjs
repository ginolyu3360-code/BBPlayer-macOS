/** Exercise the real synchronous Drizzle Expo driver against Node's real SQLite. */
export function expoClient(database) {
	return {
		prepareSync(query) {
			const execute = (parameters, arrays) => {
				const statement = database.prepare(query)
				statement.setReturnArrays(arrays)
				let rows = []
				if (statement.columns().length) rows = statement.all(...parameters)
				else statement.run(...parameters)
				return {
					changes: database.prepare('SELECT changes() AS value').get().value,
					lastInsertRowId: database
						.prepare('SELECT last_insert_rowid() AS value')
						.get().value,
					getAllSync: () => rows,
					getFirstSync: () => rows[0] ?? null,
				}
			}
			return {
				executeSync: (parameters = []) => execute(parameters, false),
				executeForRawResultSync: (parameters = []) => execute(parameters, true),
				finalizeSync() {},
			}
		},
	}
}
