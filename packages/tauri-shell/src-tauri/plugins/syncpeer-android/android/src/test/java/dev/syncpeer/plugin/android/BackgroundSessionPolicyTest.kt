package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BackgroundSessionPolicyTest {
  @Test fun waitsForUnmeteredNetworkByDefault() {
    assertEquals(
      "Waiting for an unmetered network.",
      BackgroundSessionPolicy.pauseReason(true, true, false, false, true),
    )
  }

  @Test fun waitsForNormalPowerWhenPolicyDisallowsPowerSave() {
    assertEquals(
      "Waiting for normal power mode.",
      BackgroundSessionPolicy.pauseReason(true, false, true, false, false),
    )
  }

  @Test fun permitsSessionWhenAllPolicyRequirementsAreMet() {
    assertNull(BackgroundSessionPolicy.pauseReason(true, false, false, false, false))
    assertNull(BackgroundSessionPolicy.pauseReason(true, true, true, true, true))
  }
}
