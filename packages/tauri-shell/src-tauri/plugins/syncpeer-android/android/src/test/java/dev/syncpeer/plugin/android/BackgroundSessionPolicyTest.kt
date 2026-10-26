package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BackgroundSessionPolicyTest {
  @Test fun waitsForUnmeteredNetworkByDefault() {
    assertEquals(
      "Waiting for an unmetered network.",
      BackgroundSessionPolicy.pauseReason(true, true, false, false, false, true, false),
    )
  }

  @Test fun waitsForNormalPowerWhenPolicyDisallowsPowerSave() {
    assertEquals(
      "Waiting for normal power mode.",
      BackgroundSessionPolicy.pauseReason(true, false, true, false, false, false, false),
    )
  }

  @Test fun waitsForDozeToEndWhenDeviceIdleIsDisallowed() {
    assertEquals(
      "Waiting for the device to leave idle mode.",
      BackgroundSessionPolicy.pauseReason(true, false, false, true, false, false, false),
    )
  }

  @Test fun permitsSessionWhenAllPolicyRequirementsAreMet() {
    assertNull(BackgroundSessionPolicy.pauseReason(true, false, false, false, false, false, false))
    assertNull(BackgroundSessionPolicy.pauseReason(true, true, true, false, true, true, false))
    assertNull(BackgroundSessionPolicy.pauseReason(true, false, false, true, false, false, true))
  }
}
