// Personal builds must not link Firebase's native automatic collection providers.
module.exports =
	process.env.APP_VARIANT === 'personal'
		? {
				dependencies: {
					'@react-native-firebase/app': {
						platforms: { android: null, ios: null },
					},
					'@react-native-firebase/analytics': {
						platforms: { android: null, ios: null },
					},
				},
			}
		: {}
