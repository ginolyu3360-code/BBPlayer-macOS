import { Directory, File, Paths } from 'expo-file-system'

import { mmkv } from '@/utils/mmkv-instance'

import { createBackupArtifact } from './export'

const dailyKey = 'backup.daily.date'
const fingerprintKey = 'backup.daily.fingerprint'
let pending: Promise<void> | undefined

async function saveDailyBackup() {
	const day = new Date().toLocaleDateString('sv-SE')
	if (mmkv.getString(dailyKey) === day) return
	const artifact = await createBackupArtifact()
	const temporary = new File(artifact.uri)
	try {
		if (mmkv.getString(fingerprintKey) !== artifact.fingerprint) {
			const directory = new Directory(Paths.document, 'backups', 'automatic')
			directory.create({ intermediates: true, idempotent: true })
			temporary.copySync(
				new File(directory, `automatic-${Date.now()}.bbplayer`),
			)
			mmkv.set(fingerprintKey, artifact.fingerprint)
			const backups = directory
				.list()
				.filter(
					(file): file is File =>
						file instanceof File && /^automatic-\d+\.bbplayer$/.test(file.name),
				)
				.sort((a, b) => b.name.localeCompare(a.name))
			for (const file of backups.slice(10)) file.delete()
		}
		mmkv.set(dailyKey, day)
	} finally {
		if (temporary.exists) temporary.delete()
	}
}

/** One attempt at a time, retried on the next launch after failure. Manual exports are untouched. */
export function createDailyBackup(): Promise<void> {
	pending ??= saveDailyBackup().finally(() => {
		pending = undefined
	})
	return pending
}

export function listAutomaticBackups(): File[] {
	const directory = new Directory(Paths.document, 'backups', 'automatic')
	if (!directory.exists) return []
	return directory
		.list()
		.filter(
			(file): file is File =>
				file instanceof File && /^automatic-\d+\.bbplayer$/.test(file.name),
		)
		.sort((a, b) => b.name.localeCompare(a.name))
}

/** A successful archive is required before destructive library changes can proceed. */
export async function createProtectionBackup(): Promise<void> {
	const artifact = await createBackupArtifact()
	const temporary = new File(artifact.uri)
	try {
		const directory = new Directory(Paths.document, 'backups', 'automatic')
		directory.create({ intermediates: true, idempotent: true })
		temporary.copySync(new File(directory, `automatic-${Date.now()}.bbplayer`))
		for (const file of listAutomaticBackups().slice(10)) file.delete()
	} finally {
		if (temporary.exists) temporary.delete()
	}
}
