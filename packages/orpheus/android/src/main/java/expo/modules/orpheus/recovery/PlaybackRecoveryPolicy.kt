package expo.modules.orpheus.recovery

/** Monotonic, callback-independent recovery budget. Time values are milliseconds. */
internal class PlaybackRecoveryPolicy {
    private var identity: String? = null
    private var previousTick: Long? = null
    private var position = 0L
    private var stalledSince = 0L
    private var loadingSince: Long? = null
    private var healthySince: Long? = null
    private var pendingAt: Long? = null
    private var graceUntil = 0L
    private var attempts = 0
    private val delays = longArrayOf(1000, 3000, 6000)

    fun reset() { identity = null; previousTick = null; pendingAt = null; healthySince = null; loadingSince = null; attempts = 0; graceUntil = 0 }
    fun seek(now: Long) { pendingAt = null; healthySince = null; stalledSince = now; loadingSince = now; graceUntil = now + 5000 }

    fun sample(now: Long, key: String?, playingIntent: Boolean, loading: Boolean, positionMs: Long, offline: Boolean): Int? {
        if (!playingIntent || key == null) { reset(); return null }
        if (identity != key) { reset(); identity = key; position = positionMs; stalledSince = now; loadingSince = if (loading) now else null }
        val gap = previousTick?.let { now - it } ?: 0
        previousTick = now
        if (gap > 5000 || gap < 0) { seek(now); position = positionMs; return null }
        val advanced = positionMs > position + 25
        if (advanced || positionMs < position - 250) {
            stalledSince = now; pendingAt = null
            if (advanced && !loading) {
                if (healthySince == null) healthySince = now
                if (now - healthySince!! >= 30000) attempts = 0
            } else healthySince = null
        } else healthySince = null
        position = positionMs
        if (!loading) loadingSince = null else if (loadingSince == null) loadingSince = now
        if (offline) { pendingAt = null; stalledSince = now; loadingSince = if (loading) now else null; return null }
        if (now < graceUntil) return null
        val due = pendingAt
        if (due != null) {
            if (now < due) return null
            pendingAt = null; attempts++; stalledSince = now; loadingSince = now; healthySince = null
            return attempts
        }
        val timedOut = if (loading) now - (loadingSince ?: now) >= 20000 else now - stalledSince >= 12000
        if (timedOut && attempts < delays.size) pendingAt = now + delays[attempts]
        return null
    }
}
