import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

import {
	assertPersonalSigning,
	personalBuildEnvironment,
	personalBuildSteps,
} from '../scripts/personal-android.mjs'

const mobile = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, mobile), 'utf8')

// Execute the real modules without loading React Native or installing dependencies.
function loadTS(path, names, imports = {}) {
	const source = stripTypeScriptTypes(read(path))
		.replace(
			/^import \* as (\w+) from '([^']+)'/gm,
			(_, name, id) => `const ${name} = imports[${JSON.stringify(id)}]`,
		)
		.replace(
			/^import \{([\s\S]*?)\} from '([^']+)'/gm,
			(_, bindings, id) =>
				`const {${bindings}} = imports[${JSON.stringify(id)}]`,
		)
		.replace(
			/^import (\w+) from '([^']+)'/gm,
			(_, name, id) => `const ${name} = imports[${JSON.stringify(id)}]`,
		)
		.replace(/^export /gm, '')
	const context = vm.createContext({ imports, process: { env: {} } })
	return new vm.Script(`${source}\n;({${names.join(',')}})`, {
		filename: path,
	}).runInContext(context)
}

const forbidden = () => {
	assert.fail('Inherited update service was accessed')
}
const configContext = vm.createContext({ module: { exports: {} } })
new vm.Script(read('personal-build.js')).runInContext(configContext)
const personalConfig = configContext.module.exports

const policyPath = '@/lib/config/personalBuild'
const logger = {
	debug() {},
	warning() {},
	extend() {
		return this
	},
}

void test('personal config removes inherited updates, service identities, links, and upload plugins', () => {
	const { applyPersonalBuildConfig } = personalConfig
	const official = {
		name: 'BBPlayer',
		owner: 'service-owner',
		scheme: 'bbplayer',
		android: {
			package: 'com.roitium.bbplayer',
			googleServicesFile: 'private.json',
			versionCode: 42,
			intentFilters: [{}],
		},
		extra: {
			eas: { projectId: 'inherited' },
			updateServerUrl: 'https://example.invalid',
			updateManifestUrl: 'https://example.invalid/update',
		},
		updates: {
			enabled: true,
			url: 'https://example.invalid',
			requestHeaders: { installation: 'id' },
		},
		plugins: [
			'@react-native-firebase/app',
			['@sentry/react-native/expo', { uploadNativeSymbols: true }],
			'./expo-plugins/withProductionDebugSigning',
			'expo-router',
		],
	}
	const config = applyPersonalBuildConfig(official)
	assert.equal(config.name, 'BBPlayer Personal')
	assert.equal(config.android.package, 'com.bbplayer.personal')
	assert.equal(config.android.versionCode, 42)
	assert.equal(config.android.googleServicesFile, undefined)
	assert.equal(config.android.intentFilters.length, 0)
	assert.equal(config.extra.appVariant, 'personal')
	assert.equal(Object.keys(config.extra).length, 1)
	assert.equal(config.owner, undefined)
	assert.equal(config.updates.enabled, false)
	assert.equal(config.updates.checkAutomatically, 'NEVER')
	assert.equal(config.updates.url, undefined)
	assert.equal(config.updates.requestHeaders, undefined)
	assert.equal(
		config.plugins.join(','),
		'expo-router,./expo-plugins/withPersonalBuild',
	)
	assert.equal(official.updates.enabled, true)
})

void test('runtime personal policy accepts installed identity or embedded variant', () => {
	for (const [id, variant, expected] of [
		['com.bbplayer.personal', undefined, true],
		['host.expo', 'personal', true],
		['com.roitium.bbplayer', 'production', false],
	]) {
		const policy = loadTS(
			'src/lib/config/personalBuild.ts',
			['isPersonalBuild', 'assertSharedBackendEnabled'],
			{
				'expo-application': { applicationId: id },
				'expo-constants': { expoConfig: { extra: { appVariant: variant } } },
			},
		)
		assert.equal(policy.isPersonalBuild, expected)
		if (expected) assert.throws(() => policy.assertSharedBackendEnabled())
		else assert.doesNotThrow(() => policy.assertSharedBackendEnabled())
	}
})

void test('personal analytics never imports Firebase, including attempts to enable collection', async () => {
	const { analyticsService } = loadTS(
		'src/lib/services/analyticsService.ts',
		['analyticsService'],
		{
			[policyPath]: { isPersonalBuild: true },
			'@/utils/log': {
				...logger,
				extend() {
					return this
				},
				warning() {
					assert.fail('Firebase was accessed')
				},
			},
		},
	)
	await analyticsService.logPlayerAction('play')
	await analyticsService.logScreenView('test')
	await analyticsService.setUserProperty('test', 'value')
	await analyticsService.setAnalyticsCollectionEnabled(true)
	await analyticsService.logAppInfo('1', '2')
})

void test('personal backend blocks network even with an existing token or custom endpoint', async () => {
	let calls = 0
	const { fetchWithAuthRetry, ensureBBPlayerToken } = loadTS(
		'src/lib/api/bbplayer/client.ts',
		['fetchWithAuthRetry', 'ensureBBPlayerToken'],
		{
			'hono/client': { hc: () => ({}) },
			'react-native-nitro-fetch': {
				fetch: () => {
					calls++
					throw new Error('Network reached')
				},
			},
			'@/hooks/stores/useAppStore': {
				getState: () => ({ bbplayerToken: 'present' }),
			},
			[policyPath]: {
				assertSharedBackendEnabled: () => {
					throw new Error('Personal disabled')
				},
			},
		},
	)
	await assert.rejects(
		fetchWithAuthRetry('https://example.invalid/shared'),
		/Personal disabled/,
	)
	await assert.rejects(ensureBBPlayerToken(), /Personal disabled/)
	assert.equal(calls, 0)
})

void test('native personal plugin disables startup collection and rejects stale upload hooks', () => {
	const callbacks = {}
	const context = vm.createContext({
		module: { exports: {} },
		require: () => ({
			withGradleProperties: (config, callback) => {
				callbacks.properties = callback
				return config
			},
			withAndroidManifest: (config, callback) => {
				callbacks.manifest = callback
				return config
			},
			withAppBuildGradle: (config, callback) => {
				callbacks.gradle = callback
				return config
			},
		}),
	})
	new vm.Script(read('expo-plugins/withPersonalBuild.js')).runInContext(context)
	context.module.exports({})
	const properties = {
		modResults: [
			{ type: 'property', key: 'android.lint.useK2Uast', value: 'true' },
		],
	}
	callbacks.properties(properties)
	callbacks.properties(properties)
	assert.equal(properties.modResults.length, 1)
	assert.equal(properties.modResults[0].value, 'false')
	const config = {
		modResults: {
			manifest: {
				application: [
					{
						'meta-data': [
							{
								$: {
									'android:name': 'firebase_analytics_collection_enabled',
									'android:value': 'true',
								},
							},
						],
					},
				],
			},
		},
	}
	callbacks.manifest(config)
	const metadata = Object.fromEntries(
		config.modResults.manifest.application[0]['meta-data'].map(
			({ $: item }) => [item['android:name'], item['android:value']],
		),
	)
	assert.equal(metadata.firebase_analytics_collection_enabled, 'false')
	assert.equal(metadata.firebase_analytics_collection_deactivated, 'true')
	assert.equal(metadata['io.sentry.auto-init'], 'false')
	for (const hook of [
		'sentry.gradle',
		'io.sentry.android.gradle',
		'com.google.gms.google-services',
	]) {
		assert.throws(
			() => callbacks.gradle({ modResults: { contents: hook } }),
			/Personal build refused/,
		)
	}
	const native = { modResults: { contents: 'android { }' } }
	callbacks.gradle(native)
	assert.match(
		native.modResults.contents,
		/android.buildTypes.release.signingConfig = null/,
	)
	assert.match(native.modResults.contents, /BBPLAYER_PERSONAL_KEYSTORE_FILE/)
	const first = native.modResults.contents
	callbacks.gradle(native)
	assert.equal(native.modResults.contents, first)
})

void test('personal local command never installs, launches, cleans, or publishes', () => {
	const env = personalBuildEnvironment({
		APP_VARIANT: 'production',
		SENTRY_DISABLE_AUTO_UPLOAD: 'false',
	})
	assert.equal(env.APP_VARIANT, 'personal')
	assert.equal(env.SENTRY_DISABLE_AUTO_UPLOAD, 'true')
	assert.equal(env.SENTRY_DISABLE_NATIVE_UPLOAD, 'true')
	assert.deepEqual(personalBuildSteps('build'), [
		['expo', 'prebuild', '--platform', 'android', '--no-install'],
		['gradle', ':app:assembleRelease'],
	])
	assert.throws(() => personalBuildSteps('publish'))
})

void test('personal update prefetch, checks, headers, and telemetry never access network or installation storage', async () => {
	const common = {
		[policyPath]: { isPersonalBuild: true },
		'@/utils/log': logger,
		'expo-application': {},
		'expo-constants': {
			expoConfig: {
				extra: {
					updateManifestUrl: 'https://example.invalid/update',
					updateServerUrl: 'https://example.invalid',
				},
			},
		},
		'react-native-nitro-fetch': {
			fetch: forbidden,
			prefetchOnAppStart: forbidden,
		},
	}
	const service = loadTS(
		'src/lib/services/updateService.ts',
		['registerUpdatePrefetch', 'fetchLatestRelease'],
		{
			...common,
			'@sentry/react-native': { startSpan: forbidden },
			neverthrow: { err: (error) => ({ error }), ok: (value) => ({ value }) },
		},
	)
	service.registerUpdatePrefetch()
	assert.match(
		(await service.fetchLatestRelease()).error.message,
		/updateManifestUrl/,
	)
	const telemetry = loadTS(
		'src/lib/services/updateTelemetry.ts',
		[
			'initializeUpdateRequestHeaders',
			'reportUpdateActivity',
			'reportUpdateLaunch',
			'setUpdateChannelOverride',
		],
		{
			...common,
			'expo-secure-store': { getItemAsync: forbidden, setItemAsync: forbidden },
			'expo-updates': {
				isEnabled: true,
				updateId: 'hostile-inherited-update',
				setUpdateRequestHeadersOverride: forbidden,
			},
			'react-native': { Platform: { OS: 'android' } },
		},
	)
	await telemetry.initializeUpdateRequestHeaders()
	telemetry.reportUpdateActivity()
	telemetry.reportUpdateLaunch()
	await assert.rejects(telemetry.setUpdateChannelOverride('production'))
})

void test('personal Sentry initialization never initializes the JS or native SDK', () => {
	let initCalls = 0
	const { initializeSentry } = loadTS(
		'src/lib/config/sentry.ts',
		['initializeSentry'],
		{
			[policyPath]: { isPersonalBuild: true },
			'@bbplayer/native': { getApkSigningCertificateSha256: () => null },
			'@sentry/react-native': {
				reactNavigationIntegration: () => ({}),
				init: () => {
					initCalls++
				},
			},
			expo: { isRunningInExpoGo: () => false },
			'expo-application': { applicationId: 'com.bbplayer.personal' },
			'expo-updates': {},
			'react-native': { Platform: { OS: 'android' } },
			'@/hooks/stores/useAppStore': {
				getState: () => ({ settings: { enableDataCollection: true } }),
			},
			'@/lib/services/updateTelemetry': {},
			'@/utils/log': {
				...logger,
				extend() {
					return this
				},
				info() {},
			},
		},
	)
	initializeSentry()
	assert.equal(initCalls, 0)
})

void test('Firebase native modules are excluded only for the personal build', () => {
	for (const variant of ['personal', 'production']) {
		const context = vm.createContext({
			module: { exports: {} },
			process: { env: { APP_VARIANT: variant } },
		})
		new vm.Script(read('react-native.config.js')).runInContext(context)
		const config = context.module.exports
		if (variant === 'personal') {
			assert.equal(
				config.dependencies['@react-native-firebase/app'].platforms.android,
				null,
			)
			assert.equal(
				config.dependencies['@react-native-firebase/analytics'].platforms
					.android,
				null,
			)
		} else assert.equal(config.dependencies, undefined)
	}
})

void test('personal release refuses missing signing configuration and the template debug key', () => {
	assert.throws(
		() => assertPersonalSigning({}),
		/Personal release signing is missing/,
	)
	const environment = {
		BBPLAYER_PERSONAL_KEYSTORE_FILE: '/keys/personal.keystore',
		BBPLAYER_PERSONAL_KEYSTORE_PASSWORD: 'test-only',
		BBPLAYER_PERSONAL_KEY_ALIAS: 'personal',
		BBPLAYER_PERSONAL_KEY_PASSWORD: 'test-only',
	}
	assert.throws(
		() => assertPersonalSigning(environment, () => false),
		/existing absolute keystore/,
	)
	assert.throws(
		() =>
			assertPersonalSigning(
				{
					...environment,
					BBPLAYER_PERSONAL_KEYSTORE_FILE: '/keys/debug.keystore',
				},
				() => true,
			),
		/debug.keystore/,
	)
	assert.doesNotThrow(() => assertPersonalSigning(environment, () => true))
})
