package expo.modules.orpheus.recovery

import android.content.Context
import android.net.ConnectivityManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.Player
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer

/** Runs in the foreground service, including when JS is suspended in the background. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal class PlaybackWatchdog(private val context: Context, private val player: ExoPlayer) : Runnable, Player.Listener {
    private val handler = Handler(Looper.getMainLooper())
    private val policy = PlaybackRecoveryPolicy()
    private var closed = false
    fun start() { player.addListener(this); handler.postDelayed(this, 1000) }
    fun close() { closed = true; handler.removeCallbacks(this); player.removeListener(this); policy.reset() }
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) { policy.reset() }
    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK) policy.seek(SystemClock.elapsedRealtime())
    }
    override fun run() {
        if (closed) return
        try {
            val item = player.currentMediaItem
            val scheme = item?.localConfiguration?.uri?.scheme
            val networkSource = scheme == "orpheus" || scheme == "http" || scheme == "https"
            val online = (context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.activeNetwork != null
            val errorCode = player.playerError?.errorCode ?: 0
            val intent = player.playWhenReady && player.playbackState != Player.STATE_ENDED && player.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_NONE && errorCode !in 3000..7999
            val attempt = policy.sample(SystemClock.elapsedRealtime(), item?.let { "${player.currentMediaItemIndex}:${it.mediaId}" }, intent, player.playbackState != Player.STATE_READY, player.currentPosition.coerceAtLeast(0), networkSource && !online)
            if (attempt != null && item != null && player.playWhenReady) {
                val index = player.currentMediaItemIndex
                val parameters = player.playbackParameters
                val position = player.currentPosition.coerceAtLeast(0)
                // stop/prepare reopens the original source resolver; queue, rate and part remain unchanged.
                player.stop()
                player.seekTo(index, position)
                player.playbackParameters = parameters
                player.prepare()
                player.playWhenReady = true
                Log.i("PlaybackWatchdog", "Recovering stalled playback, attempt $attempt of 3")
            }
        } catch (error: Exception) { Log.w("PlaybackWatchdog", "Recovery probe failed", error) }
        finally { if (!closed) handler.postDelayed(this, 1000) }
    }
}
