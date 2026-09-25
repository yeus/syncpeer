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
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.javascriptengine.JavaScriptSandbox
import org.json.JSONObject
import android.provider.DocumentsContract
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
  private val worker = Executors.newSingleThreadExecutor()
  private val storageWorker = Executors.newSingleThreadExecutor()
  // A BEP session keeps one blocking read active while writes and closes must
  // continue independently through the same native transport.
  private val networkWorker = Executors.newFixedThreadPool(4)
  private var storage: DocumentRuntimeStorage? = null
  private var network: SessionNetworkTransport? = null
  private var documentsStarted = false
  @Volatile private var sessionStarted = false
  @Volatile private var sessionRequest: String? = null
  @Volatile private var sessionGeneration = 0L
  @Volatile private var sessionPhase = "idle"
  @Volatile private var sessionError: String? = null
  @Volatile private var foregroundStarted = false
  private val backgroundSessions by lazy { BackgroundSessionStore(applicationContext) }
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var powerReceiver: BroadcastReceiver? = null
  private val initialized = CompletableFuture<DocumentRuntimeStatus>()
  private val favoriteSyncPending = AtomicBoolean(false)
  private val favoriteSyncRunnable = object : Runnable {
    override fun run() {
      if (sessionPhase != "connected") return
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

    fun command(input: JSONObject): CompletableFuture<JSONObject> {
      return evaluate("""
        if (!globalThis.syncpeerDocuments) globalThis.syncpeerDocuments = await globalThis.syncpeerDocumentsCore.startDocuments(android);
        const result = await globalThis.syncpeerDocuments.command(input);
        return JSON.stringify({result: result === undefined ? null : result});
      """.trimIndent(), input.toString().toByteArray(Charsets.UTF_8)).thenApply { value ->
        val reply = JSONObject(value)
        val state = reply.optJSONObject("result")?.optJSONObject("vault")
        if (state != null) vaultSummary = when (state.getString("phase")) {
          "unlocked" -> "Downloaded files available offline."
          "locked" -> "Open Syncpeer to unlock folder storage."
          else -> "Preparing folder storage."
        }
        if (input.optString("operation") in listOf("rememberFolder", "register", "createVault", "unlock", "lock", "create", "rename", "flush", "release", "finishDownload", "remove", "attachDownloads")) {
          contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
        }
        if (input.optString("operation") in listOf("release", "remove", "rename", "saveProfileSettings", "recordFavoriteResolution", "clearFavoriteSyncEntry")) requestFavoriteSync()
        reply
      }
    }

    fun sessionCommand(input: JSONObject): CompletableFuture<JSONObject> {
      return evaluate("""
        if (!globalThis.syncpeerDocuments) globalThis.syncpeerDocuments = await globalThis.syncpeerDocumentsCore.startDocuments(android);
        if (!globalThis.syncpeerSession) globalThis.syncpeerSession = await globalThis.syncpeerDocumentsCore.startSession(android, globalThis.syncpeerDocuments);
        const result = await globalThis.syncpeerSession.command(input);
        return JSON.stringify({result: result === undefined ? null : result});
      """.trimIndent(), input.toString().toByteArray(Charsets.UTF_8)).thenApply { JSONObject(it) }
    }

    internal fun startBackgroundSession(input: JSONObject): CompletableFuture<JSONObject> {
      return scheduleBackgroundSession(input.toString(), persist = true)
    }

    internal fun stopBackgroundSession(): CompletableFuture<JSONObject> {
      val result = stopSession(persist = true)
      result.whenComplete { _, _ -> mainHandler.post { stopSelf() } }
      return result
    }

    /** Trusted packaged code only. Application data travels through named bytes. */
    internal fun evaluate(code: String, input: ByteArray): CompletableFuture<String> {
      return evaluateRuntime(code, input)
    }
  }

  private fun evaluateRuntime(code: String, input: ByteArray): CompletableFuture<String> {
    require(input.size <= 1024 * 1024) { "Document runtime input is too large." }
    val data = (if (input.isEmpty()) "{}".toByteArray(Charsets.UTF_8) else input).copyOf()
    val result = CompletableFuture<String>()
    val task = Runnable {
      try {
        if (result.isCancelled) return@Runnable
        check(terminalStatus == null && runtimeHost != null) { "Document runtime unavailable." }
        // Trusted core publication is bounded by file size, not a fixed startup deadline.
        // Killing the runtime after 15 seconds made large-file fsync impossible.
        result.complete(checkNotNull(runtimeHost).evaluate(code, data).get())
      } catch (error: Exception) {
        if (error is TimeoutException) startRecovery()
        result.completeExceptionally(error)
      } finally { data.fill(0) }
    }
    try { worker.execute(task) } catch (error: Exception) {
      data.fill(0)
      result.completeExceptionally(error)
    }
    return result
  }

  @Synchronized
  private fun nextSessionGeneration(): Long {
    sessionGeneration += 1
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
      allowMetered = options.optBoolean("allowMetered", false),
      allowPowerSave = options.optBoolean("allowPowerSave", false),
    )
  }

  private fun pauseForPolicy(reason: String) {
    if (sessionPhase == "waiting" && sessionError == reason) return
    val request = sessionRequest
    if (request == null) return
    val generation = nextSessionGeneration()
    val wasStarted = sessionStarted && documentsStarted && runtimeHost != null
    sessionStarted = false
    sessionPhase = "waiting"
    sessionError = reason
    runOnMain {
      if (generation == sessionGeneration) {
        SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", reason)
      }
    }
    if (wasStarted) {
      evaluateRuntime("""
        if (globalThis.syncpeerSession) await globalThis.syncpeerSession.command({operation: "disconnect"});
        return JSON.stringify({result: {phase: "idle"}});
      """.trimIndent(), ByteArray(0))
    }
  }

  private fun resumePersistedSessionIfAllowed() {
    runCatching {
      worker.execute {
        val request = sessionRequest ?: runCatching { backgroundSessions.load() }.getOrNull() ?: return@execute
        val input = parseSessionRequest(request) ?: return@execute
        if (backgroundPauseReason(input) != null) return@execute
        if (sessionPhase == "connected" || sessionPhase == "starting") return@execute
        scheduleBackgroundSession(request, persist = false)
      }
    }
  }

  private fun registerBackgroundSignals() {
    val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    if (manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = resumePersistedSessionIfAllowed()
        override fun onLost(network: Network) { pauseForPolicy("Waiting for a network connection.") }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
          val request = sessionRequest ?: return
          val input = parseSessionRequest(request) ?: return
          val options = sessionOptions(input)
          val reason = BackgroundSessionPolicy.pauseReason(
            networkAvailable = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
            networkMetered = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            powerSave = (getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isPowerSaveMode == true,
            allowMetered = options.optBoolean("allowMetered", false),
            allowPowerSave = options.optBoolean("allowPowerSave", false),
          )
          if (reason == null) resumePersistedSessionIfAllowed() else pauseForPolicy(reason)
        }
      }
      runCatching { manager.registerDefaultNetworkCallback(callback); networkCallback = callback }
    }
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) = resumePersistedSessionIfAllowed()
    }
    val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED).apply {
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
      if (sessionRequest == request && sessionPhase in listOf("starting", "connected")) {
        result.complete(sessionStatus())
        return result
      }
      val generation = nextSessionGeneration()
      sessionRequest = request
      sessionError = null
      ensureForeground()
      sessionPhase = "starting"
      worker.execute {
        try {
          if (persist) backgroundSessions.save(request)
          val reason = backgroundPauseReason(input)
          if (reason != null) {
            if (generation != sessionGeneration) return@execute
            sessionPhase = "waiting"
            sessionError = reason
            SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", reason)
            result.complete(sessionStatus())
            return@execute
          }
          initialized.whenComplete { initialStatus, initializationError ->
            if (generation != sessionGeneration || sessionRequest != request) return@whenComplete
            if (initializationError != null) {
              sessionPhase = "error"
              sessionError = initializationError.message ?: "Document runtime unavailable."
              result.completeExceptionally(initializationError)
            } else if (!documentRuntimeCanStartSession(
                terminalStatus ?: initialStatus,
                isolateAvailable = runtimeHost != null,
              )) {
              val retrying = recoveryIsPending()
              sessionPhase = if (retrying) "waiting" else "error"
              sessionError = (terminalStatus ?: initialStatus).summary
              if (retrying) result.complete(sessionStatus())
              else result.completeExceptionally(IllegalStateException(sessionError))
            } else {
              evaluateSession(request, generation, result)
            }
          }
        } catch (error: Exception) {
          if (generation != sessionGeneration) return@execute
          sessionPhase = "error"
          sessionError = error.message ?: "Background session could not start."
          result.completeExceptionally(error)
        }
      }
    } catch (error: Exception) {
      sessionPhase = "error"
      sessionError = error.message ?: "Background session could not start."
      result.completeExceptionally(error)
    }
    return result
  }

  private fun evaluateSession(request: String, generation: Long, result: CompletableFuture<JSONObject>) {
    evaluateRuntime("""
      if (!globalThis.syncpeerDocuments) globalThis.syncpeerDocuments = await globalThis.syncpeerDocumentsCore.startDocuments(android);
      if (!globalThis.syncpeerSession) globalThis.syncpeerSession = await globalThis.syncpeerDocumentsCore.startSession(android, globalThis.syncpeerDocuments);
      const value = await globalThis.syncpeerSession.command(input);
      return JSON.stringify({result: value === undefined ? null : value});
    """.trimIndent(), request.toByteArray(Charsets.UTF_8)).whenComplete { value, error ->
      if (generation != sessionGeneration || sessionRequest != request) return@whenComplete
      if (error != null) {
        sessionPhase = "error"
        sessionError = error.message ?: "Background session could not connect."
        result.completeExceptionally(error)
        SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", sessionError!!)
      } else {
        val reply = JSONObject(value)
        sessionStarted = true
        sessionPhase = reply.optJSONObject("result")?.optString("phase", "connected") ?: "connected"
        sessionError = null
        SyncpeerSessionNotifications.update(this, "Syncpeer background synchronization", "Peer session connected; selected sync is ready.")
        result.complete(reply)
        startFavoriteSyncSchedule()
        requestFavoriteSync()
      }
    }
  }

  private fun requestFavoriteSync() {
    if (sessionPhase != "connected" || !favoriteSyncPending.compareAndSet(false, true)) return
    evaluateRuntime("""
      const value = await globalThis.syncpeerSession.command({operation: "syncFavorites"});
      return JSON.stringify({result: value});
    """.trimIndent(), "{}".toByteArray(Charsets.UTF_8)).whenComplete { value, error ->
      favoriteSyncPending.set(false)
      val failures = if (error == null) runCatching {
        JSONObject(value).getJSONObject("result").getJSONArray("results")
          .let { results -> (0 until results.length()).count { index ->
            results.getJSONObject(index).getString("result") in listOf("conflict", "error", "unavailable")
          } }
      }.getOrDefault(1) else 1
      if (failures > 0) SyncpeerSessionNotifications.update(this,
        "Syncpeer background synchronization", "Selected files need attention in Syncpeer.")
    }
  }

  private fun startFavoriteSyncSchedule() {
    mainHandler.removeCallbacks(favoriteSyncRunnable)
    mainHandler.post(favoriteSyncRunnable)
  }

  private fun stopFavoriteSyncSchedule() {
    mainHandler.removeCallbacks(favoriteSyncRunnable)
  }

  private fun stopSession(persist: Boolean): CompletableFuture<JSONObject> {
    val generation = nextSessionGeneration()
    stopFavoriteSyncSchedule()
    sessionRequest = null
    sessionStarted = false
    sessionPhase = "stopping"
    sessionError = null
    val result = CompletableFuture<JSONObject>()
    try {
      worker.execute {
        if (persist) runCatching { backgroundSessions.clear() }
        if (!documentsStarted || runtimeHost == null) {
          finishSessionStop(result)
          return@execute
        }
        evaluateRuntime("""
          if (globalThis.syncpeerSession) await globalThis.syncpeerSession.command({operation: "disconnect"});
          return JSON.stringify({result: {phase: "idle"}});
        """.trimIndent(), ByteArray(0)).whenComplete { _, _ ->
          if (generation == sessionGeneration) finishSessionStop(result)
        }
      }
    } catch (error: Exception) {
      result.completeExceptionally(error)
    }
    return result
  }

  private fun finishSessionStop(result: CompletableFuture<JSONObject>) {
    runOnMain {
      sessionStarted = false
      sessionPhase = "idle"
      foregroundStarted = false
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      SyncpeerSessionNotifications.cancel(this)
      result.complete(sessionStatus())
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
      "Preparing selected folders…",
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
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      SyncpeerSessionConstants.ACTION_START -> {
        val request = intent.getStringExtra(SyncpeerSessionConstants.EXTRA_REQUEST)
        if (!request.isNullOrBlank()) scheduleBackgroundSession(request, persist = true)
      }
      SyncpeerSessionConstants.ACTION_STOP -> {
        stopSession(persist = true).whenComplete { _, _ -> mainHandler.post { stopSelf(startId) } }
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
    registerBackgroundSignals()
    worker.execute {
      try {
        val status = initialize()
        terminalStatus = if (status.phase == "locked") null else status
        initialized.complete(status)
      } catch (error: Exception) {
        closeRuntimeHost()
        initialized.complete(recordRecoveryFailure(error))
      }
    }
  }

  private fun initialize(): DocumentRuntimeStatus {
    storage = DocumentRuntimeStorage(applicationContext)
    network = SessionNetworkTransport()
    val generation = synchronized(this) { runtimeGeneration += 1; runtimeGeneration }
    val terminated = {
      if (!destroying && synchronized(this) { generation == runtimeGeneration }) startRecovery()
      Unit
    }
    val code = assets.open("syncpeer-documents.js").bufferedReader().use { it.readText() }
    val requiredFeatures = listOf(
      JavaScriptSandbox.JS_FEATURE_PROMISE_RETURN,
      JavaScriptSandbox.JS_FEATURE_MESSAGE_PORTS,
      JavaScriptSandbox.JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER,
      JavaScriptSandbox.JS_FEATURE_ISOLATE_TERMINATION,
      JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE,
    )
    runtimeHost = if (forceWebViewForTesting || !JavaScriptSandbox.isSupported()) {
      createWebViewHost(terminated)
    } else {
      val opening = JavaScriptSandbox.createConnectedInstanceAsync(applicationContext)
      val sandbox = try {
        opening.get(15, TimeUnit.SECONDS)
      } catch (error: Exception) {
        // Do not leak an engine that finishes connecting after the timeout.
        opening.addListener({ runCatching { opening.get().close() } }, { it.run() })
        throw error
      }
      when (selectDocumentRuntime(true, requiredFeatures, sandbox::isFeatureSupported)) {
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
    documentsStarted = true
    return DocumentRuntimeStatus("locked", "Document access is not configured.")
  }

  private fun createWebViewHost(terminated: () -> Unit): DocumentRuntimeHost {
    val opening = WebViewDocumentRuntimeHost.create(
      applicationContext, mainHandler, storageWorker, networkWorker,
      ::executeStorageRequest, ::executeNetworkRequest, terminated,
    )
    return try {
      opening.get(15, TimeUnit.SECONDS)
    } catch (error: Exception) {
      if (!opening.completeExceptionally(error)) opening.getNow(null)?.close()
      throw error
    }
  }

  private fun executeStorageRequest(raw: String): String {
    val request = JSONObject(raw)
    val reply = JSONObject().put("id", request.getLong("id"))
    try { reply.put("result", checkNotNull(storage).execute(request) ?: JSONObject.NULL) }
    catch (_: Exception) { reply.put("error", "Document storage operation failed.") }
    return reply.toString()
  }

  private fun executeNetworkRequest(raw: String): String {
    val request = JSONObject(raw)
    val reply = JSONObject().put("id", request.getLong("id"))
    if (request.optString("operation") == "diagnostic") {
      if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
        Log.w("SyncpeerRuntime", "${request.optString("event")}: ${request.optString("message")}")
      }
      return reply.put("result", JSONObject.NULL).toString()
    }
    try { reply.put("result", checkNotNull(network).execute(request) ?: JSONObject.NULL) }
    catch (error: Exception) { reply.put("error", error.message ?: "Network operation failed.") }
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
    recovery = task
    recoveryWillRetry = true
    terminalStatus = DocumentRuntimeStatus("error", "Document runtime is restarting.")
    nextSessionGeneration()
    sessionStarted = false
    sessionPhase = if (sessionRequest == null) "idle" else "waiting"
    sessionError = if (sessionRequest == null) null else terminalStatus?.summary
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
            evaluateSession(request, sessionGeneration, CompletableFuture())
          } else if (sessionRequest != null) {
            sessionPhase = "error"
            sessionError = status.summary
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

  override fun onDestroy() {
    destroying = true
    cancelPendingRecoveryRetry()
    stopFavoriteSyncSchedule()
    unregisterBackgroundSignals()
    // Serialize teardown after initialization; shutdown drains the already queued work.
    worker.execute {
      runCatching {
        runtimeHost?.evaluate("await globalThis.syncpeerDocuments?.close(); return 'closed';", ByteArray(0))
          ?.get(15, TimeUnit.SECONDS)
      }
      closeRuntimeHost()
      storageWorker.execute { storage?.close(); storage = null }
      networkWorker.execute { network?.close(); network = null }
      networkWorker.shutdown()
      storageWorker.shutdown()
    }
    worker.shutdown()
    super.onDestroy()
  }

  private companion object {
    const val FAVORITE_SYNC_INTERVAL_MS = 15_000L
  }
}
