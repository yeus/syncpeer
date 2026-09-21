package dev.syncpeer.plugin.android

import java.util.concurrent.TimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DocumentRuntimeRecoveryPolicyTest {
  @Test fun startupTimeoutStartsTheBoundedRetrySequence() {
    val decision = documentRuntimeRecoveryDecision(1, TimeoutException("synthetic timeout"))

    assertEquals(1_000L, decision.retryDelayMs)
    assertEquals("TimeoutException", decision.failureType)
  }

  @Test fun repeatedFailuresBackOffThenExhaustTheRetryBudget() {
    assertEquals(
      listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L),
      (1..5).map { documentRuntimeRecoveryDecision(it, IllegalStateException()).retryDelayMs },
    )
    assertNull(documentRuntimeRecoveryDecision(6, IllegalStateException()).retryDelayMs)
  }

  @Test fun unrecognizedPrivateStorageWaitsForAnExplicitReset() {
    val decision = documentRuntimeRecoveryDecision(
      1,
      IllegalStateException("$PRIVATE_STORAGE_UNRECOGNIZED: unsupported format marker"),
    )
    assertNull(decision.retryDelayMs)
    assertEquals("PrivateStorageUnrecognized", decision.failureType)
  }

  @Test fun sessionsStartOnlyWhenAHealthyRuntimeIsReady() {
    val ready = DocumentRuntimeStatus("locked", "ready")
    val retrying = DocumentRuntimeStatus("error", "retrying")
    val unsupported = DocumentRuntimeStatus("unsupported", "unsupported")

    assertTrue(documentRuntimeCanStartSession(ready, isolateAvailable = true))
    assertFalse(documentRuntimeCanStartSession(ready, isolateAvailable = false))
    assertFalse(documentRuntimeCanStartSession(retrying, isolateAvailable = false))
    assertFalse(documentRuntimeCanStartSession(unsupported, isolateAvailable = false))
  }
}
