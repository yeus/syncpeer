package dev.syncpeer.plugin.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

/** Application-private roots, random bytes, and Keystore wrapping; no file crypto. */
class DocumentRuntimeStorage(private val context: Context) : AutoCloseable {
  private val bytes = DocumentByteStorage()
  private val secrets = VaultSecretStore(context)
  private val random = SecureRandom()

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
    else -> throw IllegalArgumentException("Unknown document storage method")
  }

  override fun close() = bytes.close()
}
