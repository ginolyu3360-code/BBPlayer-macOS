package expo.modules.orpheus.audio

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import expo.modules.orpheus.util.GeneralStorage
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

@UnstableApi
internal class EqualizerAudioProcessor : BaseAudioProcessor() {
    private val dsp = EqualizerDSP()
    @Volatile var status: Int = 0
        private set

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat {
        return if (supported(inputAudioFormat)) inputAudioFormat else AudioFormat.NOT_SET
    }

    override fun onFlush(streamMetadata: androidx.media3.common.audio.AudioProcessor.StreamMetadata) {
        dsp.prepare(inputAudioFormat.sampleRate)
        status = if (supported(inputAudioFormat)) 1 else -1
    }

    override fun onReset() { status = 0 }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val output = replaceOutputBuffer(inputBuffer.remaining())
        dsp.update(GeneralStorage.equalizer())
        if (dsp.isBypassed) {
            output.put(inputBuffer).flip()
            return
        }
        val channels = inputAudioFormat.channelCount
        val float = inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
        inputBuffer.order(ByteOrder.nativeOrder())
        val frames = inputBuffer.remaining() / inputAudioFormat.bytesPerFrame
        repeat(frames) {
            dsp.advance()
            for (channel in 0 until channels) {
                if (float) output.putFloat(dsp.sample(channel, inputBuffer.getFloat().toDouble()).toFloat())
                else output.putShort((dsp.sample(channel, inputBuffer.getShort() / 32768.0)*32768.0).roundToInt().coerceIn(-32768,32767).toShort())
            }
        }
        output.put(inputBuffer).flip()
        dsp.finishBlock()
    }

    private fun supported(format: AudioFormat) = format.channelCount in 1..8 && format.sampleRate in 8000..384000 &&
        (format.encoding == C.ENCODING_PCM_16BIT || format.encoding == C.ENCODING_PCM_FLOAT)
}
