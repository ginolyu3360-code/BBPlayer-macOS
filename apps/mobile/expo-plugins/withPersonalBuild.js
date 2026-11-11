const {
	withAndroidManifest,
	withAppBuildGradle,
	withGradleProperties,
} = require('expo/config-plugins')

const personalSigningBlock = `
// BBPlayer Personal: release builds require an explicit persistent personal key.
def personalSigningValues = [
    storeFile: System.getenv('BBPLAYER_PERSONAL_KEYSTORE_FILE'),
    storePassword: System.getenv('BBPLAYER_PERSONAL_KEYSTORE_PASSWORD'),
    keyAlias: System.getenv('BBPLAYER_PERSONAL_KEY_ALIAS'),
    keyPassword: System.getenv('BBPLAYER_PERSONAL_KEY_PASSWORD')
]
def hasPersonalSigning = personalSigningValues.values().every { it != null && !it.isEmpty() }
if (hasPersonalSigning) {
    def personalKeyFile = new File(personalSigningValues.storeFile)
    if (!personalKeyFile.isAbsolute() || !personalKeyFile.isFile() || personalKeyFile.name == 'debug.keystore') {
        throw new GradleException('Personal signing requires an existing absolute keystore path, separate from debug.keystore.')
    }
    def personalReleaseSigning = android.signingConfigs.create('bbplayerPersonalRelease') {
        storeFile personalKeyFile
        storePassword personalSigningValues.storePassword
        keyAlias personalSigningValues.keyAlias
        keyPassword personalSigningValues.keyPassword
    }
    android.buildTypes.release.signingConfig = personalReleaseSigning
} else {
    // Expo templates sign release with the debug key; disable that fallback.
    android.buildTypes.release.signingConfig = null
}
gradle.taskGraph.whenReady { graph ->
    if (!hasPersonalSigning && graph.allTasks.any { it.project == project && it.name.toLowerCase(java.util.Locale.ROOT).contains('release') }) {
        throw new GradleException('Personal release signing is missing. Set BBPLAYER_PERSONAL_KEYSTORE_FILE, BBPLAYER_PERSONAL_KEYSTORE_PASSWORD, BBPLAYER_PERSONAL_KEY_ALIAS, and BBPLAYER_PERSONAL_KEY_PASSWORD before building.')
    }
}
`

module.exports = (config) => {
	config = withGradleProperties(config, (config) => {
		// Keep lint enabled; the K2 script analyzer crashes on Worklets' .gradle.kts.
		// https://issuetracker.google.com/issues/430991549
		config.modResults = config.modResults.filter(
			(entry) =>
				entry.type !== 'property' || entry.key !== 'android.lint.useK2Uast',
		)
		config.modResults.push({
			type: 'property',
			key: 'android.lint.useK2Uast',
			value: 'false',
		})
		return config
	})
	config = withAndroidManifest(config, (config) => {
		const application = config.modResults.manifest.application[0]
		const disabled = {
			firebase_data_collection_default_enabled: 'false',
			firebase_analytics_collection_enabled: 'false',
			firebase_analytics_collection_deactivated: 'true',
			google_analytics_adid_collection_enabled: 'false',
			google_analytics_automatic_screen_reporting_enabled: 'false',
			'io.sentry.auto-init': 'false',
		}
		const metadata = application['meta-data'] ?? []
		application['meta-data'] = metadata.filter(
			(item) => !(item.$['android:name'] in disabled),
		)
		for (const [name, value] of Object.entries(disabled)) {
			application['meta-data'].push({
				$: { 'android:name': name, 'android:value': value },
			})
		}
		return config
	})
	return withAppBuildGradle(config, (config) => {
		// Never reuse a generated project with inherited build-time upload hooks.
		if (
			/sentry\.gradle|io\.sentry\.android\.gradle|com\.google\.gms\.google-services/.test(
				config.modResults.contents,
			)
		) {
			throw new Error(
				'Personal build refused: generated Android project contains inherited Sentry or Firebase Gradle hooks. Preserve local native changes and regenerate a fresh personal project before building.',
			)
		}
		if (!config.modResults.contents.includes(personalSigningBlock)) {
			config.modResults.contents += personalSigningBlock
		}
		return config
	})
}
