package dev.syncpeer.plugin.android

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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
import androidx.annotation.RequiresApi
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.Message
import androidx.javascriptengine.MessagePort
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
  private val networkWorker = Executors.newSingleThreadExecutor()
  private var storage: DocumentRuntimeStorage? = null
  private var storagePort: MessagePort? = null
  private var network: SessionNetworkTransport? = null
  private var networkPort: MessagePort? = null
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
  private var sandbox: JavaScriptSandbox? = null
  private var isolate: JavaScriptIsolate? = null
  private var requestId = 0L
  @Volatile private var terminalStatus: DocumentRuntimeStatus? = null
  @Volatile private var vaultSummary: String? = null
  @Volatile private var recovery: CompletableFuture<DocumentRuntimeStatus>? = null
  @Volatile private var destroying = false

  inner class RuntimeBinder : Binder() {
    fun status(): CompletableFuture<DocumentRuntimeStatus> = initialized.thenCompose { initial ->
      recovery?.thenApply { it.copy(summary = vaultSummary ?: it.summary) }
        ?: CompletableFuture.completedFuture(terminalStatus ?: initial.copy(summary = vaultSummary ?: initial.summary))
    }

    internal fun restartForTesting(): CompletableFuture<DocumentRuntimeStatus> = startRecovery()

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
        if (input.optString("operation") == "release") requestFavoriteSync()
        reply
      }
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
    val data = input.copyOf()
    val result = CompletableFuture<String>()
    val task = Runnable {
      try {
        if (result.isCancelled) return@Runnable
        check(terminalStatus == null && isolate != null) { "Document runtime unavailable." }
        val engine = checkNotNull(isolate)
        if (!documentsStarted) {
          storage = DocumentRuntimeStorage(applicationContext)
          storagePort = engine.createMessageChannel("storage", storageWorker) { message ->
            val request = JSONObject(message.string)
            val reply = JSONObject().put("id", request.getLong("id"))
            try { reply.put("result", storage!!.execute(request) ?: JSONObject.NULL) }
            catch (_: Exception) { reply.put("error", "Document storage operation failed.") }
            storagePort?.postMessage(Message.createStringMessage(reply.toString()))
          }
          network = SessionNetworkTransport()
          networkPort = engine.createMessageChannel("network", networkWorker) { message ->
            val request = JSONObject(message.string)
            val reply = JSONObject().put("id", request.getLong("id"))
            try { reply.put("result", network!!.execute(request) ?: JSONObject.NULL) }
            catch (error: Exception) { reply.put("error", error.message ?: "Network operation failed.") }
            networkPort?.postMessage(Message.createStringMessage(reply.toString()))
          }
          documentsStarted = true
        }
        val name = "request-${++requestId}"
        engine.provideNamedData(name, data)
        // The interpolated name is generated here; code is a trusted call site.
        val script = "android.consumeNamedDataAsArrayBuffer('$name').then(bytes => {" +
          "const parsed = JSON.parse(new TextDecoder().decode(bytes)); new Uint8Array(bytes).fill(0);" +
          "return (async input => { $code\n})(parsed); })"
        // Trusted core publication is bounded by file size, not a fixed startup deadline.
        // Killing the isolate after 15 seconds made large-file fsync impossible.
        result.complete(engine.evaluateJavaScriptAsync(script).get())
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
    val wasStarted = sessionStarted && documentsStarted && isolate != null
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
          initialized.whenComplete { _, initializationError ->
            if (generation != sessionGeneration || sessionRequest != request) return@whenComplete
            if (initializationError != null) {
              sessionPhase = "error"
              sessionError = initializationError.message ?: "Document runtime unavailable."
              result.completeExceptionally(initializationError)
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
            results.getJSONObject(index).getString("result") !in listOf("downloaded", "uploaded", "unchanged")
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
        if (!documentsStarted || isolate == null) {
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
        initialized.complete(initialize())
      } catch (error: Exception) {
        isolate?.close()
        isolate = null
        sandbox?.close()
        sandbox = null
        initialized.complete(DocumentRuntimeStatus("error", "Document runtime is recovering.",
          failureType = (error.cause ?: error).javaClass.simpleName))
        startRecovery()
      }
    }
  }

  private fun initialize(): DocumentRuntimeStatus {
    documentRuntimeCompatibility(
      JavaScriptSandbox.isSupported(),
      emptyList(),
    ) { false }?.let { return it }
    val opening = JavaScriptSandbox.createConnectedInstanceAsync(applicationContext)
    val engine = try {
      opening.get(15, TimeUnit.SECONDS)
    } catch (error: Exception) {
      // Do not leak an engine that finishes connecting after the timeout.
      opening.addListener({ runCatching { opening.get().close() } }, { it.run() })
      throw error
    }
    sandbox = engine
    val requiredFeatures = listOf(
      JavaScriptSandbox.JS_FEATURE_PROMISE_RETURN,
      JavaScriptSandbox.JS_FEATURE_MESSAGE_PORTS,
      JavaScriptSandbox.JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER,
      JavaScriptSandbox.JS_FEATURE_ISOLATE_TERMINATION,
      JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE,
    )
    val incompatible = documentRuntimeCompatibility(
      true,
      requiredFeatures,
      engine::isFeatureSupported,
    )
    if (incompatible != null) {
      engine.close()
      sandbox = null
      return incompatible
    }
    loadCore(engine)
    return DocumentRuntimeStatus("locked", "Document access is not configured.")
  }

  private fun loadCore(engine: JavaScriptSandbox) {
    val startup = IsolateStartupParameters().apply {
      setMaxHeapSizeBytes(128L * 1024 * 1024)
      setMaxEvaluationReturnSizeBytes(1024 * 1024)
    }
    val runtime = engine.createIsolate(startup)
    isolate = runtime
    runtime.addOnTerminatedCallback({ it.run() }) { if (!destroying && isolate === runtime) startRecovery() }
    val code = assets.open("syncpeer-documents.js").bufferedReader().use { it.readText() }
    check(runtime.evaluateJavaScriptAsync(code).get(15, TimeUnit.SECONDS) == "ready")
  }

  @Synchronized private fun startRecovery(): CompletableFuture<DocumentRuntimeStatus> {
    recovery?.let { return it }
    val task = CompletableFuture<DocumentRuntimeStatus>()
    recovery = task
    terminalStatus = DocumentRuntimeStatus("error", "Document runtime is restarting.")
    nextSessionGeneration()
    sessionStarted = false
    sessionPhase = if (sessionRequest == null) "idle" else "starting"
    sessionError = null
    val previous = isolate
    isolate = null
    runCatching { previous?.close() }
    contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
    try {
      worker.execute {
        try {
          documentsStarted = false
          storagePort = null
          networkPort = null
          storageWorker.submit { storage?.close(); storage = null }.get(15, TimeUnit.SECONDS)
          networkWorker.submit { network?.close(); network = null }.get(15, TimeUnit.SECONDS)
          val status = if (sandbox == null) initialize() else {
            loadCore(checkNotNull(sandbox))
            DocumentRuntimeStatus("locked", "Document access is not configured.")
          }
          terminalStatus = if (status.phase == "locked") null else status
          vaultSummary = null
          task.complete(status)
          if (status.phase == "locked") sessionRequest?.let { request ->
            sessionPhase = "starting"
            evaluateSession(request, sessionGeneration, CompletableFuture())
          }
        } catch (error: Exception) {
          val failed = isolate
          isolate = null
          runCatching { failed?.close() }
          val status = DocumentRuntimeStatus("error", "Document runtime could not recover. Reopen Syncpeer to retry.",
            failureType = (error.cause ?: error).javaClass.simpleName)
          terminalStatus = status
          task.complete(status)
        } finally {
          recovery = null
          contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
        }
      }
    } catch (error: Exception) {
      recovery = null
      task.completeExceptionally(error)
    }
    return task
  }

  override fun onBind(intent: Intent): IBinder = binder

  override fun onDestroy() {
    destroying = true
    stopFavoriteSyncSchedule()
    unregisterBackgroundSignals()
    // Serialize teardown after initialization; shutdown drains the already queued work.
    worker.execute {
      runCatching {
        isolate?.evaluateJavaScriptAsync("(async () => { await globalThis.syncpeerDocuments?.close(); return 'closed'; })()")
          ?.get(15, TimeUnit.SECONDS)
      }
      isolate?.close()
      isolate = null
      sandbox?.close()
      sandbox = null
      storageWorker.execute { storage?.close(); storage = null }
      networkWorker.execute { network?.close(); network = null }
      storagePort = null
      networkPort = null
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
