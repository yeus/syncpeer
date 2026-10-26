package dev.syncpeer.plugin.android

import java.util.concurrent.CopyOnWriteArrayList

/** Immutable peer-session status shared by the service and the visible UI. */
internal data class SessionStatusSnapshot(
  val revision: Long,
  val phase: String,
  val active: Boolean,
  val foreground: Boolean,
  val error: String?,
  val peerPhase: String?,
  val peerError: String?,
  val updatedAtMs: Long,
) {
  fun toEvent(): Map<String, Any?> = buildMap {
    put("type", "sessionStatus")
    put("revision", revision)
    put("phase", phase)
    put("active", active)
    put("foreground", foreground)
    put("updatedAtMs", updatedAtMs)
    error?.let { put("error", it) }
    peerPhase?.let { put("peerPhase", it) }
    peerError?.let { put("peerError", it) }
  }
}

/**
 * Process-local status fan-out. The Android service owns the session, while a
 * plugin instance forwards the same snapshots to the visible WebView.
 */
internal object SessionStatusBus {
  private val listeners = CopyOnWriteArrayList<(SessionStatusSnapshot) -> Unit>()
  @Volatile private var latest: SessionStatusSnapshot? = null

  fun publish(snapshot: SessionStatusSnapshot) {
    latest = snapshot
    // A UI adapter failure must never interrupt a service lifecycle change.
    for (listener in listeners) runCatching { listener(snapshot) }
  }

  /** Replays the latest snapshot so a reattached UI does not wait for a change. */
  fun subscribe(listener: (SessionStatusSnapshot) -> Unit): () -> Unit {
    listeners.add(listener)
    latest?.let { runCatching { listener(it) } }
    return { listeners.remove(listener) }
  }

  fun current(): SessionStatusSnapshot? = latest
}
