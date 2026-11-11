export interface LyricPresentation {
	fontSize: number
	spacing: number
	translationRatio: number
	accent: boolean
	edgeMask: boolean
}
export const lyricPresets = {
	clear: {
		fontSize: 24,
		spacing: 16,
		translationRatio: 0.75,
		accent: true,
		edgeMask: true,
	},
	compact: {
		fontSize: 20,
		spacing: 8,
		translationRatio: 0.6,
		accent: true,
		edgeMask: true,
	},
	large: {
		fontSize: 34,
		spacing: 26,
		translationRatio: 0.75,
		accent: true,
		edgeMask: true,
	},
} satisfies Record<string, LyricPresentation>
const clamp = (number: unknown, min: number, max: number, fallback: number) =>
	typeof number === 'number' && Number.isFinite(number)
		? Math.min(max, Math.max(min, number))
		: fallback
export function normalizedLyricPresentation(
	value?: Partial<LyricPresentation>,
): LyricPresentation {
	return {
		fontSize: clamp(value?.fontSize, 16, 40, 24),
		spacing: clamp(value?.spacing, 8, 48, 16),
		translationRatio: clamp(value?.translationRatio, 0.4, 1, 0.75),
		accent: value?.accent !== false,
		edgeMask: value?.edgeMask !== false,
	}
}
