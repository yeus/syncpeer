package dev.syncpeer.plugin.android

/** Only transient transport failures are retried. A corrupted staged upload,
 * conflicting local revision or authorization failure requires user attention. */
internal object TransferJobRetryPolicy {
  const val MAX_RETRIES = 6
  private val delaysMs = longArrayOf(5_000, 15_000, 30_000, 60_000, 120_000, 300_000)
  fun nextDelayMs(reason: String?, retries: Int): Long? =
    if (reason == "network" && retries in 0 until MAX_RETRIES) delaysMs[retries] else null
}
