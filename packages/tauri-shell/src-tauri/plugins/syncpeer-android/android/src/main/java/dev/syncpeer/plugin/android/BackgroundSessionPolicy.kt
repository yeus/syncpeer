package dev.syncpeer.plugin.android

/** Pure policy used by the service before it owns a network session. */
object BackgroundSessionPolicy {
  fun pauseReason(
    networkAvailable: Boolean,
    networkMetered: Boolean,
    powerSave: Boolean,
    deviceIdle: Boolean,
    allowMetered: Boolean,
    allowPowerSave: Boolean,
    allowDeviceIdle: Boolean,
  ): String? = when {
    !networkAvailable -> "Waiting for a network connection."
    networkMetered && !allowMetered -> "Waiting for an unmetered network."
    powerSave && !allowPowerSave -> "Waiting for normal power mode."
    deviceIdle && !allowDeviceIdle -> "Waiting for the device to leave idle mode."
    else -> null
  }
}
