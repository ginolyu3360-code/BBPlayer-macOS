import { drizzle } from 'drizzle-orm/expo-sqlite/driver'
import { migrate } from 'drizzle-orm/expo-sqlite/migrator'
import type { SQLiteDatabase } from 'expo-sqlite'

import migrations from '../../../drizzle/migrations'

/** Run schema upgrades on the staged copy, never on the live restore destination. */
export async function upgradeBackupSchema(
	database: SQLiteDatabase,
): Promise<void> {
	await migrate(drizzle(database), migrations)
}
