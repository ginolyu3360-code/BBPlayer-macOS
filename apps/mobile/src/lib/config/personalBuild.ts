import * as Application from 'expo-application'
import Constants from 'expo-constants'

// Check both the installed identity and embedded config, including development bundles.
export const isPersonalBuild =
	Application.applicationId === 'com.bbplayer.personal' ||
	Constants.expoConfig?.extra?.appVariant === 'personal'

export function assertSharedBackendEnabled(): void {
	if (isPersonalBuild) {
		throw new Error('个人版已停用 BBPlayer 账号和共享服务')
	}
}
