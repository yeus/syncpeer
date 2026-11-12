package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionFailureMessagesTest {
  @Test fun mapsRawSessionErrorsToPlainReasons() {
    assertEquals("The previous connection attempt was cancelled. Try again.",
      safeSessionError(IllegalStateException("signal is aborted without reason")))
    assertEquals("Syncpeer is restarting its local storage service. Try again in a moment.",
      safeSessionError(IllegalStateException("Document runtime is restarting.")))
    assertEquals("The other device has not approved this device yet.",
      safeSessionError(IllegalStateException("waiting for approval of this client")))
    assertEquals("The peer connection timed out. Try again.",
      safeSessionError(IllegalStateException("connection timed out")))
    assertEquals("Peer connection could not be established.",
      safeSessionError(IllegalStateException("unexpected transport failure")))
  }

  @Test fun preservesOnlyPrefixedProviderReasons() {
    val prefixed = prefixedSessionFailure("The previous connection attempt was cancelled. Try again.")
    assertEquals("The previous connection attempt was cancelled. Try again.",
      prefixedSessionFailureText(prefixed))
    assertEquals(null, prefixedSessionFailureText("raw /data/user/0/secret"))
  }
}
