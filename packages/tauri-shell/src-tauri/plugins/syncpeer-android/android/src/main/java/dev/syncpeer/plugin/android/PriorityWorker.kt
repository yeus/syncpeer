package dev.syncpeer.plugin.android

import java.util.ArrayDeque

/**
 * One worker thread with a two-level queue.
 *
 * The Android runtime is single-threaded on purpose: evaluations share one JavaScript
 * isolate, so two of them must never run at the same time. But a plain FIFO queue lets
 * a long document command (vault I/O, a 4 MiB fsync, a connect that waits for a dead
 * network) delay unrelated work that the app is actively waiting for. Session teardown
 * is queued as high priority so it runs next instead of behind every queued command,
 * while still running alone.
 */
internal class PriorityWorker(name: String) {
  private val normal = ArrayDeque<Runnable>()
  private val high = ArrayDeque<Runnable>()
  private val lock = Object()
  private var stopped = false
  private val thread = Thread({ runLoop() }, name).apply {
    isDaemon = true
    start()
  }

  fun execute(task: Runnable) = enqueue(task, priority = false)

  fun executeHighPriority(task: Runnable) = enqueue(task, priority = true)

  fun shutdownNow() {
    synchronized(lock) {
      stopped = true
      high.clear()
      normal.clear()
      lock.notifyAll()
    }
  }

  internal fun pendingCount(): Int = synchronized(lock) { high.size + normal.size }

  private fun enqueue(task: Runnable, priority: Boolean) {
    synchronized(lock) {
      if (stopped) return
      if (priority) high.addLast(task) else normal.addLast(task)
      lock.notifyAll()
    }
  }

  private fun runLoop() {
    while (true) {
      val task = synchronized(lock) {
        while (!stopped && high.isEmpty() && normal.isEmpty()) {
          try {
            lock.wait()
          } catch (_: InterruptedException) {
            // Nothing interrupts this worker; keep waiting rather than dying.
          }
        }
        if (stopped) return
        checkNotNull(high.pollFirst() ?: normal.pollFirst())
      }
      try {
        task.run()
      } catch (_: Throwable) {
        // A failing task must not kill the worker that owns the shared runtime.
      }
    }
  }
}
