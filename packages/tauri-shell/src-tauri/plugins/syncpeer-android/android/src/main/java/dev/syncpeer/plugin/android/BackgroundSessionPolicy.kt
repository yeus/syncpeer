package dev.syncpeer.plugin.android

/** Pure policy used by the service before it owns a network session. */
object BackgroundSessionPolicy {
  fun pauseReason(
    networkAvailable: Boolean,
    networkMetered: Boolean,
    powerSave: Boolean,
    allowMetered: Boolean,
    allowPowerSave: Boolean,
  ): String? = when {
    !networkAvailable -> "Waiting for a network connection."
    networkMetered && !allowMetered -> "Waiting for an unmetered network."
    powerSave && !allowPowerSave -> "Waiting for normal power mode."
    else -> null
  }
}
