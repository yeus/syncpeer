package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TransferJobRetryPolicyTest {
  @Test fun retriesNetworkFailuresWithBoundedBackoff() {
    assertEquals(5000L, TransferJobRetryPolicy.nextDelayMs("network", 0))
    assertEquals(15000L, TransferJobRetryPolicy.nextDelayMs("network", 1))
    assertEquals(300000L, TransferJobRetryPolicy.nextDelayMs("network", 5))
    assertNull(TransferJobRetryPolicy.nextDelayMs("network", 6))
  }
  @Test fun permanentFailuresNeverRetry() {
    for (reason in listOf("storage", "other", "cancelled", "unavailable", null)) {
      assertNull(TransferJobRetryPolicy.nextDelayMs(reason, 0))
    }
  }
}
