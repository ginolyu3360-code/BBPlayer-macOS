package expo.modules.orpheus.audio

import expo.modules.orpheus.bilibili.*
import org.junit.Assert.*
import org.junit.Test

class AudioStreamSelectionTest {
    private fun stream(id: Int, rate: Int, codec: String = "mp4a.40.2") = DashAudioItem(id=id, baseUrl="https://example.com/$id.m4s", codecs=codec, bandwidth=rate)
    @Test fun aacIsHighestAvailableByActualBandwidthAndPremiumRequiresDecoderSupport() {
        val low=stream(30216,64000);val high=stream(30280,192000);val flac=stream(30251,900000,"fLaC")
        val dash=DashData(audio=listOf(low,high),flac=FlacData(true,flac))
        assertEquals(high,AudioStreamSelection.select(dash,false,false) {true})
        assertEquals(high,AudioStreamSelection.select(dash,false,true) {false})
        assertEquals(flac,AudioStreamSelection.select(dash,false,true) {true})
        assertEquals(high,AudioStreamSelection.select(dash,true,false) {true})
    }
    @Test fun insecureSourcesAndUnknownCodecCapabilitiesAreNotAdvertisedAsPremiumPlayback() {
        val unsafe=DashAudioItem(id=1,baseUrl="http://example.com/audio",codecs="mp4a.40.2")
        assertThrows(java.io.IOException::class.java) {AudioStreamSelection.select(DashData(audio=listOf(unsafe)),false,false) {true}}
        assertNull(AudioStreamSelection.mime("unrecognized"))
        assertEquals("audio/flac",AudioStreamSelection.mime("fLaC"))
    }
}
