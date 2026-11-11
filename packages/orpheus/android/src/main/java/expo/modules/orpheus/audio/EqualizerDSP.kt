package expo.modules.orpheus.audio

import kotlin.math.*

internal class EqualizerConfig(val enabled: Boolean = false, gains: List<Double> = List(10) { 0.0 }) {
    val gains: List<Double> = List(10) { index -> gains.getOrNull(index)?.takeIf { it.isFinite() }?.coerceIn(-12.0, 12.0) ?: 0.0 }
}

/** Single audio-thread filter state; the control thread publishes immutable settings. */
internal class EqualizerDSP {
    private val centers = doubleArrayOf(31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)
    private val current = Array(10) { DoubleArray(5) }
    private val target = Array(10) { DoubleArray(5) }
    private val z1 = Array(8) { DoubleArray(10) }
    private val z2 = Array(8) { DoubleArray(10) }
    private var rate = 0.0
    private var mix = 0.0
    private var targetMix = 0.0
    private var trim = 1.0
    private var targetTrim = 1.0
    private var smoothing = 0.0
    private var last: EqualizerConfig? = null
    val isBypassed get() = mix == 0.0 && targetMix == 0.0

    fun prepare(sampleRate: Int) {
        rate = sampleRate.toDouble()
        mix = 0.0; targetMix = 0.0; trim = 1.0; targetTrim = 1.0
        smoothing = if (rate > 0) 1 - exp(-1.0 / (rate * 0.020)) else 0.0
        last = null
        for (band in 0 until 10) { current[band].fill(0.0); current[band][0] = 1.0; current[band].copyInto(target[band]) }
        resetDelays()
    }

    fun update(config: EqualizerConfig) {
        if (last === config) return
        last = config
        targetMix = if (config.enabled && centers.indices.any { centers[it] < rate * 0.49 && config.gains[it] != 0.0 }) 1.0 else 0.0
        if (targetMix == 0.0) return
        for (band in centers.indices) {
            val coefficient = target[band]
            val gain = config.gains[band]
            if (gain == 0.0 || centers[band] >= rate * 0.49) {
                coefficient.fill(0.0); coefficient[0] = 1.0
                continue
            }
            // Peaking formula: https://www.w3.org/TR/audio-eq-cookbook/#biquad-filter-formulae
            val angle = 2 * PI * centers[band] / rate
            val amplitude = 10.0.pow(gain / 40)
            val alpha = sin(angle) / (2 * sqrt(2.0))
            val a0 = 1 + alpha / amplitude
            val middle = -2 * cos(angle) / a0
            coefficient[0] = (1 + alpha * amplitude) / a0
            coefficient[1] = middle
            coefficient[2] = (1 - alpha * amplitude) / a0
            coefficient[3] = middle
            coefficient[4] = (1 - alpha / amplitude) / a0
        }
        var peak = 1.0
        for (i in 0..128) peak = max(peak, response(20 * (rate * 0.49 / 20).pow(i / 128.0)))
        for (frequency in centers) if (frequency < rate * 0.49) peak = max(peak, response(frequency))
        targetTrim = if (peak > 1.001) 0.944060876 / sqrt(peak) else 1.0
        if (mix == 0.0) {
            for (band in 0 until 10) target[band].copyInto(current[band])
            resetDelays()
            trim = targetTrim
        }
    }
    private fun resetDelays() {
        for (channel in 0 until 8) { z1[channel].fill(0.0); z2[channel].fill(0.0) }
    }
    private fun response(frequency: Double): Double {
        val angle = 2 * PI * frequency / rate
        val c = cos(angle); val s = sin(angle); val c2 = 2*c*c-1; val s2 = 2*s*c
        var gain = 1.0
        for (b in target) {
            val nr=b[0]+b[1]*c+b[2]*c2; val ni=b[1]*s+b[2]*s2
            val dr=1+b[3]*c+b[4]*c2; val di=b[3]*s+b[4]*s2
            gain *= (nr*nr+ni*ni)/(dr*dr+di*di)
        }
        return gain
    }
    fun advance() {
        mix += (targetMix-mix)*smoothing
        trim += (targetTrim-trim)*smoothing
        for (band in 0 until 10) for (index in 0 until 5)
            current[band][index] += (target[band][index]-current[band][index])*smoothing
    }
    fun sample(channel: Int, input: Double): Double {
        if (!input.isFinite()) return 0.0
        var value = input
        for (band in 0 until 10) {
            val b = current[band]
            val next = b[0]*value+z1[channel][band]
            z1[channel][band] = b[1]*value-b[3]*next+z2[channel][band]
            z2[channel][band] = b[2]*value-b[4]*next
            value = next
        }
        return (input+(value*trim-input)*mix).takeIf { it.isFinite() } ?: 0.0
    }
    fun finishBlock() { if (targetMix == 0.0 && mix < 0.001) mix = 0.0 }
}
