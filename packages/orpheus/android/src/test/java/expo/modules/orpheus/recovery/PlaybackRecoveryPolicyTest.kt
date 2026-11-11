package expo.modules.orpheus.recovery

import org.junit.Assert.*
import org.junit.Test

class PlaybackRecoveryPolicyTest {
    @Test fun frozenClockHasBoundedDelayedRetries() {
        val policy = PlaybackRecoveryPolicy()
        val fired = mutableListOf<Long>()
        for (second in 0L..100L) {
            if (policy.sample(second * 1000, "same", true, false, 100, false) != null) fired.add(second)
        }
        assertEquals(listOf(13L, 28L, 46L), fired)
    }
    @Test fun loadingWaitsTwentySecondsAndOfflineNeverInterrupts() {
        val policy = PlaybackRecoveryPolicy()
        val fired = mutableListOf<Long>()
        for (second in 0L..21L) if (policy.sample(second * 1000, "same", true, true, 0, false) != null) fired.add(second)
        assertEquals(listOf(21L), fired)
        for (second in 22L..100L) assertNull(policy.sample(second * 1000, "same", true, true, 0, true))
    }
    @Test fun pauseSwitchSeekAndSleepCancelPendingRecovery() {
        val policy = PlaybackRecoveryPolicy()
        for (second in 0L..12L) policy.sample(second * 1000, "old", true, false, 10, false)
        assertNull(policy.sample(13000, "old", false, false, 10, false))
        assertNull(policy.sample(14000, "new", true, false, 0, false))
        assertNull(policy.sample(120000, "new", true, false, 0, false))
        policy.seek(121000)
        assertNull(policy.sample(122000, "new", true, false, 0, false))
    }
    @Test fun healthyProgressResetsExhaustedBudget() {
        val policy = PlaybackRecoveryPolicy()
        for (second in 0L..100L) policy.sample(second * 1000, "same", true, false, 0, false)
        for (second in 101L..132L) policy.sample(second * 1000, "same", true, false, (second - 100) * 1000, false)
        val fired = mutableListOf<Long>()
        for (second in 133L..146L) if (policy.sample(second * 1000, "same", true, false, 32000, false) != null) fired.add(second)
        assertEquals(listOf(145L), fired)
    }
}
