package dev.syncpeer.plugin.android

import androidx.annotation.Keep
import org.json.JSONObject

internal class DocumentStorageFailure(val category: String) :
  IllegalStateException("Document storage operation failed.")

/** Owns native handles; all actual byte-storage behavior lives in replica_storage.rs. */
@Keep
class DocumentByteStorage(metadataPath: String, metadataKey: String) : AutoCloseable {
  @Keep private var nativeHandle: Long = 0
  init { System.loadLibrary("tauri_shell_lib"); initialize(metadataPath, metadataKey) }
  private external fun initialize(metadataPath: String, metadataKey: String)
  private external fun request(json: String): String
  private external fun dispose()
  @Synchronized fun execute(request: JSONObject): Any? {
    check(nativeHandle != 0L) { "Document storage is closed" }
    val reply = JSONObject(request(request.toString()))
    if (reply.has("error")) {
      val category = reply.optString("failureCategory").takeIf { it in setOf(
        "metadata-key-mismatch", "metadata-key-check-missing", "replica-marker-mismatch",
        "root-identity-mismatch", "root-identity-missing", "profile-marker-invalid",
        "metadata-schema-unsupported", "metadata-database-missing",
        "metadata-integrity", "replica-lock", "metadata-database",
        "permission", "missing-file", "other")
      } ?: "other"
      throw DocumentStorageFailure(category)
    }
    return reply.opt("result").takeUnless { it == JSONObject.NULL }
  }
  @Synchronized override fun close() { if (nativeHandle != 0L) dispose() }
}
