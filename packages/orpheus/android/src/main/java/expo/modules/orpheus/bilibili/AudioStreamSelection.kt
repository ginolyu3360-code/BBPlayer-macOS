package expo.modules.orpheus.bilibili

import androidx.media3.common.Format
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import java.net.URI
import java.io.IOException

internal object AudioStreamSelection {
    fun mime(codec: String): String? = when {
        codec.startsWith("mp4a", true) -> "audio/mp4a-latm"
        codec.equals("flac",true) -> "audio/flac"
        codec.equals("ec-3",true) || codec.equals("eac3",true) -> "audio/eac3"
        codec.equals("ac-3",true) || codec.equals("ac3",true) -> "audio/ac3"
        else -> null
    }
    @UnstableApi
    fun canDecode(item: DashAudioItem): Boolean {
        val mime = mime(item.codecs) ?: return false
        val format = Format.Builder().setSampleMimeType(mime).setCodecs(item.codecs)
            .setSampleRate(item.sampleRate.takeIf { it > 0 } ?: -1)
            .setChannelCount(item.channels.takeIf { it > 0 } ?: -1).build()
        return try { MediaCodecUtil.getDecoderInfos(mime,false,false).any { it.isFormatSupported(format) } }
        catch (_: Exception) { false }
    }
    fun select(dash: DashData, dolby: Boolean, lossless: Boolean, canDecode: (DashAudioItem) -> Boolean): DashAudioItem {
        fun valid(item: DashAudioItem): Boolean = try {
            val uri = URI(item.baseUrl)
            uri.scheme == "https" && uri.host != null && uri.userInfo == null
        } catch (_: Exception) { false }
        val special = when { dolby -> dash.dolby?.audio.orEmpty(); lossless -> listOfNotNull(dash.flac?.audio); else -> emptyList() }
        special.filter { valid(it) && canDecode(it) }.maxByOrNull { it.bandwidth }?.let { return it }
        return dash.audio.orEmpty().filter { valid(it) && (it.codecs.isEmpty() || it.codecs.startsWith("mp4a",true)) }
            .maxWithOrNull(compareBy<DashAudioItem> { it.bandwidth }.thenBy { it.id })
            ?: throw IOException("No playable ordinary AAC stream")
    }
}
