package dev.syncpeer.plugin.android

import androidx.annotation.Keep
import org.json.JSONObject

/** Owns native handles; all actual byte-storage behavior lives in replica_storage.rs. */
@Keep
class DocumentByteStorage : AutoCloseable {
  @Keep private var nativeHandle: Long = 0
  init { System.loadLibrary("tauri_shell_lib"); initialize() }
  private external fun initialize()
  private external fun request(json: String): String
  private external fun dispose()
  @Synchronized fun execute(request: JSONObject): Any? {
    check(nativeHandle != 0L) { "Document storage is closed" }
    val reply = JSONObject(request(request.toString()))
    check(!reply.has("error")) { reply.optString("error") }
    return reply.opt("result").takeUnless { it == JSONObject.NULL }
  }
  @Synchronized override fun close() { if (nativeHandle != 0L) dispose() }
}
