package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundSessionHandoffTest {
  @Test
  fun preparedRequestStartsOnlyOnce() {
    val handoff = BackgroundSessionHandoff()
    val started = mutableListOf<String>()
    handoff.prepare("one")
    assertTrue(handoff.startPrepared(started::add))
    assertFalse(handoff.startPrepared(started::add))
    assertEquals(listOf("one"), started)
  }

  @Test
  fun replacingOrClearingRequestAllowsANewNativeStart() {
    val handoff = BackgroundSessionHandoff()
    val started = mutableListOf<String>()
    handoff.prepare("one")
    handoff.startPrepared(started::add)
    handoff.prepare("two")
    assertTrue(handoff.startPrepared(started::add))
    handoff.clear()
    handoff.prepare("two")
    assertTrue(handoff.startPrepared(started::add))
    assertEquals(listOf("one", "two", "two"), started)
  }

  @Test
  fun failedNativeStartRemainsRetryable() {
    val handoff = BackgroundSessionHandoff()
    handoff.prepare("one")
    try {
      handoff.startPrepared { throw IllegalStateException("synthetic failure") }
    } catch (_: IllegalStateException) {
      // Expected.
    }
    var attempts = 0
    assertTrue(handoff.startPrepared { attempts++ })
    assertEquals(1, attempts)
  }
}
