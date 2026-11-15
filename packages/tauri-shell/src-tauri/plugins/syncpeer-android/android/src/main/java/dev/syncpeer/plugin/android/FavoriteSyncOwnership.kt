package dev.syncpeer.plugin.android

/** Foreground favorite synchronization is independent of background permission.
 * Only Android's service runs transfers; these flags control when it may schedule work. */
internal object FavoriteSyncOwnership {
  fun maySchedule(connected: Boolean, uiVisible: Boolean, backgroundArmed: Boolean): Boolean =
    connected && (uiVisible || backgroundArmed)
}
