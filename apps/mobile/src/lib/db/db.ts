import { drizzle } from 'drizzle-orm/expo-sqlite/driver'
import * as SQLite from 'expo-sqlite'

import { createRestoreGate } from './restoreGate'
import * as schema from './schema'

const rawDatabase = SQLite.openDatabaseSync('db.db', {
	enableChangeListener: true,
})
// SQLite 默认不强制外键约束，必须每次连接时手动开启
rawDatabase.execSync('PRAGMA foreign_keys = ON;')
export const libraryRestoreGate = createRestoreGate(rawDatabase)
export const expoDb = libraryRestoreGate.database
export const restoreDatabase = rawDatabase
const drizzleDb = drizzle<typeof schema>(expoDb, { schema })

export default drizzleDb
