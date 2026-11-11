const PERSONAL_APPLICATION_ID = 'com.bbplayer.personal'

/** Remove inherited service configuration before Expo generates native projects. */
/**
 * @param {import('expo/config').ExpoConfig} config
 * @returns {import('expo/config').ExpoConfig}
 */
function applyPersonalBuildConfig(config) {
	return {
		...config,
		name: 'BBPlayer Personal',
		scheme: 'bbplayer-personal',
		owner: undefined,
		platforms: ['android'],
		android: {
			...config.android,
			package: PERSONAL_APPLICATION_ID,
			googleServicesFile: undefined,
			intentFilters: [],
		},
		ios: {
			...config.ios,
			bundleIdentifier: PERSONAL_APPLICATION_ID,
			googleServicesFile: undefined,
		},
		extra: { appVariant: 'personal' },
		updates: { enabled: false, checkAutomatically: 'NEVER' },
		plugins: [
			...(config.plugins ?? []).filter((plugin) => {
				const name = Array.isArray(plugin) ? plugin[0] : plugin
				return (
					name !== '@sentry/react-native/expo' &&
					name !== '@react-native-firebase/app' &&
					name !== './expo-plugins/withProductionDebugSigning'
				)
			}),
			'./expo-plugins/withPersonalBuild',
		],
	}
}

module.exports = { PERSONAL_APPLICATION_ID, applyPersonalBuildConfig }
