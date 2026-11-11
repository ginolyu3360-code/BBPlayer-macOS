import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const personalBuildEnvironment = (environment) => ({
	...environment,
	APP_VARIANT: 'personal',
	SENTRY_DISABLE_AUTO_UPLOAD: 'true',
	SENTRY_DISABLE_NATIVE_UPLOAD: 'true',
	EXPO_NO_TELEMETRY: '1',
	WITH_ROZENITE: 'false',
})

export function assertPersonalSigning(environment, fileExists = existsSync) {
	const keys = [
		'BBPLAYER_PERSONAL_KEYSTORE_FILE',
		'BBPLAYER_PERSONAL_KEYSTORE_PASSWORD',
		'BBPLAYER_PERSONAL_KEY_ALIAS',
		'BBPLAYER_PERSONAL_KEY_PASSWORD',
	]
	if (keys.some((key) => !environment[key]?.trim())) {
		throw new Error(
			`Personal release signing is missing. Set ${keys.join(', ')}. Config and prebuild do not require signing credentials.`,
		)
	}
	const keyFile = environment.BBPLAYER_PERSONAL_KEYSTORE_FILE
	if (
		!isAbsolute(keyFile) ||
		!fileExists(keyFile) ||
		basename(keyFile) === 'debug.keystore'
	) {
		throw new Error(
			'Personal signing requires an existing absolute keystore path, separate from debug.keystore.',
		)
	}
}

export function personalBuildSteps(action) {
	switch (action) {
		case 'config':
			return [['expo', 'config', '--type', 'public']]
		case 'prebuild':
			return [['expo', 'prebuild', '--platform', 'android', '--no-install']]
		case 'build':
			return [
				...personalBuildSteps('prebuild'),
				['gradle', ':app:assembleRelease'],
			]
		default:
			throw new Error(
				'Usage: node apps/mobile/scripts/personal-android.mjs [config|prebuild|build]',
			)
	}
}

// Local-only entry point: never installs, launches, publishes, or deletes native projects.
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		if (process.argv.length > 3) throw new Error('Only one action is accepted.')
		const action = process.argv[2] ?? 'config'
		const steps = personalBuildSteps(action)
		if (action === 'build') assertPersonalSigning(process.env)
		const mobileDirectory = resolve(
			dirname(fileURLToPath(import.meta.url)),
			'..',
		)
		const expoCLI = resolve(mobileDirectory, 'node_modules/expo/bin/cli')
		if (!existsSync(expoCLI))
			throw new Error(
				'Mobile dependencies are missing. Install workspace dependencies separately before running this helper.',
			)
		for (const [tool, ...arguments_] of steps) {
			const result = spawnSync(
				tool === 'expo' ? process.execPath : './gradlew',
				tool === 'expo' ? [expoCLI, ...arguments_] : arguments_,
				{
					cwd:
						tool === 'expo'
							? mobileDirectory
							: resolve(mobileDirectory, 'android'),
					env: personalBuildEnvironment(process.env),
					stdio: 'inherit',
				},
			)
			if (result.error) throw result.error
			if (result.status !== 0) process.exit(result.status ?? 1)
		}
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		)
		process.exitCode = 1
	}
}
