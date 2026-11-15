package dev.syncpeer.plugin.android

import java.util.concurrent.CopyOnWriteArrayList

/** Bounded, identity-free sync progress included with native service snapshots. */
internal data class FavoriteSyncSnapshot(
  val runId: Long,
  val stage: String,
  val folderOrdinal: Int = 0,
  val folderCount: Int = 0,
  val itemOrdinal: Int = 0,
  val itemCount: Int = 0,
  val resultCount: Int = 0,
  val problemCount: Int = 0,
  val waitingCount: Int = 0,
  val elapsedMs: Long = 0,
  val stalled: Boolean = false,
  val idleMs: Long = 0,
  val transferredBytes: Long = 0,
  val totalBytes: Long = 0,
) {
  fun toEvent(): Map<String, Any> = mapOf(
    "runId" to runId, "stage" to stage,
    "folderOrdinal" to folderOrdinal, "folderCount" to folderCount,
    "itemOrdinal" to itemOrdinal, "itemCount" to itemCount,
    "resultCount" to resultCount, "problemCount" to problemCount,
    "waitingCount" to waitingCount, "elapsedMs" to elapsedMs,
    "stalled" to stalled, "idleMs" to idleMs,
    "transferredBytes" to transferredBytes, "totalBytes" to totalBytes,
  )
}

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
  val sync: FavoriteSyncSnapshot? = null,
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
    sync?.let { put("sync", it.toEvent()) }
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
/** Authenticated, unapproved incoming identities are suggestions only, never approvals. */
internal object IncomingPeerBus {
  private const val MAX_RECENT = 32
  private val listeners = CopyOnWriteArrayList<(String) -> Unit>()
  private val recent = LinkedHashSet<String>()

  @Synchronized fun publish(deviceId: String) {
    if (!recent.add(deviceId)) return
    if (recent.size > MAX_RECENT) recent.remove(recent.first())
    for (listener in listeners) runCatching { listener(deviceId) }
  }

  @Synchronized fun subscribe(listener: (String) -> Unit): () -> Unit {
    listeners.add(listener)
    for (deviceId in recent) runCatching { listener(deviceId) }
    return { listeners.remove(listener) }
  }
}
