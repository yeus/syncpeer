package dev.syncpeer.plugin.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FavoriteSyncOwnershipTest {
  @Test fun disablingBackgroundNeverDisablesVisibleSync() {
    assertTrue(FavoriteSyncOwnership.maySchedule(true, true, false))
    assertTrue(FavoriteSyncOwnership.maySchedule(true, true, true))
  }
  @Test fun hiddenSyncRequiresExplicitBackgroundOptIn() {
    assertFalse(FavoriteSyncOwnership.maySchedule(true, false, false))
    assertTrue(FavoriteSyncOwnership.maySchedule(true, false, true))
    assertFalse(FavoriteSyncOwnership.maySchedule(false, true, true))
  }
}
