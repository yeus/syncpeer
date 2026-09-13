package dev.syncpeer.plugin.android

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
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

data class DocumentRuntimeStatus(
  val phase: String,
  val summary: String,
  val missingFeatures: List<String> = emptyList(),
  val failureType: String? = null,
)

/** One engine owner shared by bound application clients, independent of Activities. */
@RequiresApi(26)
class DocumentRuntimeService : Service() {
  private val worker = Executors.newSingleThreadExecutor()
  private val storageWorker = Executors.newSingleThreadExecutor()
  private var storage: DocumentRuntimeStorage? = null
  private var storagePort: MessagePort? = null
  private var documentsStarted = false
  private val initialized = CompletableFuture<DocumentRuntimeStatus>()
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
        reply
      }
    }

    /** Trusted packaged code only. Application data travels through named bytes. */
    internal fun evaluate(code: String, input: ByteArray): CompletableFuture<String> {
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
          if (error is TimeoutException) {
            startRecovery()
          }
          result.completeExceptionally(error)
        } finally { data.fill(0) }
      }
      try { worker.execute(task) } catch (error: Exception) {
        data.fill(0)
        result.completeExceptionally(error)
      }
      return result
    }
  }

  override fun onCreate() {
    super.onCreate()
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
    if (!JavaScriptSandbox.isSupported()) {
      return DocumentRuntimeStatus("unsupported", "Document access needs a supported Android System WebView.")
    }
    val opening = JavaScriptSandbox.createConnectedInstanceAsync(applicationContext)
    val engine = try {
      opening.get(15, TimeUnit.SECONDS)
    } catch (error: Exception) {
      // Do not leak an engine that finishes connecting after the timeout.
      opening.addListener({ runCatching { opening.get().close() } }, { it.run() })
      throw error
    }
    sandbox = engine
    val missing = listOf(
      JavaScriptSandbox.JS_FEATURE_PROMISE_RETURN,
      JavaScriptSandbox.JS_FEATURE_MESSAGE_PORTS,
      JavaScriptSandbox.JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER,
      JavaScriptSandbox.JS_FEATURE_ISOLATE_TERMINATION,
      JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE,
    ).filterNot(engine::isFeatureSupported)
    if (missing.isNotEmpty()) {
      engine.close()
      sandbox = null
      return DocumentRuntimeStatus("unsupported", "Update Android System WebView to enable document access.", missing)
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
    val previous = isolate
    isolate = null
    runCatching { previous?.close() }
    contentResolver.notifyChange(DocumentsContract.buildRootsUri("$packageName.documents"), null)
    try {
      worker.execute {
        try {
          documentsStarted = false
          storagePort = null
          storageWorker.submit { storage?.close(); storage = null }.get(15, TimeUnit.SECONDS)
          val status = if (sandbox == null) initialize() else {
            loadCore(checkNotNull(sandbox))
            DocumentRuntimeStatus("locked", "Document access is not configured.")
          }
          terminalStatus = if (status.phase == "locked") null else status
          vaultSummary = null
          task.complete(status)
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
      storageWorker.shutdown()
    }
    worker.shutdown()
    super.onDestroy()
  }
}
