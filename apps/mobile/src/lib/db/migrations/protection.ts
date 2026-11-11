import { Directory, File, Paths } from 'expo-file-system'

import { expoDb } from '@/lib/db/db'

/** Protect an existing database before a pending schema migration. Fail closed on write errors. */
export function protectPendingMigration(latestTimestamp: number) {
	const hasJournal = expoDb.getFirstSync(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
	)
	const applied = hasJournal
		? expoDb.getFirstSync<{ latest: number | null }>(
				'SELECT MAX(created_at) AS latest FROM __drizzle_migrations',
			)?.latest
		: undefined
	if (applied != null && applied >= latestTimestamp) return
	const existing =
		expoDb.getFirstSync<{ count: number }>(
			"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
		)?.count ?? 0
	if (!existing) return
	const directory = new Directory(Paths.document, 'backups', 'migrations')
	directory.create({ intermediates: true, idempotent: true })
	new File(
		directory,
		`before-schema-${latestTimestamp}-${Date.now()}.db`,
	).write(expoDb.serializeSync())
}
