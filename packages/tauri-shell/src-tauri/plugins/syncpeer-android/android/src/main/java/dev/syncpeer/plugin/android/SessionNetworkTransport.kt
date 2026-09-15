package dev.syncpeer.plugin.android

import androidx.annotation.Keep
import org.json.JSONObject

/**
 * Thin JNI boundary for the service-owned TypeScript session.  TLS, discovery,
 * hashing, and random bytes stay in the existing Rust transport implementation.
 */
@Keep
class SessionNetworkTransport : AutoCloseable {
  @Keep private var nativeHandle: Long = 0

  init {
    System.loadLibrary("tauri_shell_lib")
    initialize()
  }

  private external fun initialize()
  private external fun request(json: String): String
  private external fun dispose()

  @Synchronized
  fun execute(input: JSONObject): Any? {
    check(nativeHandle != 0L) { "Network transport is closed" }
    val reply = JSONObject(request(input.toString()))
    if (reply.has("error")) throw IllegalStateException(reply.optString("error"))
    return reply.opt("result").takeUnless { it == JSONObject.NULL }
  }

  @Synchronized
  override fun close() {
    if (nativeHandle != 0L) {
      dispose()
      nativeHandle = 0L
    }
  }
}
