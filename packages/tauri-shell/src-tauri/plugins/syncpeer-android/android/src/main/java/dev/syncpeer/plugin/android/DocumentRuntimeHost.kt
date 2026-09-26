package dev.syncpeer.plugin.android

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.webkit.RenderProcessGoneDetail
import android.webkit.ConsoleMessage
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.Message
import androidx.javascriptengine.MessagePort
import java.io.ByteArrayInputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

internal interface DocumentRuntimeHost : AutoCloseable {
  val kind: DocumentRuntimeKind
  fun evaluate(code: String, input: ByteArray): CompletableFuture<String>
}

internal fun sandboxSupportsWebCrypto(sandbox: JavaScriptSandbox): Boolean {
  val isolate = sandbox.createIsolate(IsolateStartupParameters())
  return try {
    isolate.evaluateJavaScriptAsync("""
      (() => {
        const crypto = globalThis.crypto;
        return !!crypto && typeof crypto.getRandomValues === 'function' &&
          !!crypto.subtle && ['digest', 'importKey', 'deriveBits', 'encrypt', 'decrypt', 'sign', 'verify']
            .every(name => typeof crypto.subtle[name] === 'function');
      })()
    """.trimIndent()).get(5, TimeUnit.SECONDS) == "true"
  } catch (_: Exception) {
    false
  } finally {
    isolate.close()
  }
}

internal class SandboxDocumentRuntimeHost private constructor(
  private val sandbox: JavaScriptSandbox,
  private val isolate: JavaScriptIsolate,
  private val timerExecutor: ScheduledExecutorService,
) : DocumentRuntimeHost {
  override val kind = DocumentRuntimeKind.SANDBOX
  private var requestId = 0L

  override fun evaluate(code: String, input: ByteArray): CompletableFuture<String> {
    val name = "request-${++requestId}"
    isolate.provideNamedData(name, input)
    val script = "android.consumeNamedDataAsArrayBuffer('$name').then(bytes => {" +
      "const parsed = JSON.parse(new TextDecoder().decode(bytes)); new Uint8Array(bytes).fill(0);" +
      "return (async input => { $code\n})(parsed); })"
    val evaluated = isolate.evaluateJavaScriptAsync(script)
    val result = CompletableFuture<String>()
    evaluated.addListener({
      try { result.complete(evaluated.get()) }
      catch (error: Exception) { result.completeExceptionally(error) }
    }, { it.run() })
    return result
  }

  override fun close() {
    ports.forEach { runCatching { it.close() } }
    ports = emptyList()
    timerExecutor.shutdownNow()
    isolate.close()
    sandbox.close()
  }

  companion object {
    fun create(
      sandbox: JavaScriptSandbox,
      code: String,
      storageExecutor: Executor,
      networkExecutor: Executor,
      storageRequest: (String) -> String,
      networkRequest: (String) -> String,
      terminated: () -> Unit,
    ): SandboxDocumentRuntimeHost {
      val startup = IsolateStartupParameters().apply {
        setMaxHeapSizeBytes(128L * 1024 * 1024)
        setMaxEvaluationReturnSizeBytes(1024 * 1024)
      }
      val isolate = sandbox.createIsolate(startup)
      val storage = createSandboxPort(isolate, "storage", storageExecutor, storageRequest)
      val network = createSandboxPort(isolate, "network", networkExecutor, networkRequest)
      val timerExecutor = Executors.newSingleThreadScheduledExecutor()
      val timer = createSandboxTimerPort(isolate, timerExecutor)
      isolate.addOnTerminatedCallback({ it.run() }) { terminated() }
      try {
        check(isolate.evaluateJavaScriptAsync(code).get(15, TimeUnit.SECONDS) == "ready")
        return SandboxDocumentRuntimeHost(sandbox, isolate, timerExecutor).also {
          // Keep the native endpoints alive for the lifetime of the isolate.
          it.ports = listOf(storage, network, timer)
        }
      } catch (error: Exception) {
        runCatching { storage.close() }
        runCatching { network.close() }
        runCatching { timer.close() }
        timerExecutor.shutdownNow()
        isolate.close()
        sandbox.close()
        throw error
      }
    }

    private fun createSandboxPort(
      isolate: JavaScriptIsolate,
      name: String,
      executor: Executor,
      request: (String) -> String,
    ): MessagePort {
      lateinit var port: MessagePort
      port = isolate.createMessageChannel(name, executor) { message ->
        port.postMessage(Message.createStringMessage(request(message.string)))
      }
      return port
    }

    private fun createSandboxTimerPort(
      isolate: JavaScriptIsolate,
      executor: ScheduledExecutorService,
    ): MessagePort {
      lateinit var port: MessagePort
      port = isolate.createMessageChannel("timer", executor) { message ->
        val request = JSONObject(message.string)
        val reply = JSONObject().put("id", request.getLong("id")).put("result", JSONObject.NULL)
        val delayMs = request.optLong("delayMs", 0L).coerceAtLeast(0L)
        executor.schedule({ runCatching { port.postMessage(Message.createStringMessage(reply.toString())) } },
          delayMs, TimeUnit.MILLISECONDS)
      }
      return port
    }
  }

  private var ports: List<MessagePort> = emptyList()
}

internal class WebViewDocumentRuntimeHost private constructor(
  private val mainHandler: Handler,
  private val webView: WebView,
  private val commandPort: WebMessagePort,
  private val nativePorts: List<WebMessagePort>,
) : DocumentRuntimeHost {
  override val kind = DocumentRuntimeKind.WEB_VIEW
  private val closed = AtomicBoolean(false)
  private val pending = mutableMapOf<Long, CompletableFuture<String>>()
  private var requestId = 0L

  override fun evaluate(code: String, input: ByteArray): CompletableFuture<String> {
    val result = CompletableFuture<String>()
    mainHandler.post {
      if (closed.get()) {
        result.completeExceptionally(IllegalStateException("Document runtime is closed."))
        return@post
      }
      val id = ++requestId
      pending[id] = result
      val message = JSONObject()
        .put("id", id)
        .put("code", code)
        .put("input", String(input, Charsets.UTF_8))
      runCatching { commandPort.postMessage(WebMessage(message.toString())) }
        .onFailure { pending.remove(id)?.completeExceptionally(it) }
    }
    return result
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    mainHandler.post {
      val error = IllegalStateException("Document runtime closed before replying.")
      pending.values.forEach { it.completeExceptionally(error) }
      pending.clear()
      runCatching { commandPort.close() }
      nativePorts.forEach { runCatching { it.close() } }
      webView.stopLoading()
      webView.destroy()
    }
  }

  private fun receive(message: String) {
    val reply = JSONObject(message)
    val id = reply.optLong("id", -1)
    if (id < 0) return
    val task = pending.remove(id) ?: return
    if (reply.has("error")) task.completeExceptionally(IllegalStateException(reply.getString("error")))
    else task.complete(reply.getString("result"))
  }

  companion object {
    private val origin = Uri.parse("https://syncpeer.invalid")
    private const val pageUrl = "https://syncpeer.invalid/runtime.html"
    private const val scriptUrl = "https://syncpeer.invalid/syncpeer-documents.js"
    private const val html = """<!doctype html><meta charset="utf-8"><script src="/syncpeer-documents.js"></script>"""

    fun create(
      context: Context,
      mainHandler: Handler,
      storageExecutor: Executor,
      networkExecutor: Executor,
      storageRequest: (String) -> String,
      networkRequest: (String) -> String,
      terminated: () -> Unit,
    ): CompletableFuture<WebViewDocumentRuntimeHost> {
      val ready = CompletableFuture<WebViewDocumentRuntimeHost>()
      mainHandler.post {
        try {
          val view = WebView(context)
          ready.whenComplete { _, error ->
            if (error != null) mainHandler.post { view.stopLoading(); view.destroy() }
          }
          configure(view)
          view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
              if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR && !ready.isDone) {
                ready.completeExceptionally(IllegalStateException(
                  "Document WebView JavaScript failed at packaged line ${message.lineNumber()}: ${message.message()}",
                ))
              }
              return true
            }
          }
          view.webViewClient = runtimeClient(context, ready, terminated) { webView ->
            connect(webView, mainHandler, storageExecutor, networkExecutor,
              storageRequest, networkRequest, ready)
          }
          view.loadUrl(pageUrl)
        } catch (error: Exception) {
          ready.completeExceptionally(error)
        }
      }
      return ready
    }

    private fun configure(webView: WebView) = webView.settings.apply {
      javaScriptEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      domStorageEnabled = false
      databaseEnabled = false
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    }

    private fun runtimeClient(
      context: Context,
      ready: CompletableFuture<WebViewDocumentRuntimeHost>,
      terminated: () -> Unit,
      loaded: (WebView) -> Unit,
    ) = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        request.url.toString() !in setOf(pageUrl, scriptUrl)

      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
        when (request.url.toString()) {
          pageUrl -> response("text/html", ByteArrayInputStream(html.toByteArray()))
          scriptUrl -> response("application/javascript", context.assets.open("syncpeer-documents.js"))
          else -> WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(),
            ByteArrayInputStream(ByteArray(0)))
        }

      override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (url != pageUrl) view.stopLoading()
      }

      override fun onPageFinished(view: WebView, url: String) {
        if (url == pageUrl && !ready.isDone) loaded(view)
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        if (request.isForMainFrame) ready.completeExceptionally(
          IllegalStateException("Document WebView could not load its packaged runtime."),
        )
      }

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        if (!ready.isDone) {
          ready.completeExceptionally(IllegalStateException("Document WebView renderer exited."))
        } else {
          terminated()
        }
        return true
      }
    }

    private fun response(mime: String, data: java.io.InputStream) = WebResourceResponse(
      mime, "utf-8", 200, "OK",
      mapOf("Content-Security-Policy" to "default-src 'none'; script-src 'self' 'unsafe-eval'"), data,
    )

    private fun connect(
      webView: WebView,
      mainHandler: Handler,
      storageExecutor: Executor,
      networkExecutor: Executor,
      storageRequest: (String) -> String,
      networkRequest: (String) -> String,
      ready: CompletableFuture<WebViewDocumentRuntimeHost>,
    ) {
      val channels = List(3) { webView.createWebMessageChannel() }
      val nativePorts = channels.map { it[0] }
      val host = WebViewDocumentRuntimeHost(mainHandler, webView, nativePorts[0], nativePorts)
      nativePorts[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
        override fun onMessage(port: WebMessagePort, message: WebMessage) {
          val value = message.data ?: return
          val parsed = runCatching { JSONObject(value) }.getOrNull()
          if (parsed?.optBoolean("ready") == true) ready.complete(host) else host.receive(value)
        }
      }, mainHandler)
      connectNativePort(nativePorts[1], mainHandler, storageExecutor, storageRequest)
      connectNativePort(nativePorts[2], mainHandler, networkExecutor, networkRequest)
      webView.postWebMessage(WebMessage("syncpeer-runtime", channels.map { it[1] }.toTypedArray()), origin)
    }

    private fun connectNativePort(
      port: WebMessagePort,
      mainHandler: Handler,
      executor: Executor,
      request: (String) -> String,
    ) {
      port.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
        override fun onMessage(source: WebMessagePort, message: WebMessage) {
          val value = message.data ?: return
          executor.execute {
            val reply = request(value)
            mainHandler.post { runCatching { port.postMessage(WebMessage(reply)) } }
          }
        }
      }, mainHandler)
    }
  }
}
