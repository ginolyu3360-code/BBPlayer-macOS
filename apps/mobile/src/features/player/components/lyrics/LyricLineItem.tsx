import { type LyricLine } from '@bbplayer/splash'
import { memo, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Touchable } from 'react-native-gesture-handler'
import { useTheme } from 'react-native-paper'
import Animated, {
	createAnimatedComponent,
	interpolateColor,
	type SharedValue,
	useAnimatedReaction,
	useAnimatedStyle,
	useDerivedValue,
	withTiming,
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

import useAppStore from '@/hooks/stores/useAppStore'
import { normalizedLyricPresentation } from '@/lib/config/lyricPresentation'

import { KaraokeWord } from './KaraokeWord'

const AnimatedTouchable = createAnimatedComponent(Touchable)

function useLyricColor(
	isHighlighted: SharedValue<boolean>,
	immediate: boolean,
	activeColor: string,
	inactiveColor: string,
	enabled = true,
) {
	const progress = useDerivedValue(() => {
		const target = isHighlighted.value && enabled ? 1 : 0
		return immediate ? target : withTiming(target, { duration: 300 })
	})

	return useDerivedValue(() => {
		// Keep invalid animation progress away from native color props.
		if (!Number.isFinite(progress.value)) {
			return isHighlighted.value && enabled ? activeColor : inactiveColor
		}
		return interpolateColor(
			Math.max(0, Math.min(1, progress.value)),
			[0, 1],
			[inactiveColor, activeColor],
		)
	})
}

export interface LyricLineItemProps {
	item: LyricLine & { isPaddingItem?: boolean }
	currentHighlightIndex: SharedValue<number>
	jumpToThisLyric: (index: number) => void
	index: number
	onPressBackground?: (() => void) | undefined
	currentTime: SharedValue<number>
	enableVerbatimLyrics: boolean
	preferredLyricType?: 'translation' | 'romaji'
}

export const OldSchoolLyricLineItem = memo(function OldSchoolLyricLineItem({
	item,
	currentHighlightIndex,
	jumpToThisLyric,
	index,
	onPressBackground,
	currentTime,
	enableVerbatimLyrics,
	preferredLyricType = 'translation',
}: LyricLineItemProps) {
	const colors = useTheme().colors
	const customPresentation = useAppStore(
		(state) => state.settings.lyricPresentation,
	)
	const presentation = normalizedLyricPresentation(customPresentation)
	const activeColor = presentation.accent ? colors.primary : colors.onSurface

	const isHighlighted = useDerivedValue(() => {
		return currentHighlightIndex.value === index
	})

	const gatedCurrentTime = useDerivedValue(() => {
		return isHighlighted.value ? currentTime.value : -1
	})

	const isVerbatim =
		enableVerbatimLyrics &&
		item.isDynamic &&
		item.spans &&
		item.spans.length > 0

	const lyricColor = useLyricColor(
		isHighlighted,
		isVerbatim,
		activeColor,
		colors.onSurfaceDisabled,
	)

	const animatedStyle = useAnimatedStyle(() => {
		const duration = isVerbatim ? 0 : 300
		if (isHighlighted.value) {
			return {
				opacity: withTiming(1, { duration }),
				color: lyricColor.value,
			}
		}

		return {
			opacity: withTiming(0.7, { duration }),
			color: lyricColor.value,
		}
	})

	const subText =
		preferredLyricType === 'romaji'
			? item.romaji || item.translation || item.translations?.[0]
			: item.translation || item.romaji || item.translations?.[0]

	return (
		<View
			style={[
				styles.oldSchoolItemWrapper,
				customPresentation
					? { paddingVertical: presentation.spacing / 2 }
					: undefined,
			]}
		>
			<Pressable
				style={StyleSheet.absoluteFill}
				onPress={onPressBackground}
			/>
			<Touchable
				androidRipple={{}}
				style={styles.oldSchoolItemButton}
				onPress={() => jumpToThisLyric(index)}
			>
				{isVerbatim ? (
					<View
						style={{
							flexDirection: 'row',
							flexWrap: 'wrap',
							justifyContent: 'center',
						}}
					>
						{item.spans.map((span, idx) => (
							<KaraokeWord
								// oxlint-disable-next-line react/no-array-index-key
								key={`${index}_${idx}`}
								span={span}
								currentTime={gatedCurrentTime}
								baseStyle={[
									styles.oldSchoolItemText,
									customPresentation
										? {
												fontSize: (presentation.fontSize * 14) / 24,
												lineHeight: ((presentation.fontSize * 14) / 24) * 1.4,
											}
										: undefined,
								]}
								activeColor={activeColor}
								inactiveColor={colors.onSurfaceDisabled}
							/>
						))}
					</View>
				) : (
					<Animated.Text
						style={[
							styles.oldSchoolItemText,
							customPresentation
								? {
										fontSize: (presentation.fontSize * 14) / 24,
										lineHeight: ((presentation.fontSize * 14) / 24) * 1.4,
									}
								: undefined,
							animatedStyle,
						]}
					>
						{item.content}
					</Animated.Text>
				)}
				{subText && (
					<Animated.Text
						style={[
							styles.oldSchoolItemTranslation,
							customPresentation
								? {
										fontSize:
											(presentation.fontSize *
												presentation.translationRatio *
												14) /
											24,
										lineHeight:
											((presentation.fontSize *
												presentation.translationRatio *
												14) /
												24) *
											1.4,
									}
								: undefined,
							animatedStyle,
						]}
					>
						{subText}
					</Animated.Text>
				)}
			</Touchable>
		</View>
	)
})

export const ModernLyricLineItem = memo(function ModernLyricLineItem({
	item,
	currentHighlightIndex,
	jumpToThisLyric,
	index,
	onPressBackground,
	currentTime,
	enableVerbatimLyrics,
	preferredLyricType = 'translation',
}: LyricLineItemProps) {
	const theme = useTheme()
	const customPresentation = useAppStore(
		(state) => state.settings.lyricPresentation,
	)
	const presentation = normalizedLyricPresentation(customPresentation)
	const activeColor = presentation.accent
		? theme.colors.primary
		: theme.colors.onSurface

	const isHighlighted = useDerivedValue(() => {
		return currentHighlightIndex.value === index
	})

	const [isVerbatim, setIsVerbatim] = useState(false)
	const [isHighlightedRState, setIsHighlightedRState] = useState(false)

	useAnimatedReaction(
		() => currentHighlightIndex.value,
		(currentVal) => {
			scheduleOnRN(
				setIsVerbatim,
				enableVerbatimLyrics &&
					item.isDynamic &&
					item.spans &&
					item.spans.length > 0 &&
					currentVal === index,
			)
			scheduleOnRN(setIsHighlightedRState, currentVal === index)
		},
	)

	const containerAnimatedStyle = useAnimatedStyle(() => {
		if (isHighlighted.value) {
			return {
				opacity: withTiming(1, { duration: 300 }),
				transform: [
					{ scale: withTiming(1.05, { duration: 300 }) },
					{ translateX: withTiming(12, { duration: 300 }) },
				],
			}
		}

		return {
			opacity: withTiming(0.7, { duration: 300 }),
			transform: [
				{ scale: withTiming(1, { duration: 300 }) },
				{ translateX: withTiming(0, { duration: 300 }) },
			],
		}
	})

	const lyricColor = useLyricColor(
		isHighlighted,
		isVerbatim,
		activeColor,
		theme.colors.onSurfaceDisabled,
		isHighlightedRState,
	)
	const textAnimatedStyle = useAnimatedStyle(() => ({
		color: lyricColor.value,
	}))

	const renderContent = () => {
		if (isVerbatim) {
			return (
				<View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
					{item.spans.map((span, idx) => (
						<KaraokeWord
							// oxlint-disable-next-line react/no-array-index-key
							key={`${index}_${idx}`}
							span={span}
							currentTime={currentTime}
							baseStyle={[
								styles.modernItemText,
								customPresentation
									? {
											fontSize: presentation.fontSize,
											lineHeight: presentation.fontSize * 1.4,
										}
									: undefined,
							]}
							activeColor={activeColor}
							inactiveColor={theme.colors.onSurfaceDisabled}
						/>
					))}
				</View>
			)
		}

		return (
			<Animated.Text
				style={[
					styles.modernItemText,
					customPresentation
						? {
								fontSize: presentation.fontSize,
								lineHeight: presentation.fontSize * 1.4,
							}
						: undefined,
					textAnimatedStyle,
				]}
			>
				{item.content}
			</Animated.Text>
		)
	}

	const subText =
		preferredLyricType === 'romaji'
			? item.romaji || item.translation || item.translations?.[0]
			: item.translation || item.romaji || item.translations?.[0]

	return (
		<View
			style={[
				styles.modernItemWrapper,
				customPresentation
					? { paddingVertical: presentation.spacing / 2 }
					: undefined,
			]}
		>
			<Pressable
				style={StyleSheet.absoluteFill}
				onPress={onPressBackground}
			/>
			<AnimatedTouchable
				androidRipple={{}}
				style={[styles.modernItemButton, containerAnimatedStyle]}
				onPress={() => jumpToThisLyric(index)}
			>
				{renderContent()}
				{subText && (
					<Animated.Text
						style={[
							styles.modernItemTranslation,
							customPresentation
								? {
										fontSize:
											presentation.fontSize * presentation.translationRatio,
										lineHeight:
											presentation.fontSize *
											presentation.translationRatio *
											1.4,
									}
								: undefined,
							textAnimatedStyle,
						]}
					>
						{subText}
					</Animated.Text>
				)}
			</AnimatedTouchable>
		</View>
	)
})

const styles = StyleSheet.create({
	oldSchoolItemWrapper: {
		alignItems: 'center',
		paddingVertical: 4,
	},
	oldSchoolItemButton: {
		flexDirection: 'column',
		alignItems: 'center',
		gap: 4,
		borderRadius: 16,
		paddingVertical: 8,
		paddingHorizontal: 16,
		marginHorizontal: 30,
		alignSelf: 'center',
	},
	oldSchoolItemText: {
		textAlign: 'center',
		fontSize: 14,
		fontWeight: '400',
		letterSpacing: 0.25,
		lineHeight: 20,
	},
	oldSchoolItemTranslation: {
		textAlign: 'center',
		fontSize: 12,
		fontWeight: '400',
		letterSpacing: 0.4,
		lineHeight: 16,
	},
	modernItemWrapper: {
		flexDirection: 'column',
		alignItems: 'stretch',
		marginVertical: 4,
		paddingVertical: 2,
	},
	modernItemButton: {
		flexDirection: 'column',
		alignItems: 'flex-start',
		gap: 4,
		borderRadius: 8,
		paddingVertical: 4,
		marginHorizontal: 30,
		paddingLeft: 8,
		paddingRight: 8,
		alignSelf: 'flex-start',
	},
	modernItemText: {
		textAlign: 'left',
		fontSize: 24,
		fontWeight: '700',
		letterSpacing: 0,
		lineHeight: 32,
	},
	modernItemTranslation: {
		textAlign: 'left',
		fontSize: 18,
		fontWeight: '400',
		letterSpacing: 0,
		lineHeight: 26,
		marginTop: 2,
	},
})
