package dev.syncpeer.plugin.android

import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Listener accepts and TLS reads can wait for packets for tens of seconds.
 * A fixed-size executor deadlocks BEP Hello writes when its workers are all
 * waiting in those reads. An elastic, zero-queue executor reserves concurrency
 * for writes, closes and discovery without allowing unbounded threads.
 */
internal fun createNetworkRequestExecutor(): ThreadPoolExecutor {
  val nextThread = AtomicInteger()
  return ThreadPoolExecutor(
    4, 24, 30L, TimeUnit.SECONDS, SynchronousQueue<Runnable>(),
  ) { runnable ->
    Thread(runnable, "SyncpeerNetwork-${nextThread.incrementAndGet()}")
  }.apply { allowCoreThreadTimeOut(true) }
}
