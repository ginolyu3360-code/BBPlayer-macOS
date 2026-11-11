package expo.modules.orpheus.audio

import kotlin.math.*
import org.junit.Assert.*
import org.junit.Test

class EqualizerDSPTest {
    private fun render(rate: Int, frequency: Double, config: EqualizerConfig): Pair<Double, Double> {
        val dsp = EqualizerDSP()
        dsp.prepare(rate); dsp.update(config)
        var power = 0.0
        var right = 0.0
        repeat(rate) { index ->
            dsp.advance()
            val left = dsp.sample(0, 0.1 * sin(2 * PI * frequency * index / rate))
            val silent = dsp.sample(1, 0.0)
            if (index >= rate / 2) power += left * left
            right = max(right, abs(silent))
        }
        return sqrt(power / (rate - rate / 2)) to right
    }
    @Test fun defaultsAndFlatBypassExactlyAndInvalidGainsAreClamped() {
        val dsp = EqualizerDSP()
        dsp.prepare(48000); dsp.update(EqualizerConfig())
        assertTrue(dsp.isBypassed)
        dsp.update(EqualizerConfig(true))
        assertTrue(dsp.isBypassed)
        assertEquals(listOf(0.0,12.0,-12.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0), EqualizerConfig(true,listOf(Double.NaN,100.0,-100.0)).gains)
    }
    @Test fun peakingGainIsSixDecibelsWithHeadroomAndNoChannelCrosstalk() {
        val gains = MutableList(10) { 0.0 }; gains[5] = 6.0
        for (rate in listOf(32000,44100,48000,96000)) {
            val peak = render(rate,1000.0,EqualizerConfig(true,gains))
            val outside = render(rate,125.0,EqualizerConfig(true,gains))
            assertEquals(6.0,20 * log10(peak.first / outside.first),0.3)
            assertTrue(peak.first < 0.075)
            assertEquals(0.0,peak.second,0.0)
        }
    }
    @Test fun togglesFadeToExactBypassAndFormatChangesResetOldChannelState() {
        val dsp=EqualizerDSP()
        val gains=MutableList(10) {0.0};gains[0]=12.0
        dsp.prepare(48000);dsp.update(EqualizerConfig(true,gains))
        repeat(4800) {dsp.advance();assertTrue(dsp.sample(0,0.1).isFinite())}
        dsp.update(EqualizerConfig(false,gains))
        repeat(9600) {dsp.advance();assertTrue(dsp.sample(0,0.1).isFinite())}
        dsp.finishBlock()
        assertTrue(dsp.isBypassed)
        dsp.prepare(96000);dsp.update(EqualizerConfig(true,gains));dsp.advance()
        assertEquals(0.0,dsp.sample(0,0.0),0.0)
    }
}
