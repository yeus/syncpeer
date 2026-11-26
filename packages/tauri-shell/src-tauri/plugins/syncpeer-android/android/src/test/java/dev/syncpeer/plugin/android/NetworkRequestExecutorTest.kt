package dev.syncpeer.plugin.android

import java.util.concurrent.CountDownLatch
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkRequestExecutorTest {
  @Test fun blockedListenersAndReadsCannotStarveHelloWrites() {
    val executor = createNetworkRequestExecutor()
    val started = CountDownLatch(8)
    val release = CountDownLatch(1)
    try {
      repeat(8) {
        executor.execute {
          started.countDown()
          release.await(5, TimeUnit.SECONDS)
        }
      }
      assertTrue("Eight independent native socket reads must run concurrently",
        started.await(2, TimeUnit.SECONDS))
      assertEquals("hello-write-completed",
        executor.submit<String> { "hello-write-completed" }.get(2, TimeUnit.SECONDS))
    } finally {
      release.countDown()
      executor.shutdownNow()
    }
  }

  @Test fun elasticNetworkExecutorHasAHardThreadLimitAndNoUnboundedQueue() {
    val executor = createNetworkRequestExecutor()
    try {
      assertEquals(24, executor.maximumPoolSize)
      assertTrue(executor.queue is SynchronousQueue<*>)
    } finally {
      executor.shutdownNow()
    }
  }
}
