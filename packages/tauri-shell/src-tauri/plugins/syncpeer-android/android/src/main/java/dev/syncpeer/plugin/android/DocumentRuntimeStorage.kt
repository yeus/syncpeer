package dev.syncpeer.plugin.android

import android.content.Context
import android.os.StatFs
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

/** Application-private roots, random bytes, and Keystore wrapping; no file crypto. */
class DocumentRuntimeStorage(private val context: Context) : AutoCloseable {
  private val metadataRoot = File(context.noBackupFilesDir, "metadata")
  private val secrets = VaultSecretStore(context)
  private val random = SecureRandom()
  private val bytes = DocumentByteStorage(metadataRoot.absolutePath, metadataKey())

  private fun metadataKey(): String {
    val existing = secrets.execute("metadata", "load", null) as? String
    if (existing != null) {
      check(existing.matches(Regex("[0-9a-f]{64}"))) { "Protected metadata key is invalid" }
      return existing
    }
    val folders = File(metadataRoot, "folders")
    check(!File(metadataRoot, "key-check").exists()) {
      "Existing metadata requires its protected key or a confirmed local reset"
    }
    if (folders.exists()) {
      val entries = folders.listFiles() ?: error("Metadata state could not be inspected")
      check(entries.none { it.isDirectory && (it.listFiles() ?: error("Metadata state could not be inspected")).isNotEmpty() }) {
        "Existing metadata requires its protected key or a confirmed local reset"
      }
    }
    val key = ByteArray(32).also(random::nextBytes)
    try {
      val encoded = key.joinToString("") { "%02x".format(it.toInt() and 255) }
      secrets.execute("metadata", "save", encoded)
      check(secrets.execute("metadata", "load", null) == encoded) { "Protected metadata key verification failed" }
      return encoded
    } finally { key.fill(0) }
  }

  fun execute(request: JSONObject): Any? = when (request.getString("method")) {
    "storage" -> bytes.execute(request.getJSONObject("input"))
    "secret" -> secrets.execute("documents", request.getString("operation"),
      if (request.has("secret")) request.getString("secret") else null)
    "random" -> {
      val size = request.getInt("size")
      require(size in 1..131072)
      val value = ByteArray(size).also(random::nextBytes)
      JSONArray(value.map { it.toInt() and 255 })
    }
    "root" -> {
      val id = request.getString("idValue")
      require(id == "profile" || id.matches(Regex("[a-f0-9]{32}")))
      val root = File(context.noBackupFilesDir, "documents/$id")
      check(root.isDirectory || root.mkdirs())
      root.canonicalPath
    }
    "counter" -> {
      val settings = context.getSharedPreferences("document-runtime", Context.MODE_PRIVATE)
      settings.getString("counter", null) ?: run {
        val id = (random.nextLong().ushr(1) or 1L).toString()
        check(settings.edit().putString("counter", id).commit())
        id
      }
    }
    "availableBytes" -> StatFs(context.noBackupFilesDir.absolutePath).availableBytes
    else -> throw IllegalArgumentException("Unknown document storage method")
  }

  override fun close() = bytes.close()
}
