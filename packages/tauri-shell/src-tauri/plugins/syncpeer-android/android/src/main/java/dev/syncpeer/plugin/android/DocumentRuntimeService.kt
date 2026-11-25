package dev.syncpeer.plugin.android

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.javascriptengine.JavaScriptSandbox
import org.json.JSONObject
import android.provider.DocumentsContract
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import androidx.core.app.ServiceCompat

data class DocumentRuntimeStatus(
  val phase: String,
  val summary: String,
  val missingFeatures: List<String> = emptyList(),
  val failureType: String? = null,
)

/** One engine owner shared by bound application clients, independent of Activities. */
@RequiresApi(26)
class DocumentRuntimeService : Service() {
  private val mainHandler = Handler(Looper.getMainLooper())
  // Single-threaded by contract; teardown work jumps the queue so a busy worker
  // cannot delay a session stop or the resume that follows it.
  private val worker = PriorityWorker("SyncpeerDocumentsWorker")
  private val pendingEvaluations = java.util.concurrent.ConcurrentHashMap<CompletableFuture<String>, ByteArray>()
  private val storageWorker = Executors.newSingleThreadExecutor()
  // WebView evaluation callbacks arrive on Android's main thread. Keep response
  // decoding, diagnostics and dependent completion callbacks off that thread.
  private val completionWorker = Executors.newSingleThreadExecutor()
  // A BEP session keeps one blocking read active while writes and closes must
  // continue independently through the same native transport.
  private val networkWorker = Executors.newFixedThreadPool(4)
  private var storage: DocumentRuntimeStorage? = null
  private var network: SessionNetworkTransport? = null
  private var documentsStarted = false
  @Volatile private var sessionStarted = false
  @Volatile private var sessionRequest: String? = null
  @Volatile private var sessionGeneration = 0L
  private var pendingSessionStart: CompletableFuture<JSONObject>? = null
  // Concurrent stop requests share the same teardown and generation.
  private var pendingSessionStop: CompletableFuture<JSONObject>? = null
  private val uiConnectLock = Any()
  private var uiConnectGeneration = 0L
  private var uiConnectRequest: String? = null
  private var uiConnectExpectedPeer: String? = null
  private var uiConnectPending: CompletableFuture<JSONObject>? = null
  @Volatile private var sessionPhase = "idle"
  @Volatile private var sessionError: String? = null
  @Volatile private var peerPhase: String? = null
  @Volatile private var peerError: String? = null
  @Volatile private var peerAuthenticatedAtElapsedMs = 0L
  @Volatile private var verifiedTransferPeerId: String? = null
  @Volatile private var statusRevision = 0L
  private var lastDiagnosticSessionPhase: String? = null
  private var lastDiagnosticPeerPhase: String? = null
  private val slowLoggedAtMs = java.util.concurrent.ConcurrentHashMap<String, Long>()
  @Volatile private var foregroundStarted = false
  // SAF descriptors belong to external applications, not the peer session.
  // Track them on the main thread; do not keep the network connected for playback.
  private val documentLeases = mutableSetOf<Any>()
  @Volatile private var uiIsVisible = false
  @Volatile private var backgroundSyncArmed = false
  // Short-lived keepalive is independent of the opt-in for continuous favorite sync.
  // The service owns the socket even when the Activity/WebView is hidden.
  @Volatile private var backgroundGraceUntilElapsedMs = 0L
  private val backgroundGraceRunnable = Runnable { expireBackgroundGrace() }
  private val backgroundSessions by lazy { BackgroundSessionStore(applicationContext) }
  private val transferJobs by lazy { TransferJobStore(applicationContext) }
  private val transferStages by lazy { EncryptedUploadStaging(applicationContext) }
  private val transferRetryRunnable = Runnable { replayTransferJobs() }
  private var transferStagesPruned = false
  private val transferJobDispatches = java.util.Collections.synchronizedSet(mutableSetOf<String>())
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var powerReceiver: BroadcastReceiver? = null
  private val initialized = CompletableFuture<DocumentRuntimeStatus>()
  private val favoriteSyncPending = AtomicBoolean(false)
  @Volatile private var favoriteSyncTelemetry: FavoriteSyncSnapshot? = null
  @Volatile private var favoriteSyncRunId = 0L
  @Volatile private var favoriteSyncStartedAtMs = 0L
  @Volatile private var favoriteSyncLastProgressAtMs = 0L
  private var favoriteSyncProgressSequence = 0
  private var favoriteSyncLastPublishedAtMs = 0L
  private var favoriteSyncWatchdog: Runnable? = null
  private val favoriteSyncRunnable = object : Runnable {
    override fun run() {
      if (!FavoriteSyncOwnership.maySchedule(sessionPhase == "connected", uiIsVisible, backgroundSyncArmed)) return
      requestFavoriteSync()
      mainHandler.postDelayed(this, FAVORITE_SYNC_INTERVAL_MS)
    }
  }
  private val binder = RuntimeBinder()
  private var runtimeHost: DocumentRuntimeHost? = null
  private var runtimeGeneration = 0L
  @Volatile private var terminalStatus: DocumentRuntimeStatus? = null
  @Volatile private var vaultSummary: String? = null
  @Volatile private var recovery: CompletableFuture<DocumentRuntimeStatus>? = null
  private var recoveryFailureCount = 0
  private var pendingRecoveryRetry: Runnable? = null
  private var recoveryWillRetry = false
  private var injectedRecoveryFailures = 0
  private var injectedRecoveryAttempts = 0
  private var forceWebViewForTesting = false
  @Volatile private var destroying = false

  inner class RuntimeBinder : Binder() {
    fun status(): CompletableFuture<DocumentRuntimeStatus> = initialized.thenCompose { initial ->
      recovery?.thenApply { it.copy(summary = vaultSummary ?: it.summary) }
        ?: CompletableFuture.completedFuture(terminalStatus ?: initial.copy(summary = vaultSummary ?: initial.summary))
    }

    internal fun retainDocumentLease(token: Any) = runOnMain {
      if (destroying) return@runOnMain
      documentLeases.add(token)
      if (!uiIsVisible) keepDocumentForeground()
    }

    internal fun releaseDocumentLease(token: Any) = runOnMain {
      if (!documentLeases.remove(token) || documentLeases.isNotEmpty()) return@runOnMain
      DiagnosticLogJournal.recordNative(applicationContext, "native.document.lease.last_closed")
      if (foregroundStarted && !backgroundSyncArmed && !backgroundGraceActive() &&
        (uiIsVisible || sessionPhase == "idle") &&
        runCatching { transferJobs.pending().isEmpty() }.getOrDefault(false)) {
        foregroundStarted = false
        ServiceCompat.stopForeground(this@DocumentRuntimeService, ServiceCompat.STOP_FOREGROUND_REMOVE)
        SyncpeerSessionNotifications.cancel(this@DocumentRuntimeService)
        publishSessionStatus()
      }
    }

    internal fun restartForTesting(): CompletableFuture<DocumentRuntimeStatus> = startRecovery()

    internal fun injectRecoveryFailuresForTesting(count: Int) {
      check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
        "Runtime failure injection requires a debuggable build."
      }
      require(count in 0..6) { "Invalid injected runtime failure count." }
      synchronized(this@DocumentRuntimeService) {
        injectedRecoveryFailures = count
        injectedRecoveryAttempts = 0
      }
    }

    internal fun injectedRecoveryAttemptsForTesting(): Int =
      synchronized(this@DocumentRuntimeService) { injectedRecoveryAttempts }

    internal fun resetRecoveryBudgetForTesting(): CompletableFuture<DocumentRuntimeStatus> {
      check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
        "Runtime recovery reset requires a debuggable build."
      }
      synchronized(this@DocumentRuntimeService) {
        injectedRecoveryFailures = 0
        recoveryFailureCount = 0
        cancelPendingRecoveryRetry()
      }
      return startRecovery()
    }

    internal fun runtimeKindForTesting(): DocumentRuntimeKind? = runtimeHost?.kind

    internal fun forceWebViewForTesting(): CompletableFuture<DocumentRuntimeStatus> {
      check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
        "Runtime selection override requires a debuggable build."
      }
      forceWebViewForTesting = true
      return startRecovery()
    }

    internal fun backgroundSessionStatus(): JSONObject = sessionStatus()
    /** Instrumentation-only deterministic scheduling barrier; never exposed to application code. */
    internal fun blockSessionWorkerForTesting(release: CountDownLatch): CountDownLatch {
      check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
      val entered = CountDownLatch(1)
      worker.execute {
        entered.countDown()
        release.await(8, TimeUnit.SECONDS)
      }
      return entered
    }

    /** Deterministic regression: an in-flight peer handshake may not starve document commands. */
    internal fun pendingSessionEvaluationForTesting(entered: CountDownLatch): CompletableFuture<String> {
      check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
      return evaluateSessionWork("""
        await new Promise(resolve => setTimeout(resolve, 4500));
        return "completed";
      """.trimIndent(), ByteArray(0), onDispatched = { entered.countDown() })
    }
    /** A slow favorite walk must not hold the native worker needed for document status. */
    internal fun pendingFavoriteSyncEvaluationForTesting(entered: CountDownLatch): CompletableFuture<String> {
      check(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
      return evaluateFavoriteWork("""
        await new Promise(resolve => setTimeout(resolve, 4500));
        return "completed";
      """.trimIndent(), "{}".toByteArray(Charsets.UTF_8),
        onDispatched = { entered.countDown() })
    }



    fun command(input: JSONObject): CompletableFuture<JSONObject> {
      return evaluateRuntime("""
        let stage = "bootstrap";
        try {
          const initializeStarted = Date.now();
          const wasInitialized = !!globalThis.syncpeerDocuments;
          if (!wasInitialized) globalThis.syncpeerDocuments =
            await globalThis.syncpeerDocumentsCore.startDocuments(android, step => { stage = step; });
          const initializationMs = Date.now() - initializeStarted;
          stage = "command";
          const commandStarted = Date.now();
          const result = await globalThis.syncpeerDocuments.command(input);
          return JSON.stringify({result: result === undefined ? null : result,
            __documentTimings: {initializationMs: wasInitialized ? 0 : initializationMs,
              commandMs: Date.now() - commandStarted}});
        } catch (error) {
          // No exception messages, document contents, paths or secret material
          // cross the diagnostic boundary. Only fixed bootstrap stages/types.
          const allowedStages = ["bootstrap", "timers", "storage-port", "profile-root",
            "filesystem-create", "filesystem-initialize", "profile-replica",
            "vault-load", "folders-open", "initial-status", "ready", "command"];
          const allowedTypes = ["Error", "TypeError", "RangeError", "SyntaxError",
            "ReferenceError", "URIError", "DOMException", "NotAllowedError", "OperationError"];
          const type = error && typeof error.name === "string" ? error.name : "Other";
          const message = error && typeof error.message === "string" ? error.message : "";
          const category = message.includes("Document storage operation failed")
            ? "storage-request"
            : message.includes("Existing metadata requires") ? "protected-metadata-key"
            : message.includes("Remembered credential key is missing") ? "keystore-key-missing"
            : message.includes("Document vault is locked") ? "vault-locked"
            : "other";
          return JSON.stringify({__documentFailure: {
            stage: allowedStages.includes(stage) ? stage : "unknown",
            type: allowedTypes.includes(type) ? type : "Other",
            category,
          }});
        }
      """.trimIndent(), input.toString().toByteArray(Charsets.UTF_8),
        releaseWorkerWhilePending = true, diagnosticOperation = input.optString("operation")).thenApply { value ->
        val reply = JSONObject(value)
        val failure = reply.optJSONObject("__documentFailure")
        if (failure != null) {
          // The JS isolate has already discarded the original exception string.
          // This event is safe to retain in production diagnostics.
          val stage = failure.optString("stage").takeIf { it in setOf(
            "bootstrap", "timers", "storage-port", "profile-root", "filesystem-create",
            "filesystem-initialize", "ready", "command") } ?: "unknown"
          val type = failure.optString("type").takeIf { it in setOf(
            "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
            "URIError", "DOMException", "NotAllowedError", "OperationError") } ?: "Other"
          val category = failure.optString("category").takeIf { it in setOf(
            "storage-request", "protected-metadata-key", "keystore-key-missing",
            "vault-locked", "other") } ?: "other"
          DiagnosticLogJournal.recordNative(applicationContext, "native.document.command_failed",
            "error", JSONObject().put("operation",
              input.optString("operation").takeIf { it.matches(Regex("[A-Za-z]{1,48}")) } ?: "other")
              .put("stage", stage).put("errorType", type).put("category", category))
          if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            Log.w("SyncpeerRuntime", "document command failed: stage=$stage category=$category type=$type")
          throw IllegalStateException("Document runtime evaluation failed.")
        }
        val timing = reply.optJSONObject("__documentTimings")
        reply.remove("__documentTimings") // Never expose diagnostic metadata through the document-command API.
        if (timing != null) {
          val startupMs = timing.optLong("initializationMs")
          val commandMs = timing.optLong("commandMs")
          val operation = input.optString("operation").takeIf { it.matches(Regex("[A-Za-z]{1,48}")) } ?: "other"
          if ((startupMs >= 1_000 || commandMs >= 1_000) &&
              applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            Log.w("SyncpeerRuntime", "document.runtime.stage_slow operation=$operation initializationMs=$startupMs commandMs=$commandMs")
          if (startupMs >= 1_500 || commandMs >= 1_500)
            DiagnosticLogJournal.recordNative(applicationContext, "native.document.operation_slow",
              "warning", JSONObject().put("operation", operation)
                .put("initializationMs", startupMs).put("commandMs", commandMs))
        }
        val phase = reply.optJSONObject("result")?.optJSONObject("vault")
          ?.optString("phase")?.takeIf { it.isNotBlank() }
        if (phase != null) vaultSummary = when (phase) {
          "unlocked" -> "Downloaded files available offline."
          "locked" -> "Open Syncpeer to unlock folder storage."
          else -> "Preparing folder storage."
        }
        if (input.optString("operation") in listOf("rememberFolder", "register", "createVault", "unlock", "lock", "create", "rename", "flush", "release", "finishDownload", "remove", "discardCachedFile", "attachDownloads")) {
          contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
        }
        if (input.optString("operation") in listOf("release", "remove", "rename", "saveProfileSettings", "recordFavoriteResolution", "clearFavoriteSyncEntry")) requestFavoriteSync()
        reply
      }
    }

    fun sessionCommand(input: JSONObject): CompletableFuture<JSONObject> {
      if (input.optString("operation") == "uiHidden") {
        val result = CompletableFuture<JSONObject>()
        mainHandler.post {
          uiIsVisible = false
          if (!backgroundSyncArmed) {
            stopFavoriteSyncSchedule()
            beginBackgroundGrace()
          }
          if (documentLeases.isNotEmpty()) keepDocumentForeground()
          // A user-requested transfer continues independently of background favorites.
          if (runCatching { transferJobs.pending().isNotEmpty() }.getOrDefault(false)) {
            ensureForeground()
            replayTransferJobs()
          }
          result.complete(JSONObject().put("result", JSONObject().put("visible", false)))
        }
        return result
      }
      if (input.optString("operation") == "uiVisible") {
        val result = CompletableFuture<JSONObject>()
        mainHandler.post {
          cancelBackgroundGrace("visible")
          uiIsVisible = true
          replayTransferJobs()
          if (sessionPhase == "connected") startFavoriteSyncSchedule()
          if (foregroundStarted && documentLeases.isEmpty()) {
            foregroundStarted = false
            ServiceCompat.stopForeground(this@DocumentRuntimeService, ServiceCompat.STOP_FOREGROUND_REMOVE)
            SyncpeerSessionNotifications.cancel(this@DocumentRuntimeService)
            publishSessionStatus()
          }
          result.complete(JSONObject().put("result", JSONObject().put("visible", true)))
        }
        return result
      }
      val operation = input.optString("operation")
      if (operation == "status") {
        // Observation must never wait behind a document decrypt, favorite scan
        // or pending TLS/BEP evaluation. The native status bus already owns
        // the authoritative authenticated session/peer phase snapshot.
        require(input.optInt("protocolVersion", -1) == SESSION_PROTOCOL_VERSION) {
          "Invalid Android session status protocol version."
        }
        return CompletableFuture.completedFuture(JSONObject().put("result", sessionStatus()))
      }
      if (operation == "transferStageBegin") {
        val stageId = transferStages.begin(input.getLong("sizeBytes"), input.getLong("modifiedMs"))
        return CompletableFuture.completedFuture(JSONObject().put("result", JSONObject().put("stageId", stageId)))
      }
      if (operation == "transferStageWrite") {
        val offset = transferStages.append(input.getString("stageId"),
          input.getLong("offset"), input.getString("bytes"))
        return CompletableFuture.completedFuture(JSONObject().put("result", JSONObject().put("offset", offset)))
      }
      if (operation == "transferStageCancel") {
        val id = input.getString("stageId")
        check(!transferJobs.referencedStages().contains(id)) { "An active transfer owns this stage." }
        transferStages.discard(id)
        return CompletableFuture.completedFuture(JSONObject().put("result", JSONObject().put("cancelled", true)))
      }
      if (operation == "transferStageFinish") {
        val id = input.getString("stageId")
        val stage = transferStages.finish(id)
        val job = try {
          transferJobs.enqueue("upload", input.getString("folderId"), input.getString("path"),
            input.getString("peerId"), stage)
        } catch (error: Exception) {
          transferStages.discard(id)
          throw error
        }
        if (job.optString("stageId") != id) transferStages.discard(id)
        ensureForeground()
        replayTransferJobs()
        return CompletableFuture.completedFuture(JSONObject().put("result", JSONObject()
          .put("id", job.getString("id")).put("phase", job.optString("phase"))))
      }
      if (operation == "transferJobStart") {
        val job = transferJobs.enqueue(input.optString("direction"),
          input.optString("folderId"), input.optString("path"), input.optString("peerId"))
        ensureForeground()
        replayTransferJobs()
        return CompletableFuture.completedFuture(JSONObject().put("result", JSONObject()
          .put("id", job.getString("id")).put("phase", job.optString("phase"))))
      }
      if (operation == "transferJobStatus") {
        val job = transferJobs.list().firstOrNull { it.optString("id") == input.optString("id") }
          ?: throw IllegalArgumentException("Transfer job not found.")
        return CompletableFuture.completedFuture(JSONObject().put("result", job))
      }
      if (operation == "transferJobList") {
        return CompletableFuture.completedFuture(JSONObject().put("result", JSONObject()
          .put("jobs", org.json.JSONArray(transferJobs.list()))))
      }
      if (operation == "transferJobCancel") {
        val id = input.optString("id")
        val existing = transferJobs.list().find { it.optString("id") == id }
        transferJobs.cancel(id)
        existing?.optString("stageId")?.takeIf { it.isNotBlank() }?.let { transferStages.discard(it) }
        val command = JSONObject().put("protocolVersion", SESSION_PROTOCOL_VERSION)
          .put("operation", "transferJobCancel").put("id", id)
        evaluateSessionWork("""
          if (globalThis.syncpeerSession) await globalThis.syncpeerSession.command(input);
          return JSON.stringify({result: {cancelled: true}});
        """.trimIndent(), command.toString().toByteArray(Charsets.UTF_8), operationName = "TransferCancel")
        return CompletableFuture.completedFuture(JSONObject().put("result", JSONObject().put("cancelled", true)))
      }
      if (operation == "disarmBackground") {
        // Clearing opt-in must never tear down the visible WebView's shared
        // connection. Invalidate queued background starts and forget persistence.
        val result = CompletableFuture<JSONObject>()
        try {
          worker.executeHighPriority {
            try {
              nextSessionGeneration()
              sessionRequest = null
              backgroundSessions.clear()
              backgroundSyncArmed = false
              // Disarming continuous sync must not cancel the short grace period.
              if (uiIsVisible && sessionPhase == "connected") startFavoriteSyncSchedule()
              else stopFavoriteSyncSchedule()
              runOnMain {
                // Background favorite opt-out does not revoke an explicitly
                // started manual transfer. Keep its foreground service until
                // the persistent job journal reports no remaining work.
                val manualTransferActive = runCatching { transferJobs.pending().isNotEmpty() }.getOrDefault(false)
                if (foregroundStarted && !manualTransferActive && !backgroundGraceActive() && documentLeases.isEmpty()) {
                  foregroundStarted = false
                  ServiceCompat.stopForeground(this@DocumentRuntimeService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                  SyncpeerSessionNotifications.cancel(this@DocumentRuntimeService)
                }
                if (manualTransferActive && !uiIsVisible) ensureForeground()
                publishSessionStatus()
                result.complete(JSONObject().put("result", JSONObject().put("disarmed", true)))
              }
            } catch (error: Exception) {
              result.completeExceptionally(error)
            }
          }
        } catch (error: Exception) {
          result.completeExceptionally(error)
        }
        return result
      }
      if (operation == "connect") uiIsVisible = true
      if (operation == "disconnect") {
        val prior = synchronized(uiConnectLock) {
          val pending = uiConnectPending
          uiConnectGeneration += 1
          uiConnectPending = null
          uiConnectRequest = null
          uiConnectExpectedPeer = null
          pending
        }
        return stopSession(persist = true).thenCompose { status ->
          val response = JSONObject().put("result", JSONObject().put("phase", status.optString("phase")))
          val settled = CompletableFuture<JSONObject>()
          if (prior == null || prior.isDone) {
            settled.complete(response)
          } else {
            // Let the superseded connect evaluation settle before the next
            // connect starts; its cancellation must not abort the new attempt.
            mainHandler.postDelayed({ settled.complete(response) }, UI_CONNECT_SETTLE_MS)
            prior.whenComplete { _, _ -> settled.complete(response) }
          }
          settled
        }
      }
      val code = """
        if (!globalThis.syncpeerDocuments) globalThis.syncpeerDocuments = await globalThis.syncpeerDocumentsCore.startDocuments(android);
        if (!globalThis.syncpeerSession) globalThis.syncpeerSession = await globalThis.syncpeerDocumentsCore.startSession(android, globalThis.syncpeerDocuments);
        const result = await globalThis.syncpeerSession.command({
          protocolVersion: ${SESSION_PROTOCOL_VERSION}, ...input,
        });
        return JSON.stringify({result: result === undefined ? null : result});
      """.trimIndent()
      val rawInput = input.toString()
      if (operation != "connect") {
        // A BEP metadata/read/write request may wait on the peer for many seconds.
        // Never hold the document worker while the JS isolate awaits its result.
        return evaluateSessionWork(code, rawInput.toByteArray(Charsets.UTF_8),
          operationName = operation).thenApply(::JSONObject)
      }
      // Concurrent WebView retries must share one in-flight native command.
      // Superseded completions may not overwrite a newer peer's phase.
      return synchronized(uiConnectLock) {
        val prior = uiConnectPending
        if (uiConnectRequest == rawInput && prior != null && !prior.isDone) {
          // Return promptly even when the existing native dial is queued or
          // waiting on TLS/BEP. Its completion is reported via sessionStatus.
          return@synchronized CompletableFuture.completedFuture(JSONObject()
            .put("result", JSONObject().put("phase", "starting")))
        }
        if (uiConnectRequest == rawInput && prior == null) {
          val expected = uiConnectExpectedPeer
          if (sessionPhase == "connected" && sessionStarted && peerPhase == "connected" &&
            expected != null && expected == verifiedTransferPeerId) {
            // Rebinding the WebView to an already TLS-authenticated service
            // socket must not tear it down and start another global discovery.
            return@synchronized CompletableFuture.completedFuture(JSONObject()
              .put("result", JSONObject().put("phase", "connected")))
          }
          if (sessionPhase in setOf("starting", "waiting", "reconnecting") &&
            sessionError == null) {
            // The original native lifecycle continues its own retries. A
            // second UI subscriber must observe it, never replace its dial.
            return@synchronized CompletableFuture.completedFuture(JSONObject()
              .put("result", JSONObject().put("phase", "reconnecting")))
          }
        }
        uiConnectGeneration += 1
        val generation = uiConnectGeneration
        uiConnectRequest = rawInput
        uiConnectExpectedPeer = input.optJSONObject("options")?.optString("remoteId")
          ?.replace("-", "")?.uppercase()?.takeIf { it.isNotBlank() }
        sessionPhase = "starting"
        sessionError = null
        peerPhase = null
        peerError = null
        publishSessionStatus()
        val pending = evaluateRuntime(code, rawInput.toByteArray(Charsets.UTF_8),
          releaseWorkerWhilePending = true, diagnosticOperation = "sessionConnect")
          .thenApply { raw ->
            JSONObject(raw).also { reply ->
              synchronized(uiConnectLock) {
                if (generation == uiConnectGeneration) {
                  val phase = reply.optJSONObject("result")?.optString("phase", "connected") ?: "connected"
                  // A pending connect reply can arrive after the peer started
                  // another handshake. Only the authenticated lifecycle may
                  // promote the service to an active connected session.
                  val authenticated = peerPhase == "connected" &&
                    uiConnectExpectedPeer != null &&
                    uiConnectExpectedPeer == verifiedTransferPeerId
                  if (phase == "connected" && authenticated) {
                    sessionStarted = true
                    sessionPhase = "connected"
                  } else if (sessionPhase != "connected") {
                    sessionStarted = false
                    sessionPhase = if (phase == "connected") "starting" else phase
                  }
                  sessionError = null
                  if (sessionPhase == "connected" && sessionStarted) {
                    startFavoriteSyncSchedule()
                    replayTransferJobs()
                  }
                  publishSessionStatus()
                }
              }
            }
          }.whenComplete { _, error ->
            synchronized(uiConnectLock) {
              if (generation == uiConnectGeneration) {
                uiConnectPending = null
                if (error != null && sessionPhase != "connected") {
                  sessionPhase = "error"
                  sessionError = safeSessionError(error)
                  publishSessionStatus()
                }
              }
            }
          }
        uiConnectPending = pending
        // The WebView subscribes to authoritative sessionStatus after this
        // nonterminal acknowledgment. Never hold its RPC until discovery,
        // authorization or BEP finishes; those can take tens of seconds.
        CompletableFuture.completedFuture(JSONObject()
          .put("result", JSONObject().put("phase", "starting")))
      }
    }

    internal fun startBackgroundSession(input: JSONObject): CompletableFuture<JSONObject> {
      return scheduleBackgroundSession(input.toString(), persist = true)
    }

    internal fun stopBackgroundSession(): CompletableFuture<JSONObject> {
      val result = stopSession(persist = true)
      // A superseded stop settles with the superseding request's phase; only an idle
      // service may be stopped without killing that newer session.
      result.whenComplete { status, _ ->
        mainHandler.post { if (status?.optString("phase") == "idle" && documentLeases.isEmpty()) stopSelf() }
      }
      return result
    }

    /** Trusted packaged code only. Application data travels through named bytes. */
    internal fun evaluate(code: String, input: ByteArray): CompletableFuture<String> {
      return evaluateRuntime(code, input)
    }
  }

  /**
   * Runs one evaluation on the shared worker. A caller-supplied [timeoutMs] means
   * "give up on this step"; it frees the worker without restarting the runtime, and
   * is only used for steps that must not block every later document command.
   */
  private fun evaluateRuntime(
    code: String,
    input: ByteArray,
    timeoutMs: Long? = null,
    highPriority: Boolean = false,
    releaseWorkerWhilePending: Boolean = false,
    onDispatched: () -> Unit = {},
    diagnosticOperation: String? = null,
  ): CompletableFuture<String> {
    require(input.size <= 1024 * 1024) { "Document runtime input is too large." }
    require(!releaseWorkerWhilePending || timeoutMs == null) {
      "Nonblocking session evaluation uses its caller's deadline."
    }
    val result = CompletableFuture<String>()
    if (destroying) {
      result.completeExceptionally(IllegalStateException("Document runtime is closing."))
      return result
    }
    val data = (if (input.isEmpty()) "{}".toByteArray(Charsets.UTF_8) else input).copyOf()
    pendingEvaluations[result] = data
    result.whenComplete { _, _ -> pendingEvaluations.remove(result) }
    val queuedAtMs = SystemClock.elapsedRealtime()
    // Only operation names are logged, never paths, names, keys or payloads.
    val safeOperation = diagnosticOperation?.takeIf { it.matches(Regex("[A-Za-z]{1,48}")) }
    fun reportLatency(phase: String, durationMs: Long) {
      if (safeOperation == null || durationMs < 2000) return
      if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        Log.w("SyncpeerRuntime", "document.runtime.$phase operation=$safeOperation durationMs=$durationMs")
      if (durationMs < 4000) return
      val key = "$phase.$safeOperation"
      val now = SystemClock.elapsedRealtime()
      val previous = slowLoggedAtMs.put(key, now) ?: 0L
      if (now - previous >= 30_000L || previous == 0L) {
        // Never persist raw request contents, endpoints, paths or credentials.
        DiagnosticLogJournal.recordNative(applicationContext, "native.runtime.slow.$key",
          "warning", JSONObject().put("durationMs", durationMs))
      }
    }
    val task = Runnable {
      var handedOff = false
      val startedAtMs = SystemClock.elapsedRealtime()
      reportLatency("queue_slow", startedAtMs - queuedAtMs)
      try {
        if (result.isDone) return@Runnable
        check(!destroying) { "Document runtime is closing." }
        check(terminalStatus == null && runtimeHost != null) { "Document runtime unavailable." }
        val evaluation = checkNotNull(runtimeHost).evaluate(code, data)
        onDispatched()
        if (releaseWorkerWhilePending) {
          // Dispatch is serialized, not the asynchronous result. The core owns
          // mutation ordering and may admit reads during a download commit.
          evaluation.whenCompleteAsync({ value, error ->
            try {
              reportLatency("async_slow", SystemClock.elapsedRealtime() - startedAtMs)
              if (error != null) result.completeExceptionally(error)
              else result.complete(value)
            } finally { data.fill(0) }
          }, completionWorker)
          handedOff = true
        } else {
          // Trusted core publication is bounded by file size, not a fixed
          // deadline; large-file fsync may take longer than 15 seconds.
          result.complete(
            if (timeoutMs == null) evaluation.get()
            else evaluation.get(timeoutMs, TimeUnit.MILLISECONDS),
          )
        }
      } catch (error: Exception) {
        // A host-level timeout means the runtime is wedged; a caller bound does not.
        if (error is TimeoutException && timeoutMs == null) startRecovery()
        result.completeExceptionally(error)
      } finally {
        if (!handedOff) {
          reportLatency("execution_slow", SystemClock.elapsedRealtime() - startedAtMs)
          data.fill(0)
        }
      }
    }
    try {
      check(worker.tryExecute(task, highPriority)) { "Document runtime is closing." }
    } catch (error: Exception) {
      data.fill(0)
      result.completeExceptionally(error)
    }
    return result
  }

  @Synchronized
  private fun nextSessionGeneration(start: CompletableFuture<JSONObject>? = null): Long {
    // Every superseded start must settle, even if its task never reaches the
    // single-threaded worker (e.g. a queued start overtaken by priority stop).
    val previous = pendingSessionStart
    pendingSessionStart = start
    sessionGeneration += 1
    previous?.complete(sessionStatus())
    return sessionGeneration
  }

  private fun parseSessionRequest(raw: String): JSONObject? = runCatching {
    JSONObject(raw).takeIf {
      it.optString("operation") == "connect" && it.toString().length <= 4096
    }
  }.getOrNull()

  private fun sessionOptions(input: JSONObject): JSONObject =
    input.optJSONObject("options") ?: input

  private fun runOnMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action()
    else mainHandler.post(action)
  }

  private fun sessionStatus(): JSONObject = JSONObject()
    .put("phase", sessionPhase)
    .put("active", sessionStarted)
    .put("error", sessionError ?: JSONObject.NULL)
    .put("revision", statusRevision)
    .put("foreground", foregroundStarted)
    .put("peerPhase", peerPhase ?: JSONObject.NULL)
    .put("peerError", peerError ?: JSONObject.NULL)

  @Synchronized
  private fun publishSessionStatus() {
    if (lastDiagnosticSessionPhase != sessionPhase) {
      lastDiagnosticSessionPhase = sessionPhase
      DiagnosticLogJournal.recordNative(applicationContext,
        "native.session.phase." + sessionPhase.replace(Regex("[^A-Za-z0-9_-]"), "_"))
    }
    if (lastDiagnosticPeerPhase != peerPhase) {
      lastDiagnosticPeerPhase = peerPhase
      peerPhase?.let { phase ->
        DiagnosticLogJournal.recordNative(applicationContext,
          "native.peer.phase." + phase.replace(Regex("[^A-Za-z0-9_-]"), "_"))
      }
    }
    statusRevision += 1
    SessionStatusBus.publish(SessionStatusSnapshot(
      revision = statusRevision,
      phase = sessionPhase,
      active = sessionStarted,
      foreground = foregroundStarted,
      error = sessionError,
      peerPhase = peerPhase,
      peerError = peerError,
      updatedAtMs = System.currentTimeMillis(),
      sync = favoriteSyncTelemetry,
    ))
  }

  private fun backgroundPauseReason(input: JSONObject): String? {
    val options = input.optJSONObject("options") ?: input
    val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    val network = manager?.activeNetwork
    val capabilities = network?.let(manager::getNetworkCapabilities)
    val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
    return BackgroundSessionPolicy.pauseReason(
      networkAvailable = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
      networkMetered = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true,
      powerSave = power?.isPowerSaveMode == true,
      deviceIdle = power?.isDeviceIdleMode == true,
      allowMetered = options.optBoolean("allowMetered", false),
      allowPowerSave = options.optBoolean("allowPowerSave", false),
      allowDeviceIdle = options.optBoolean("allowDeviceIdle", false),
    )
  }

  private fun debugNetworkEvent(message: String) {
    if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
      Log.w("SyncpeerRuntime", message)
    }
  }

  private fun pauseForPolicy(reason: String) {
    debugNetworkEvent("policy pause: $reason")
    if (sessionPhase == "waiting" && sessionError == reason) return
    val request = sessionRequest
    if (request == null) {
      debugNetworkEvent("policy pause ignored: no session request")
      return
    }
    DiagnosticLogJournal.recordNative(applicationContext, "native.session.policy.paused", "info",
      JSONObject().put("reason", when (reason) {
        "Waiting for a network connection." -> "network"
        "Waiting for an unmetered network." -> "metered"
        "Waiting for normal power mode." -> "battery_saver"
        "Waiting for the device to leave idle mode." -> "device_idle"
        else -> "other"
      }))
    val generation = nextSessionGeneration()
    val wasStarted = sessionStarted && documentsStarted && runtimeHost != null
    sessionStarted = false
    sessionPhase = "waiting"
    sessionError = reason
    publishSessionStatus()
    runOnMain {
      if (generation == sessionGeneration) {
        SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", reason)
      }
    }
    if (wasStarted) {
      // A policy pause also may not hold the shared worker behind a dead network.
      evaluateRuntime("""
        if (globalThis.syncpeerSession) await globalThis.syncpeerSession.command({
          protocolVersion: ${SESSION_PROTOCOL_VERSION}, operation: "disconnect",
        });
        return JSON.stringify({result: {phase: "idle"}});
      """.trimIndent(), ByteArray(0), SESSION_STOP_TIMEOUT_MS, highPriority = true)
    }
  }

  private fun refreshConnectedBackgroundNotice() {
    runOnMain {
      val request = sessionRequest?.let(::parseSessionRequest) ?: return@runOnMain
      // A delayed peer event must not override a deliberate metered/power policy pause.
      if (sessionStarted && sessionPhase == "connected" && backgroundSyncArmed &&
        !uiIsVisible && backgroundPauseReason(request) == null) {
        SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization",
          "Peer session connected; selected sync is ready.")
      }
    }
  }

  private fun resumePersistedSessionIfAllowed() {
    runCatching {
      worker.execute {
        val request = sessionRequest ?: runCatching { backgroundSessions.load() }.getOrNull() ?: return@execute
        val input = parseSessionRequest(request) ?: return@execute
        if (backgroundPauseReason(input) != null) return@execute
        if (sessionPhase == "connected") {
          // A late policy callback may have left the notification at "waiting"
          // even though the authenticated session recovered independently.
          refreshConnectedBackgroundNotice()
          return@execute
        }
        if (sessionPhase == "starting") return@execute
        scheduleBackgroundSession(request, persist = false)
      }
    }
  }

  private fun registerBackgroundSignals() {
    val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    if (manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          debugNetworkEvent("network available")
          resumePersistedSessionIfAllowed()
        }
        override fun onLost(network: Network) {
          debugNetworkEvent("network lost")
          pauseForPolicy("Waiting for a network connection.")
        }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
          val request = sessionRequest ?: return
          val input = parseSessionRequest(request) ?: return
          val options = sessionOptions(input)
          val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
          val reason = BackgroundSessionPolicy.pauseReason(
            networkAvailable = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
            networkMetered = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            powerSave = power?.isPowerSaveMode == true,
            deviceIdle = power?.isDeviceIdleMode == true,
            allowMetered = options.optBoolean("allowMetered", false),
            allowPowerSave = options.optBoolean("allowPowerSave", false),
            allowDeviceIdle = options.optBoolean("allowDeviceIdle", false),
          )
          if (reason == null) resumePersistedSessionIfAllowed() else pauseForPolicy(reason)
        }
      }
      runCatching { manager.registerDefaultNetworkCallback(callback); networkCallback = callback }
    }
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        val request = sessionRequest ?: return
        val input = parseSessionRequest(request) ?: return
        val reason = backgroundPauseReason(input)
        if (reason == null) resumePersistedSessionIfAllowed() else pauseForPolicy(reason)
      }
    }
    val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED).apply {
      addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
      addAction(Intent.ACTION_USER_UNLOCKED)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(receiver, filter)
    }
    powerReceiver = receiver
  }

  private fun unregisterBackgroundSignals() {
    val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) networkCallback?.let { runCatching { manager?.unregisterNetworkCallback(it) } }
    networkCallback = null
    powerReceiver?.let { runCatching { unregisterReceiver(it) } }
    powerReceiver = null
  }

  private fun scheduleBackgroundSession(request: String, persist: Boolean): CompletableFuture<JSONObject> {
    val result = CompletableFuture<JSONObject>()
    try {
      val input = parseSessionRequest(request)
        ?: throw IllegalArgumentException("Background session requires a valid connect request.")
      runOnMain { cancelBackgroundGrace("continuous_sync") }
      // A previously active service may have been demoted while the UI was visible.
      // Promote the same service on the next background transition without re-dialing.
      backgroundSyncArmed = true
      uiIsVisible = false
      ensureForeground()
      if (sessionRequest == request && sessionPhase in listOf("starting", "connected")) {
        // Re-promoting a still-connected service must replace the "preparing"
        // notification instead of leaving it stale for the whole session.
        if (sessionPhase == "connected") {
          startFavoriteSyncSchedule()
          replayTransferJobs()
          SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization",
            "Peer session connected; selected sync is ready.")
        }
        result.complete(sessionStatus())
        return result
      }
      val generation = nextSessionGeneration(result)
      result.whenComplete { _, _ ->
        synchronized(this@DocumentRuntimeService) {
          if (pendingSessionStart === result) pendingSessionStart = null
        }
      }
      sessionRequest = request
      sessionError = null
      peerPhase = null
      peerError = null
      ensureForeground()
      sessionPhase = "starting"
      publishSessionStatus()
      worker.execute {
        // A high-priority stop can overtake a queued start. Do not resurrect a
        // stopped session by persisting that obsolete request afterwards.
        if (generation != sessionGeneration || sessionRequest != request) {
          result.complete(sessionStatus())
          return@execute
        }
        try {
          if (persist) backgroundSessions.save(request)
          val reason = backgroundPauseReason(input)
          if (reason != null) {
            if (generation != sessionGeneration) {
              result.complete(sessionStatus())
              return@execute
            }
            sessionPhase = "waiting"
            sessionError = reason
            publishSessionStatus()
            SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", reason)
            result.complete(sessionStatus())
            return@execute
          }
          initialized.whenComplete { initialStatus, initializationError ->
            if (generation != sessionGeneration || sessionRequest != request) {
              result.complete(sessionStatus())
              return@whenComplete
            }
            if (initializationError != null) {
              sessionPhase = "error"
              sessionError = initializationError.message ?: "Document runtime unavailable."
              publishSessionStatus()
              result.completeExceptionally(initializationError)
            } else if (!documentRuntimeCanStartSession(
                terminalStatus ?: initialStatus,
                isolateAvailable = runtimeHost != null,
              )) {
              val retrying = recoveryIsPending()
              sessionPhase = if (retrying) "waiting" else "error"
              sessionError = (terminalStatus ?: initialStatus).summary
              publishSessionStatus()
              if (retrying) result.complete(sessionStatus())
              else result.completeExceptionally(IllegalStateException(sessionError))
            } else {
              evaluateSession(request, generation, result)
            }
          }
        } catch (error: Exception) {
          if (generation != sessionGeneration) {
            result.complete(sessionStatus())
            return@execute
          }
          sessionPhase = "error"
          sessionError = safeSessionError(error)
          publishSessionStatus()
          result.completeExceptionally(error)
        }
      }
    } catch (error: Exception) {
      sessionPhase = "error"
      sessionError = safeSessionError(error)
      result.completeExceptionally(error)
    }
    return result
  }

  private fun evaluateSession(request: String, generation: Long, result: CompletableFuture<JSONObject>) {
    evaluateRuntime("""
      if (!globalThis.syncpeerDocuments) globalThis.syncpeerDocuments = await globalThis.syncpeerDocumentsCore.startDocuments(android);
      if (!globalThis.syncpeerSession) globalThis.syncpeerSession = await globalThis.syncpeerDocumentsCore.startSession(android, globalThis.syncpeerDocuments);
      const value = await globalThis.syncpeerSession.command({
        protocolVersion: ${SESSION_PROTOCOL_VERSION}, ...input,
      });
      return JSON.stringify({result: value === undefined ? null : value});
    """.trimIndent(), request.toByteArray(Charsets.UTF_8),
      releaseWorkerWhilePending = true).whenComplete { value, error ->
      if (generation != sessionGeneration || sessionRequest != request) {
        result.complete(sessionStatus())
        return@whenComplete
      }
      if (error != null) {
        sessionPhase = "error"
        sessionError = safeSessionError(error)
        publishSessionStatus()
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
          Log.w("SyncpeerRuntime", "session connect failed")
        }
        result.completeExceptionally(error)
        SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", sessionError!!)
      } else {
        val reply = JSONObject(value)
        sessionStarted = true
        sessionPhase = reply.optJSONObject("result")?.optString("phase", "connected") ?: "connected"
        sessionError = null
        publishSessionStatus()
        SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", "Peer session connected; selected sync is ready.")
        result.complete(reply)
        replayTransferJobs()
        if (FavoriteSyncOwnership.maySchedule(sessionPhase == "connected", uiIsVisible, backgroundSyncArmed)) {
          startFavoriteSyncSchedule()
          requestFavoriteSync()
        }
      }
    }
  }

  /** Keep slow session RPCs off the shared document worker. The instrumentation
   * probe and production commands use the identical dispatch path. */
  private fun evaluateSessionWork(
    code: String,
    input: ByteArray,
    onDispatched: () -> Unit = {},
    operationName: String = "Command",
  ): CompletableFuture<String> {
    val safeName = operationName.takeIf { it.matches(Regex("[A-Za-z]{1,40}")) } ?: "Command"
    return evaluateRuntime(code, input,
      releaseWorkerWhilePending = true, onDispatched = onDispatched,
      diagnosticOperation = "session${safeName}")
  }

  /** Replays pending intents after reconnect, process recovery or backoff.
   * A live upload may finish while hidden, but new transfers respect opt-out. */
  private fun replayTransferJobs() {
    mainHandler.removeCallbacks(transferRetryRunnable)
    if (sessionPhase != "connected" || destroying ||
      (!uiIsVisible && !backgroundSyncArmed && !foregroundStarted)) return
    if (!transferStagesPruned) {
      runCatching {
        transferStages.pruneOrphans(transferJobs.referencedStages())
        transferStagesPruned = true
      }
    }
    val pending = runCatching { transferJobs.pending() }.getOrElse { return }
    val now = System.currentTimeMillis()
    val next = pending.mapNotNull { job ->
      job.optLong("nextAttemptMs").takeIf { it > now }
    }.minOrNull()
    if (next != null) mainHandler.postDelayed(transferRetryRunnable,
      (next - now).coerceIn(1L, 24 * 60 * 60 * 1000L))
    for (job in pending) {
      if (job.optLong("nextAttemptMs") > now) continue
      val id = job.optString("id")
      if (job.optString("peerId").isBlank()) {
        transferJobs.progress(id, "failed", 0, 0, "other", job.optInt("attempts"))
        continue
      }
      // A different authenticated peer can advertise the same folder ID.
      // Leave this job pending until its original peer reconnects.
      if (verifiedTransferPeerId != null && verifiedTransferPeerId != job.optString("peerId")) continue
      if (!transferJobDispatches.add(id)) continue
      val request = JSONObject(job.toString()).put("protocolVersion", SESSION_PROTOCOL_VERSION)
        .put("operation", "transferJobStart")
      val code = """
        if (!globalThis.syncpeerDocuments)
          globalThis.syncpeerDocuments = await globalThis.syncpeerDocumentsCore.startDocuments(android);
        if (!globalThis.syncpeerSession)
          globalThis.syncpeerSession = await globalThis.syncpeerDocumentsCore.startSession(android, globalThis.syncpeerDocuments);
        const result = await globalThis.syncpeerSession.command(input);
        return JSON.stringify({result});
      """.trimIndent()
      evaluateSessionWork(code, request.toString().toByteArray(Charsets.UTF_8),
        operationName = "TransferJob").whenComplete { _, error ->
        transferJobDispatches.remove(id)
        if (error != null && applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
          Log.w("SyncpeerRuntime", "transfer.job.dispatch.failed")
        }
      }
    }
  }


  /** Favorite synchronization can wait on a remote peer for minutes. It must never
   * monopolize the same single worker used by DocumentsProvider and status RPCs.
   * The existing favoriteSyncPending guard still serializes full sync runs. */
  private fun evaluateFavoriteWork(
    code: String,
    input: ByteArray,
    onDispatched: () -> Unit = {},
  ): CompletableFuture<String> = evaluateRuntime(code, input,
    releaseWorkerWhilePending = true, onDispatched = onDispatched,
    diagnosticOperation = "favoriteSync")

  /** Only counts and fixed stage labels enter the UI diagnostic stream. */
  @Synchronized private fun updateFavoriteSyncProgress(request: JSONObject) {
    val current = favoriteSyncTelemetry ?: return
    if (!favoriteSyncPending.get() || sessionPhase != "connected" ||
      request.optLong("runId", -1) != current.runId) return
    val sequence = request.optInt("sequence", 0)
    if (sequence <= favoriteSyncProgressSequence) return
    val stage = request.optString("stage")
    if (stage !in setOf("index", "storage", "listing", "planning", "processing",
        "download", "upload", "delete", "folder_done", "complete")) return
    fun bounded(name: String) = request.optInt(name, 0).coerceIn(0, 1_000_000)
    favoriteSyncProgressSequence = sequence
    val now = SystemClock.elapsedRealtime()
    favoriteSyncLastProgressAtMs = now
    favoriteSyncTelemetry = current.copy(stage = stage,
      folderOrdinal = bounded("folderOrdinal"), folderCount = bounded("folderCount"),
      itemOrdinal = bounded("itemOrdinal"), itemCount = bounded("itemCount"),
      elapsedMs = now - favoriteSyncStartedAtMs, stalled = false, idleMs = 0,
      transferredBytes = request.optLong("transferredBytes", 0).coerceIn(0L, 9_007_199_254_740_991L),
      totalBytes = request.optLong("totalBytes", 0).coerceIn(0L, 9_007_199_254_740_991L))
    // Keep exported logs useful even for thousands of tiny files.
    if (now - favoriteSyncLastPublishedAtMs >= 2_000L ||
        (stage == "index" && current.stage == "starting")) {
      favoriteSyncLastPublishedAtMs = now
      publishSessionStatus()
    }
  }

  private fun startFavoriteSyncWatchdog(runId: Long) {
    favoriteSyncWatchdog?.let { mainHandler.removeCallbacks(it) }
    val watchdog = object : Runnable {
      override fun run() {
        val current = favoriteSyncTelemetry ?: return
        if (current.runId != runId || !favoriteSyncPending.get() || sessionPhase != "connected") return
        val now = SystemClock.elapsedRealtime()
        val idleMs = now - favoriteSyncLastProgressAtMs
        if (idleMs >= 20_000L) {
          favoriteSyncTelemetry = current.copy(stalled = true,
            elapsedMs = now - favoriteSyncStartedAtMs, idleMs = idleMs)
          publishSessionStatus()
          if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            Log.w("SyncpeerRuntime", "favorite.sync.slow stage=${current.stage} idleMs=$idleMs")
        }
        mainHandler.postDelayed(this, 20_000L)
      }
    }
    favoriteSyncWatchdog = watchdog
    mainHandler.postDelayed(watchdog, 20_000L)
  }

  private fun requestFavoriteSync() {
    if (!FavoriteSyncOwnership.maySchedule(sessionPhase == "connected", uiIsVisible, backgroundSyncArmed) ||
      !favoriteSyncPending.compareAndSet(false, true)) return
    val runId = ++favoriteSyncRunId
    favoriteSyncStartedAtMs = SystemClock.elapsedRealtime()
    favoriteSyncLastProgressAtMs = favoriteSyncStartedAtMs
    favoriteSyncProgressSequence = 0
    favoriteSyncLastPublishedAtMs = favoriteSyncStartedAtMs
    favoriteSyncTelemetry = FavoriteSyncSnapshot(runId, "starting")
    publishSessionStatus()
    startFavoriteSyncWatchdog(runId)
    evaluateFavoriteWork("""
      const value = await globalThis.syncpeerSession.command({
        protocolVersion: ${SESSION_PROTOCOL_VERSION}, operation: "syncFavorites", runId: $runId,
      });
      return JSON.stringify({result: value});
    """.trimIndent(), "{}".toByteArray(Charsets.UTF_8)).whenComplete { value, error ->
      if (runId != favoriteSyncRunId) return@whenComplete
      replayTransferJobs()
      favoriteSyncPending.set(false)
      favoriteSyncWatchdog?.let { mainHandler.removeCallbacks(it) }
      favoriteSyncWatchdog = null
      val results = if (error == null) runCatching {
        JSONObject(value).optJSONObject("result")?.optJSONArray("results")
      }.getOrNull() else null
      val problems = if (results == null) 1 else (0 until results.length()).count { index ->
        results.optJSONObject(index)?.optString("result") in listOf("conflict", "error", "unavailable")
      }
      val waiting = if (results == null) 0 else (0 until results.length()).count { index ->
        results.optJSONObject(index)?.optString("result") == "waiting"
      }
      favoriteSyncTelemetry = (favoriteSyncTelemetry ?: FavoriteSyncSnapshot(runId, "starting")).copy(
        stage = if (results == null) "failed" else "completed",
        resultCount = results?.length() ?: 0, problemCount = problems, waitingCount = waiting,
        elapsedMs = SystemClock.elapsedRealtime() - favoriteSyncStartedAtMs,
        stalled = false, idleMs = 0)
      publishSessionStatus()
      if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
        val data = favoriteSyncTelemetry!!
        Log.w("SyncpeerRuntime", "favorite.sync.result stage=${data.stage} total=${data.resultCount} problems=$problems waiting=$waiting durationMs=${data.elapsedMs}")
      }
      if (problems > 0) SyncpeerSessionNotifications.update(this,
        "Syncpeer background synchronization", "Selected files need attention in Syncpeer.")
    }
  }

  private fun startFavoriteSyncSchedule() {
    if (!FavoriteSyncOwnership.maySchedule(sessionPhase == "connected", uiIsVisible, backgroundSyncArmed)) return
    mainHandler.removeCallbacks(favoriteSyncRunnable)
    mainHandler.post(favoriteSyncRunnable)
  }

  private fun stopFavoriteSyncSchedule() {
    mainHandler.removeCallbacks(favoriteSyncRunnable)
  }

  @Synchronized private fun stopSession(persist: Boolean): CompletableFuture<JSONObject> {
    pendingSessionStop?.takeIf { !it.isDone }?.let { existing ->
      if (persist) worker.executeHighPriority { runCatching { backgroundSessions.clear() } }
      return existing
    }
    runOnMain { cancelBackgroundGrace("explicit_stop") }
    val generation = nextSessionGeneration()
    verifiedTransferPeerId = null
    backgroundSyncArmed = false
    stopFavoriteSyncSchedule()
    sessionRequest = null
    // Keep the last confirmed activity state until transport teardown completes.
    sessionPhase = "stopping"
    sessionError = null
    peerPhase = null
    peerError = null
    publishSessionStatus()
    val result = CompletableFuture<JSONObject>()
    pendingSessionStop = result
    result.whenComplete { _, _ -> synchronized(this@DocumentRuntimeService) {
      if (pendingSessionStop === result) pendingSessionStop = null
    } }
    val stopStartedAtMs = SystemClock.elapsedRealtime()
    try {
      worker.executeHighPriority {
        if (persist) runCatching { backgroundSessions.clear() }
        if (!documentsStarted || runtimeHost == null) {
          finishSessionStop(generation, result)
          return@executeHighPriority
        }
        evaluateRuntime("""
          if (globalThis.syncpeerSession) await globalThis.syncpeerSession.command({
            protocolVersion: ${SESSION_PROTOCOL_VERSION}, operation: "disconnect",
          });
          return JSON.stringify({result: {phase: "idle"}});
        """.trimIndent(), ByteArray(0), SESSION_STOP_TIMEOUT_MS, highPriority = true,
          diagnosticOperation = "sessionStop").whenComplete { _, error ->
          DiagnosticLogJournal.recordNative(applicationContext,
            if (error == null) "native.session.stop.completed" else "native.session.stop.failed",
            if (error == null) "info" else "warning",
            JSONObject().put("durationMs", (SystemClock.elapsedRealtime() - stopStartedAtMs).coerceIn(0L, 120_000L))
              .put("reason", if (error == null) "none" else "shutdown_unconfirmed"))
          if (error != null && applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            Log.w("SyncpeerRuntime", "session stop gave up after ${SESSION_STOP_TIMEOUT_MS}ms")
          }
          finishSessionStop(generation, result, error)
        }
      }
    } catch (error: Exception) {
      result.completeExceptionally(error)
    }
    return result
  }

  /**
   * Settle every stop request. Only the current generation may reset the service state;
   * a superseded stop still completes, but failed teardown must never be
   * reported as idle while the old peer transport may still be alive.
   */
  private fun finishSessionStop(generation: Long, result: CompletableFuture<JSONObject>, error: Throwable? = null) {
    if (generation != sessionGeneration) {
      result.complete(sessionStatus())
      return
    }
    runOnMain {
      if (error != null) {
        sessionPhase = "error"
        sessionError = "Peer shutdown could not be confirmed; a connection may still be active."
        publishSessionStatus()
        SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", sessionError!!)
        result.completeExceptionally(IllegalStateException(sessionError, error))
        // Never reopen a runtime whose old peer transport may still be live.
        // Recovery destroys the isolate and native network handles before the
        // next connect can create another socket for the same identity.
        startRecovery()
        return@runOnMain
      }
      sessionStarted = false
      sessionPhase = "idle"
      peerPhase = null
      peerError = null
      if (documentLeases.isNotEmpty() && !uiIsVisible) {
        keepDocumentForeground()
        DiagnosticLogJournal.recordNative(applicationContext, "native.document.lease.peer_stopped", "info",
          JSONObject().put("count", documentLeases.size))
      } else {
        foregroundStarted = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        SyncpeerSessionNotifications.cancel(this)
      }
      publishSessionStatus()
      result.complete(sessionStatus())
    }
  }

  private fun backgroundGraceActive(): Boolean =
    !uiIsVisible && !backgroundSyncArmed && backgroundGraceUntilElapsedMs > SystemClock.elapsedRealtime()

  private fun cancelBackgroundGrace(reason: String) {
    mainHandler.removeCallbacks(backgroundGraceRunnable)
    if (backgroundGraceUntilElapsedMs == 0L) return
    backgroundGraceUntilElapsedMs = 0L
    DiagnosticLogJournal.recordNative(applicationContext, "native.session.grace.cancelled", "info",
      JSONObject().put("reason", reason))
  }

  private fun beginBackgroundGrace() {
    if (sessionPhase !in setOf("connected", "connecting", "starting", "reconnecting", "waiting") &&
      !sessionStarted) return
    mainHandler.removeCallbacks(backgroundGraceRunnable)
    backgroundGraceUntilElapsedMs = SystemClock.elapsedRealtime() + BACKGROUND_GRACE_MS
    DiagnosticLogJournal.recordNative(applicationContext, "native.session.grace.started", "info",
      JSONObject().put("durationMs", BACKGROUND_GRACE_MS).put("phase", sessionPhase))
    // Promote while the Activity's visibility transition is being delivered.
    // Foreground-service startup can still be denied by Android power policy.
    try { ensureForeground() } catch (error: Exception) {
      DiagnosticLogJournal.recordNative(applicationContext, "native.session.grace.foreground_failed", "warning",
        JSONObject().put("category", error.javaClass.simpleName.take(48)))
    }
    mainHandler.postDelayed(backgroundGraceRunnable, BACKGROUND_GRACE_MS)
  }

  private fun expireBackgroundGrace() {
    if (uiIsVisible || backgroundSyncArmed || backgroundGraceUntilElapsedMs == 0L) return
    val remaining = backgroundGraceUntilElapsedMs - SystemClock.elapsedRealtime()
    if (remaining > 0L) {
      mainHandler.postDelayed(backgroundGraceRunnable, remaining)
      return
    }
    backgroundGraceUntilElapsedMs = 0L
    val pending = runCatching { transferJobs.pending().isNotEmpty() }.getOrDefault(false)
    DiagnosticLogJournal.recordNative(applicationContext, "native.session.grace.expired", "info",
      JSONObject().put("transferActive", pending).put("phase", sessionPhase))
    if (pending) return // Manual transfer remains foreground-owned until completion.
    if (sessionStarted || sessionPhase in setOf("connected", "connecting", "starting", "reconnecting", "waiting")) {
      stopSession(persist = false)
    } else if (foregroundStarted && documentLeases.isEmpty()) {
      foregroundStarted = false
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      SyncpeerSessionNotifications.cancel(this)
      publishSessionStatus()
    }
  }

  private fun keepDocumentForeground() {
    try {
      ensureForeground()
      if (foregroundStarted && sessionPhase == "idle") SyncpeerSessionNotifications.update(this,
        "Syncpeer document access", "Another app is using an open Syncpeer document.")
    } catch (error: Exception) {
      DiagnosticLogJournal.recordNative(applicationContext, "native.document.lease.foreground_failed", "warning",
        JSONObject().put("category", error.javaClass.simpleName.take(48)))
    }
  }

  private fun ensureForeground() {
    if (destroying) return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      mainHandler.post { ensureForeground() }
      return
    }
    if (foregroundStarted) return
    SyncpeerSessionNotifications.ensureChannel(this)
    val notification = SyncpeerSessionNotifications.build(
      this,
      "Syncpeer background synchronization",
      if (sessionPhase == "connected") "Peer session connected; selected sync is ready."
        else "Preparing selected folders…",
      true,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        SyncpeerSessionConstants.NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      startForeground(SyncpeerSessionConstants.NOTIFICATION_ID, notification)
    }
    foregroundStarted = true
    publishSessionStatus()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      SyncpeerSessionConstants.ACTION_START -> {
        val request = intent.getStringExtra(SyncpeerSessionConstants.EXTRA_REQUEST)
        if (!request.isNullOrBlank()) scheduleBackgroundSession(request, persist = true)
      }
      SyncpeerSessionConstants.ACTION_STOP -> {
        stopSession(persist = true).whenComplete { _, _ -> mainHandler.post {
          if (documentLeases.isEmpty()) stopSelf(startId)
        } }
      }
      null -> {
        // START_STICKY restarts arrive without the original Intent.  The
        // request is encrypted by BackgroundSessionStore and only loaded
        // after Android has unlocked the app's Keystore-backed vault.
        resumePersistedSessionIfAllowed()
      }
    }
    return START_STICKY
  }

  override fun onCreate() {
    super.onCreate()
    DiagnosticLogJournal.installCrashHandler(applicationContext)
    registerBackgroundSignals()
    worker.execute {
      try {
        val status = initialize()
        terminalStatus = if (status.phase == "locked") null else status
        initialized.complete(status)
      } catch (error: Exception) {
        DiagnosticLogJournal.recordNative(applicationContext, "native.runtime.initialize_failed", "error")
        closeRuntimeHost()
        initialized.complete(recordRecoveryFailure(error))
      }
    }
  }

  private fun initialize(): DocumentRuntimeStatus {
    val startedAtMs = SystemClock.elapsedRealtime()
    var lastStageAtMs = startedAtMs
    fun stage(name: String) {
      val now = SystemClock.elapsedRealtime()
      val durationMs = now - lastStageAtMs
      if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        Log.w("SyncpeerRuntime", "document.runtime.initialize.$name elapsedMs=${now - startedAtMs}")
      // Every stage entry is a breadcrumb: if the engine never returns,
      // the final recorded stage still identifies where startup got stuck.
      DiagnosticLogJournal.recordNative(applicationContext, "native.runtime.initialize.stage",
        if (durationMs >= 500) "warning" else "info",
        JSONObject().put("stage", name).put("durationMs", durationMs)
          .put("elapsedMs", now - startedAtMs))
      lastStageAtMs = now
    }
    stage("storage_start")
    storage = DocumentRuntimeStorage(applicationContext)
    stage("storage_ready")
    network = SessionNetworkTransport()
    val generation = synchronized(this) { runtimeGeneration += 1; runtimeGeneration }
    val terminated = {
      if (!destroying && synchronized(this) { generation == runtimeGeneration }) {
        // A JavaScriptSandbox isolate/renderer may terminate without any
        // uncaught Java exception or app-process exit notification.
        DiagnosticLogJournal.recordNative(applicationContext,
          "native.runtime.host_terminated", "error",
          JSONObject().put("generation", generation))
        startRecovery()
      }
      Unit
    }
    val code = assets.open("syncpeer-documents.js").bufferedReader().use { it.readText() }
    stage("assets_ready")
    val requiredFeatures = listOf(
      JavaScriptSandbox.JS_FEATURE_PROMISE_RETURN,
      JavaScriptSandbox.JS_FEATURE_MESSAGE_PORTS,
      JavaScriptSandbox.JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER,
      JavaScriptSandbox.JS_FEATURE_ISOLATE_TERMINATION,
      JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE,
    )
    stage("engine_select")
    runtimeHost = if (forceWebViewForTesting || !JavaScriptSandbox.isSupported()) {
      stage("webview_start")
      createWebViewHost(terminated)
    } else {
      stage("sandbox_start")
      val opening = JavaScriptSandbox.createConnectedInstanceAsync(applicationContext)
      val sandbox = try {
        opening.get(15, TimeUnit.SECONDS)
      } catch (error: Exception) {
        // Do not leak an engine that finishes connecting after the timeout.
        opening.addListener({ runCatching { opening.get().close() } }, { it.run() })
        throw error
      }
      val featuresAvailable = requiredFeatures.all(sandbox::isFeatureSupported)
      val webCryptoAvailable = featuresAvailable && sandboxSupportsWebCrypto(sandbox)
      when (selectDocumentRuntime(true, requiredFeatures, webCryptoAvailable, sandbox::isFeatureSupported)) {
        DocumentRuntimeKind.SANDBOX -> SandboxDocumentRuntimeHost.create(
          sandbox, code, storageWorker, networkWorker,
          ::executeStorageRequest, ::executeNetworkRequest, terminated,
        )
        DocumentRuntimeKind.WEB_VIEW -> {
          sandbox.close()
          createWebViewHost(terminated)
        }
      }
    }
    stage("engine_ready")
    documentsStarted = true
    return DocumentRuntimeStatus("locked", "Document access is not configured.")
  }

  private fun createWebViewHost(terminated: () -> Unit): DocumentRuntimeHost {
    val opening = WebViewDocumentRuntimeHost.create(
      applicationContext, mainHandler, storageWorker, networkWorker,
      ::executeStorageRequest, ::executeNetworkRequest, terminated,
    )
    return try {
      opening.get(WEBVIEW_STARTUP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    } catch (error: Exception) {
      if (!opening.completeExceptionally(error)) opening.getNow(null)?.close()
      throw error
    }
  }

  private fun executeStorageRequest(raw: String): String {
    val request = JSONObject(raw)
    val reply = JSONObject().put("id", request.getLong("__portId"))
    try {
      if (request.optString("method") == "documentChanged") {
        contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
        reply.put("result", JSONObject.NULL)
      } else reply.put("result", checkNotNull(storage).execute(request) ?: JSONObject.NULL)
    }
    catch (error: Exception) {
      val method = request.optString("method").takeIf {
        it in setOf("storage", "secret", "random", "root", "counter", "availableBytes")
      } ?: "unknown"
      val operation = if (method == "storage")
        request.optJSONObject("input")?.optString("operation") else request.optString("operation")
      val safeOperation = operation?.takeIf { it.matches(Regex("[A-Za-z]{1,48}")) } ?: "other"
      val category = generateSequence(error as Throwable?) { it.cause }
        .take(3).map { it.javaClass.simpleName }.joinToString(",")
      val failureCategory = (error as? DocumentStorageFailure)?.category
        ?: documentStorageFailureCategory(error)
      DiagnosticLogJournal.recordNative(applicationContext, "native.document.storage_failed",
        "error", JSONObject().put("method", method).put("operation", safeOperation)
          .put("exceptionTypes", category).put("failureCategory", failureCategory))
      if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        Log.w("SyncpeerRuntime", "storage $method/$safeOperation failed: $failureCategory ($category)")
      reply.put("error", privateStorageFailureMessage(error) ?: "Document storage operation failed.")
    }
    return reply.toString()
  }

  private fun executeNetworkRequest(raw: String): String {
    val request = JSONObject(raw)
    val reply = JSONObject().put("id", request.getLong("__portId"))
    if (request.optString("operation") == "sessionPeerStatus") {
      val phase = request.optString("phase")
      val allowed = setOf("idle", "connecting", "starting", "connected", "waiting",
        "reconnecting", "suspended", "stopping", "error")
      if (phase !in allowed) {
        return reply.put("error", "Invalid peer session phase.").toString()
      }
      val nextPhase = if (phase == "connecting") "starting" else phase
      val priorPhase = peerPhase
      val errorReason = request.optString("error")
      if (priorPhase == "connected" && nextPhase != "connected") {
        val category = when {
          errorReason.contains(Regex("not authorized|revoked|not paired|not approved|unknown device|not configured|not in config|access denied|remote peer rejected this device", RegexOption.IGNORE_CASE)) -> "authorization"
          errorReason.contains(Regex("timed? ?out|deadline", RegexOption.IGNORE_CASE)) -> "timeout"
          errorReason.contains(Regex("network|unreachable|refused|socket", RegexOption.IGNORE_CASE)) -> "network"
          errorReason.contains(Regex("disconnected|closed|cancelled|abort", RegexOption.IGNORE_CASE)) -> "closed"
          errorReason.isBlank() -> "none"
          else -> "other"
        }
        DiagnosticLogJournal.recordNative(applicationContext, "native.peer.closed", "warning",
          JSONObject().put("reason", category).put("nextPhase", nextPhase)
            .put("connectedMs", (SystemClock.elapsedRealtime() - peerAuthenticatedAtElapsedMs).coerceIn(0L, 86_400_000L))
            .put("uiVisible", uiIsVisible).put("foregroundService", foregroundStarted)
            .put("backgroundSyncArmed", backgroundSyncArmed).put("graceActive", backgroundGraceActive())
            .put("attempt", request.optInt("attempt").coerceIn(0, 1000)))
      }
      if (nextPhase == "connected" && priorPhase != "connected")
        peerAuthenticatedAtElapsedMs = SystemClock.elapsedRealtime()
      peerPhase = nextPhase
      peerError = errorReason.ifBlank { null }
      if (phase != "connected" && sessionStarted) {
        // Starting/idle also invalidate the previous socket. A newer handshake
        // must not leave native active=true while its overview is unavailable.
        sessionStarted = false
        sessionPhase = if (phase == "idle" || phase == "connecting") "starting" else phase
      }
      if (phase != "connected") verifiedTransferPeerId = null
      if (phase == "connected") {
        // This event comes from the lifecycle-owned, TLS-authenticated socket.
        // Require its peer identity to match the requested UI peer before
        // promoting an earlier pending connect to native connected status.
        val verifiedPeer = request.optString("remoteDeviceId").replace("-", "").uppercase()
        if (verifiedPeer.matches(Regex("[A-Z2-7]{52}|[A-Z2-7]{56}"))) {
          verifiedTransferPeerId = verifiedPeer
          replayTransferJobs()
        }
        val policyRecovered = backgroundSyncArmed && sessionRequest?.let(::parseSessionRequest)
          ?.let { backgroundPauseReason(it) == null } == true
        synchronized(uiConnectLock) {
          if (uiConnectRequest != null && verifiedPeer.isNotBlank() &&
            (uiConnectExpectedPeer == null || verifiedPeer == uiConnectExpectedPeer) &&
            sessionPhase != "stopping" &&
            (sessionError == null || sessionError == "Peer connection could not be established." ||
              policyRecovered)) {
            sessionStarted = true
            sessionPhase = "connected"
            sessionError = null
          }
        }
        if (verifiedPeer.matches(Regex("[A-Z2-7]{52}|[A-Z2-7]{56}"))) {
          refreshConnectedBackgroundNotice()
        }
      }
      publishSessionStatus()
      return reply.put("result", JSONObject.NULL).toString()
    }
    if (request.optString("operation") == "pendingPeer") {
      val id = request.optString("deviceId").uppercase()
      require(id.matches(Regex("[A-Z2-7]{52}"))) { "Invalid pending peer identity." }
      IncomingPeerBus.publish(id)
      return reply.put("result", JSONObject.NULL).toString()
    }
    if (request.optString("operation") == "transferJobProgress") {
      val id = request.optString("id")
      if (!id.matches(Regex("[a-f0-9-]{8,64}", RegexOption.IGNORE_CASE))) {
        return reply.put("error", "Invalid transfer job identity.").toString()
      }
      val updated = transferJobs.progress(id, request.optString("phase"),
        request.optLong("transferredBytes", -1), request.optLong("totalBytes", -1),
        request.optString("reason").ifBlank { null }, request.optInt("attempt", 0))
      if (updated != null) {
        if (updated.optString("phase") in setOf("completed", "failed", "cancelled")) {
          updated.optString("stageId").takeIf { it.isNotBlank() }?.let { transferStages.discard(it) }
        }
        if (updated.optString("phase") in setOf("completed", "failed", "cancelled") &&
          !uiIsVisible && !backgroundSyncArmed &&
          runCatching { transferJobs.pending().isEmpty() }.getOrDefault(false)) {
          mainHandler.post {
            if (!uiIsVisible && !backgroundSyncArmed && !backgroundGraceActive() &&
              runCatching { transferJobs.pending().isEmpty() }.getOrDefault(false)) {
              DiagnosticLogJournal.recordNative(applicationContext, "native.session.transfer.background_complete", "info")
              if (sessionStarted || sessionPhase in setOf("connected", "starting", "reconnecting", "waiting")) {
                stopSession(persist = false)
              } else if (foregroundStarted && documentLeases.isEmpty()) {
                foregroundStarted = false
                ServiceCompat.stopForeground(this@DocumentRuntimeService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                SyncpeerSessionNotifications.cancel(this@DocumentRuntimeService)
                publishSessionStatus()
              }
            }
          }
        }
        if (updated.optString("phase") == "queued") replayTransferJobs()
      }
      return reply.put("result", updated ?: JSONObject.NULL).toString()
    }
    if (request.optString("operation") == "favoriteSyncProgress") {
      updateFavoriteSyncProgress(request)
      return reply.put("result", JSONObject.NULL).toString()
    }
    if (request.optString("operation") == "diagnostic") {
      val event = request.optString("event")
      if (event == "core.transfer.stage") {
        val stage = request.optString("stage").takeIf {
          it in setOf("queue_wait", "local_preflight", "remote_lookup", "draft_open",
            "first_bytes", "progress", "storage_write", "draft_commit", "finished", "failed",
            "blocks_start", "blocks_first", "blocks_progress", "blocks_complete")
        }
        if (stage != null) {
          val details = JSONObject().put("stage", stage)
            .put("durationMs", request.optLong("durationMs", 0).coerceIn(0L, 86_400_000L))
            .put("bytes", request.optLong("bytes", 0).coerceIn(0L, 1_000_000_000_000L))
            .put("totalBytes", request.optLong("totalBytes", 0).coerceIn(0L, 1_000_000_000_000L))
            .put("networkBytes", request.optLong("networkBytes", 0).coerceIn(0L, 1_000_000_000_000L))
            .put("storageMs", request.optLong("storageMs", 0).coerceIn(0L, 86_400_000L))
            .put("requestMs", request.optLong("requestMs", 0).coerceIn(0L, 86_400_000L))
            .put("maxRequestMs", request.optLong("maxRequestMs", 0).coerceIn(0L, 86_400_000L))
            .put("reason", request.optString("reason").takeIf {
              it in setOf("network", "storage", "cancelled", "unavailable", "other")
            } ?: "none")
          DiagnosticLogJournal.recordNative(applicationContext, event,
            if (stage == "failed") "warning" else "info", details)
        }
        return reply.put("result", JSONObject.NULL).toString()
      }
      if (event in setOf("core.bep.handshake.peer_cert", "core.bep.handshake.hello_sent",
          "core.bep.handshake.hello_recv", "core.bep.handshake.ready", "core.bep.handshake.failed")) {
        val stage = request.optString("stage").takeIf {
          it in setOf("peer_certificate", "hello_sent", "hello_received", "ready",
            "hello_exchange", "cluster_config")
        } ?: return reply.put("result", JSONObject.NULL).toString()
        val direction = request.optString("direction").takeIf { it in setOf("incoming", "outgoing") }
          ?: "outgoing"
        val category = request.optString("category").takeIf {
          it in setOf("authorization", "timeout", "unreachable", "relay", "disconnected",
            "tls", "dns", "other", "none")
        } ?: "other"
        DiagnosticLogJournal.recordNative(applicationContext, event,
          if (event.endsWith(".failed")) "warning" else "info",
          JSONObject().put("stage", stage).put("direction", direction)
            .put("category", category).put("durationMs", request.optInt("durationMs").coerceIn(0, 120_000)))
        return reply.put("result", JSONObject.NULL).toString()
      }
      // Only core-owned event names can reach crash-persistent diagnostics.
      // Never store untrusted endpoint strings, remote identifiers or error text.
      val allowed = event.matches(Regex("core\\.session\\.connect\\.[a-z_]{2,40}")) ||
        event in setOf("core.discovery.global_failed", "core.discovery.retry",
          "core.discovery.full_response", "core.discovery.candidate.try",
          "core.discovery.candidate.connected", "core.discovery.candidate.failed",
           "core.discovery.relay.failed", "core.discovery.connect_strategy",
           "core.discovery.candidate.order", "core.upload.request.failed", "core.replica.receive.failed",
           "core.session.shutdown.begin", "core.session.shutdown.lifecycle_done",
           "core.session.shutdown.listener_done")
      if (allowed) {
        val details = JSONObject()
          .put("category", request.optString("category").takeIf {
            it in setOf("authorization", "timeout", "unreachable", "relay", "disconnected",
              "tls", "dns", "other", "none")
          } ?: "other")
          .put("directCount", request.optInt("directCount").coerceIn(0, 1000))
           .put("priorSuccessCount", request.optInt("priorSuccessCount").coerceIn(0, 1000))
           .put("cooldownCount", request.optInt("cooldownCount").coerceIn(0, 1000))
          .put("relayCount", request.optInt("relayCount").coerceIn(0, 1000))
          .put("protocol", request.optString("protocol").takeIf {
            it in setOf("tcp", "quic", "relay", "unknown")
          } ?: "unknown")
          .put("source", request.optString("source").takeIf {
            it in setOf("local", "global", "manual", "unknown")
          } ?: "unknown")
          .put("scope", request.optString("scope").takeIf {
            it in setOf("lan", "wan", "unknown")
          } ?: "unknown")
          .put("addressFamily", request.optString("addressFamily").takeIf {
            it in setOf("ipv4", "ipv6", "dns", "unknown")
          } ?: "unknown")
          .put("candidateOrdinal", request.optInt("candidateOrdinal").coerceIn(0, 1000))
          .put("durationMs", request.optInt("durationMs").coerceIn(0, 120_000))
          .put("timeoutMs", request.optInt("timeoutMs").coerceIn(0, 120_000))
        DiagnosticLogJournal.recordNative(applicationContext, event,
          if (event.endsWith("failed")) "warning" else "info", details)
      }
      return reply.put("result", JSONObject.NULL).toString()
    }
    if (request.optString("operation") == "transferStageRead") {
      try {
        val bytes = transferStages.read(request.getString("stageId"), request.getLong("sizeBytes"),
          request.getLong("offset"), request.getInt("length"))
        return reply.put("result", JSONObject().put("bytes", bytes)).toString()
      } catch (_: Exception) {
        return reply.put("error", "Encrypted upload staging is unavailable.").toString()
      }
    }
    val networkOperation = request.optString("operation")
    val networkStartedAtMs = SystemClock.elapsedRealtime()
    val monitored = networkOperation in setOf("tlsOpen", "quicOpen",
      "relayOpen", "discoveryFetch", "discoverLocal", "tlsListen", "relayListen")
    val pendingWarning = Runnable {
      DiagnosticLogJournal.recordNative(applicationContext, "native.network.operation_pending",
        "warning", JSONObject().put("operation", networkOperation)
          .put("elapsedMs", SystemClock.elapsedRealtime() - networkStartedAtMs))
    }
    if (monitored) mainHandler.postDelayed(pendingWarning, 5000)
    var failed = false
    try { reply.put("result", checkNotNull(network).execute(request) ?: JSONObject.NULL) }
    catch (error: Exception) {
      failed = true
      reply.put("error", error.message ?: "Network operation failed.")
    } finally {
      if (monitored) mainHandler.removeCallbacks(pendingWarning)
      val durationMs = SystemClock.elapsedRealtime() - networkStartedAtMs
      if (durationMs >= 2000 && networkOperation in setOf("tlsOpen", "quicOpen",
          "relayOpen", "discoveryFetch", "discoverLocal", "tlsListen", "relayListen")) {
        DiagnosticLogJournal.recordNative(applicationContext, "native.network.operation_slow",
          "warning", JSONObject().put("operation", networkOperation)
            .put("durationMs", durationMs).put("failed", failed))
      }
    }
    return reply.toString()
  }

  @Synchronized private fun closeRuntimeHost() {
    runtimeGeneration += 1
    val previous = runtimeHost
    runtimeHost = null
    documentsStarted = false
    runCatching { previous?.close() }
  }

  @Synchronized private fun recoveryIsPending(): Boolean = recoveryWillRetry

  @Synchronized private fun failRecoveryIfInjected() {
    if (injectedRecoveryFailures == 0) return
    injectedRecoveryFailures -= 1
    injectedRecoveryAttempts += 1
    throw TimeoutException("Synthetic document runtime startup timeout.")
  }

  @Synchronized private fun cancelPendingRecoveryRetry() {
    pendingRecoveryRetry?.let { mainHandler.removeCallbacks(it) }
    pendingRecoveryRetry = null
    recoveryWillRetry = false
  }

  @Synchronized private fun recordRecoveryFailure(error: Exception): DocumentRuntimeStatus {
    recoveryFailureCount += 1
    val decision = documentRuntimeRecoveryDecision(recoveryFailureCount, error)
    DiagnosticLogJournal.recordNative(applicationContext, "native.runtime.recovery_failed",
      "error", JSONObject().put("attempt", recoveryFailureCount)
        .put("failureType", decision.failureType.toString())
        .put("retryScheduled", decision.retryDelayMs != null && !destroying))
    val privateStorageFailure = privateStorageFailureMessage(error)
    val status = if (privateStorageFailure != null) {
      DocumentRuntimeStatus(
        "error",
        privateStorageFailure,
        failureType = decision.failureType,
      )
    } else if (decision.retryDelayMs == null || destroying) {
      DocumentRuntimeStatus(
        "error",
        "Document runtime could not recover. Reopen Syncpeer to retry.",
        failureType = decision.failureType,
      )
    } else {
      DocumentRuntimeStatus(
        "error",
        "Document runtime is retrying (${recoveryFailureCount} of 5).",
        failureType = decision.failureType,
      )
    }
    terminalStatus = status
    recoveryWillRetry = decision.retryDelayMs != null && !destroying
    sessionStarted = false
    if (sessionRequest != null) {
      sessionPhase = if (decision.retryDelayMs == null || destroying) "error" else "waiting"
      sessionError = status.summary
    }
    publishSessionStatus()
    if (decision.retryDelayMs != null && !destroying) {
      lateinit var retry: Runnable
      retry = Runnable {
        synchronized(this@DocumentRuntimeService) {
          if (destroying || pendingRecoveryRetry !== retry) return@Runnable
          pendingRecoveryRetry = null
        }
        startRecovery()
      }
      pendingRecoveryRetry = retry
      mainHandler.postDelayed(retry, decision.retryDelayMs)
    }
    contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
    return status
  }

  @Synchronized private fun startRecovery(): CompletableFuture<DocumentRuntimeStatus> {
    recovery?.let { return it }
    pendingRecoveryRetry?.let {
      return CompletableFuture.completedFuture(checkNotNull(terminalStatus))
    }
    val task = CompletableFuture<DocumentRuntimeStatus>()
    DiagnosticLogJournal.recordNative(applicationContext, "native.runtime.recovery_started",
      "warning", JSONObject().put("attempt", recoveryFailureCount + 1))
    recovery = task
    recoveryWillRetry = true
    terminalStatus = DocumentRuntimeStatus("error", "Document runtime is restarting.")
    nextSessionGeneration()
    sessionStarted = false
    sessionPhase = if (sessionRequest == null) "idle" else "waiting"
    sessionError = if (sessionRequest == null) null else terminalStatus?.summary
    publishSessionStatus()
    closeRuntimeHost()
    contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
    try {
      worker.execute {
        try {
          failRecoveryIfInjected()
          storageWorker.submit { storage?.close(); storage = null }.get(15, TimeUnit.SECONDS)
          networkWorker.submit { network?.close(); network = null }.get(15, TimeUnit.SECONDS)
          val status = initialize()
          synchronized(this@DocumentRuntimeService) {
            terminalStatus = if (status.phase == "locked") null else status
            recoveryFailureCount = 0
            cancelPendingRecoveryRetry()
          }
          vaultSummary = null
          task.complete(status)
          if (status.phase == "locked") sessionRequest?.let { request ->
            sessionPhase = "starting"
            publishSessionStatus()
            evaluateSession(request, sessionGeneration, CompletableFuture())
          } else if (sessionRequest != null) {
            sessionPhase = "error"
            sessionError = status.summary
            publishSessionStatus()
          }
        } catch (error: Exception) {
          closeRuntimeHost()
          task.complete(recordRecoveryFailure(error))
        } finally {
          recovery = null
          contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
        }
      }
    } catch (error: Exception) {
      recovery = null
      task.complete(recordRecoveryFailure(error))
    }
    return task
  }

  override fun onBind(intent: Intent): IBinder = binder

  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    // Record only bounded numeric process metrics, never document identifiers.
    val memory = Runtime.getRuntime()
    DiagnosticLogJournal.recordNative(applicationContext, "native.runtime.memory_pressure", "warning",
      JSONObject().put("level", level).put("heapUsedBytes", memory.totalMemory() - memory.freeMemory())
        .put("heapMaxBytes", memory.maxMemory()).put("nativeAllocatedBytes", android.os.Debug.getNativeHeapAllocatedSize())
        .put("sessionPhase", sessionPhase).put("uiVisible", uiIsVisible))
  }

  override fun onDestroy() {
    destroying = true
    mainHandler.removeCallbacks(backgroundGraceRunnable)
    cancelPendingRecoveryRetry()
    stopFavoriteSyncSchedule()
    unregisterBackgroundSignals()
    sessionStarted = false
    sessionPhase = "idle"
    peerPhase = null
    peerError = null
    foregroundStarted = false
    mainHandler.removeCallbacks(transferRetryRunnable)
    favoriteSyncWatchdog?.let { mainHandler.removeCallbacks(it) }
    // Atomically replace queued work with teardown; never discard cleanup or
    // block Android's main thread waiting for the runtime to finish.
    // The status journal and observer notifications are also off the main thread.
    worker.shutdownWithCleanup {
      publishSessionStatus()
      runCatching {
        runtimeHost?.evaluate("if (globalThis.syncpeerDocuments) await globalThis.syncpeerDocuments.close(); return 'closed';", ByteArray(0))
          ?.get(15, TimeUnit.SECONDS)
      }
      // Release callers whose evaluations were discarded during teardown.
      pendingEvaluations.forEach { (future, bytes) ->
        future.completeExceptionally(IllegalStateException("Document runtime closed."))
        bytes.fill(0)
      }
      closeRuntimeHost()
      storageWorker.execute { storage?.close(); storage = null }
      // Don't queue close behind blocking network reads. Native disposal closes
      // the sockets even while read requests retain a reference to the transport.
      runCatching { network?.close() }
      network = null
      networkWorker.shutdown()
      completionWorker.shutdown()
      storageWorker.shutdown()
    }
    super.onDestroy()
  }

  private companion object {
    const val SESSION_PROTOCOL_VERSION = 1
    // Cold renderer startup on older Android can legitimately exceed 15s.
    // Avoid repeatedly destroying an engine just before its ready handshake.
    const val WEBVIEW_STARTUP_TIMEOUT_SECONDS = 30L
    const val BACKGROUND_GRACE_MS = 90_000L
    const val FAVORITE_SYNC_INTERVAL_MS = 15_000L
    /** A session teardown may not hold the shared document worker behind a dead network. */
    const val SESSION_STOP_TIMEOUT_MS = 10_000L
    /** Give a superseded connect a bounded moment to settle before reconnecting. */
    const val UI_CONNECT_SETTLE_MS = 2_000L
  }
}
