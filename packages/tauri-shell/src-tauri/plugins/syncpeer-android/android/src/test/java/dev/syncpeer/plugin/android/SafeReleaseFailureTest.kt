package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SafeReleaseFailureTest {
  @Test fun reportsKnownVerificationReasonThroughAsyncWrappers() {
    val failure = IllegalStateException("worker failed", IllegalStateException(
      "Error: Safe release needs more online verified complete copies: " +
        "a connected holder's complete folder manifest differs from this device."))
    assertEquals(
      "The connected holder's complete folder differs from this device; safe release was cancelled.",
      safeReleaseFailureReason(failure),
    )
  }

  @Test fun reportsAClosedPeerSessionWithoutCallingItConnected() {
    assertEquals(
      "No live peer session is available for safe release; the local copy was kept.",
      safeReleaseFailureReason(IllegalStateException(
        "No peer connected to the Android background service for safe release.")),
    )
  }

  @Test fun doesNotEchoUnknownExceptionDetails() {
    assertNull(safeReleaseFailureReason(IllegalStateException(
      "Failure at /private/fixture from 192.0.2.44 DEVICE-SENTINEL")))
  }
}
