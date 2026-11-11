import { sql } from 'drizzle-orm'
import type { ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite'

import type defaultDb from '@/lib/db/db'

import type { SyncDatabase } from './engine'

type Transaction = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0]
export type RecordingDatabase =
	| ExpoSQLiteDatabase<typeof import('@/lib/db/schema')>
	| Transaction

function statement(query: string, args: (string | number | null)[] = []) {
	const parts = query.split('?')
	if (parts.length !== args.length + 1)
		throw new Error('Invalid sync SQL bindings')
	const output = sql.empty()
	parts.forEach((part, index) => {
		output.append(sql.raw(part))
		if (index < args.length) output.append(sql`${args[index]}`)
	})
	return output
}

/** Bind values through Drizzle, retaining its existing connection/transaction. */
export function drizzleSyncDatabase(database: RecordingDatabase): SyncDatabase {
	return {
		getAllSync<T>(query: string, args: (string | number | null)[] = []) {
			return database.all<T>(statement(query, args))
		},
		getFirstSync<T>(query: string, args: (string | number | null)[] = []) {
			return database.get<T>(statement(query, args)) ?? null
		},
		runSync(query: string, args: (string | number | null)[] = []) {
			return database.run(statement(query, args))
		},
		withTransactionSync(body) {
			database.transaction(() => {
				body()
			})
		},
	}
}
