package dev.syncpeer.plugin.android

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PriorityWorkerTest {
  @Test fun highPriorityWorkRunsBeforeQueuedDocumentWork() {
    val worker = PriorityWorker("priority-order-test")
    val blockerStarted = CountDownLatch(1)
    val releaseBlocker = CountDownLatch(1)
    val finished = CountDownLatch(4)
    val order = Collections.synchronizedList(mutableListOf<String>())
    try {
      worker.execute {
        blockerStarted.countDown()
        releaseBlocker.await(5, TimeUnit.SECONDS)
        order.add("document-running")
        finished.countDown()
      }
      assertTrue(blockerStarted.await(5, TimeUnit.SECONDS))
      worker.execute {
        order.add("document-1")
        finished.countDown()
      }
      worker.execute {
        order.add("document-2")
        finished.countDown()
      }
      // Queued while the worker is busy: a session stop must not wait behind the documents.
      worker.executeHighPriority {
        order.add("session-stop")
        finished.countDown()
      }
      releaseBlocker.countDown()
      assertTrue("worker did not drain", finished.await(5, TimeUnit.SECONDS))
      assertEquals(
        listOf("document-running", "session-stop", "document-1", "document-2"),
        order.toList(),
      )
    } finally {
      worker.shutdownNow()
    }
  }

  @Test fun tasksStillRunOneAtATime() {
    val worker = PriorityWorker("priority-serial-test")
    val running = AtomicBoolean(false)
    val overlapped = AtomicBoolean(false)
    val finished = CountDownLatch(3)
    try {
      repeat(3) { index ->
        val task = {
          if (!running.compareAndSet(false, true)) overlapped.set(true)
          Thread.sleep(2)
          running.set(false)
          finished.countDown()
        }
        if (index % 2 == 0) worker.executeHighPriority(task) else worker.execute(task)
      }
      assertTrue("worker did not drain", finished.await(5, TimeUnit.SECONDS))
      assertFalse("the shared runtime must never be evaluated concurrently", overlapped.get())
    } finally {
      worker.shutdownNow()
    }
  }

  @Test fun shutdownDropsQueuedWork() {
    val worker = PriorityWorker("priority-shutdown-test")
    val blockerStarted = CountDownLatch(1)
    val releaseBlocker = CountDownLatch(1)
    val queuedRan = AtomicBoolean(false)
    try {
      worker.execute {
        blockerStarted.countDown()
        releaseBlocker.await(5, TimeUnit.SECONDS)
      }
      assertTrue(blockerStarted.await(5, TimeUnit.SECONDS))
      worker.executeHighPriority { queuedRan.set(true) }
      worker.execute { queuedRan.set(true) }
      worker.shutdownNow()
      releaseBlocker.countDown()
      Thread.sleep(100)
      assertFalse(queuedRan.get())
      assertEquals(0, worker.pendingCount())
    } finally {
      worker.shutdownNow()
    }
  }
}
