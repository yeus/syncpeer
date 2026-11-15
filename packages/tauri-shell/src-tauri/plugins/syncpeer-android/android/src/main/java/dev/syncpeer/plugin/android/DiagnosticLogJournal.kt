package dev.syncpeer.plugin.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.RandomAccessFile
import java.security.KeyStore
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * Keystore-encrypted, append-only crash diagnostic ring independent of the vault
 * and peer-session worker. Every batch is fd.sync()'d; partial tail frames from
 * process death are ignored. No logs are saved in WebView localStorage.
 */
internal class DiagnosticLogJournal(context: Context) {
  private val root = File(context.noBackupFilesDir, "diagnostic-journal").apply {
    check(isDirectory || mkdirs()) { "Diagnostic log storage is unavailable." }
  }
  // One historical run is typically paged in dozens of 100-entry IPC calls.
  // Cache that immutable run instead of decrypting the entire ring each time.
  private var cachedRun: Pair<String, List<JSONObject>>? = null
  private val key: SecretKey by lazy {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (store.containsAlias(KEY_ALIAS)) store.getKey(KEY_ALIAS, null) as SecretKey
    else KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }

  private fun segments(): List<File> =
    root.listFiles()?.filter { it.name.matches(Regex("segment-[0-9]{10}\\.bin")) }
      ?.sortedBy { it.name } ?: emptyList()

  private fun encrypt(plaintext: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    // AndroidKeyStore disallows caller-provided IVs when randomized encryption
    // is required (the default for generated keys). Let Keystore choose it.
    cipher.init(Cipher.ENCRYPT_MODE, key)
    val nonce = cipher.iv
    check(nonce.size == 12) { "Unsupported diagnostic journal nonce length." }
    cipher.updateAAD(AAD)
    return nonce + cipher.doFinal(plaintext)
  }

  private fun decrypt(value: ByteArray): ByteArray {
    require(value.size >= 29)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, value.copyOfRange(0, 12)))
    cipher.updateAAD(AAD)
    return cipher.doFinal(value, 12, value.size - 12)
  }

  private fun nextSegment(): File {
    val latest = segments().lastOrNull()
    if (latest == null) return File(root, "segment-0000000001.bin")
    if (latest.length() < SEGMENT_BYTES) return latest
    val next = latest.name.removePrefix("segment-").removeSuffix(".bin").toLong() + 1
    return File(root, "segment-${next.toString().padStart(10, '0')}.bin")
  }

  /** A process may die between the frame header and ciphertext. Repair the
   * incomplete tail before adding anything new so later entries stay readable. */
  private fun repairInterruptedTail(file: File) {
    if (!file.isFile) return
    RandomAccessFile(file, "rw").use { stream ->
      var pos = 0L
      while (pos + 4 <= stream.length()) {
        stream.seek(pos)
        val size = stream.readInt()
        if (size !in 29..(MAX_RECORD_BYTES + 28) || pos + 4 + size > stream.length()) break
        pos += 4 + size
      }
      if (pos != stream.length()) {
        stream.setLength(pos)
        stream.fd.sync()
      }
    }
  }

  fun append(events: List<JSONObject>) = synchronized(IO_LOCK) {
    require(events.size in 1..MAX_BATCH) { "Invalid diagnostic batch." }
    repairInterruptedTail(segments().lastOrNull() ?: nextSegment())
    var stream: RandomAccessFile? = null
    var openedFile: File? = null
    try {
      for (event in events) {
        val runId = event.optString("runId")
        val level = event.optString("level")
        val name = event.optString("event")
        require(runId.matches(RUN_ID) && level in LEVELS && name.matches(EVENT_ID))
        val timestamp = event.optLong("timestampMs")
        require(timestamp > 0)
        val message = event.optString("message").take(MAX_MESSAGE_CHARS)
        val details = event.opt("details")
        val record = JSONObject().put("runId", runId).put("timestampMs", timestamp)
          .put("level", level).put("event", name).put("message", message)
        if (details != null && details !== JSONObject.NULL) {
          record.put("details", details.toString().take(MAX_DETAILS_CHARS))
        }
        val plaintext = record.toString().toByteArray(Charsets.UTF_8)
        try {
          require(plaintext.size <= MAX_RECORD_BYTES)
          val ciphertext = encrypt(plaintext)
          val file = nextSegment()
          if (file != openedFile) {
            stream?.fd?.sync()
            stream?.close()
            stream = RandomAccessFile(file, "rw")
            openedFile = file
          }
          val output = checkNotNull(stream)
          output.seek(output.length())
          output.writeInt(ciphertext.size)
          output.write(ciphertext)
        } finally { plaintext.fill(0) }
      }
      stream?.fd?.sync()
    } finally { stream?.close() }
    val old = segments()
    if (cachedRun != null && events.any { it.optString("runId") == cachedRun?.first }) {
      cachedRun = null
    }
    if (old.size > MAX_SEGMENTS) {
      old.take(old.size - MAX_SEGMENTS).forEach(File::delete)
      cachedRun = null
    }
  }

  /** Only a trailing interrupted record may be discarded. Earlier authenticated
   * corruption cannot cause plaintext or forged messages to be returned. */
  fun readAll(): List<JSONObject> = synchronized(IO_LOCK) {
    val events = mutableListOf<JSONObject>()
    for (segment in segments()) {
      RandomAccessFile(segment, "r").use { input ->
        while (input.filePointer + 4 <= input.length()) {
          val count = input.readInt()
          if (count !in 29..(MAX_RECORD_BYTES + 28) || input.filePointer + count > input.length()) break
          val payload = ByteArray(count)
          input.readFully(payload)
          try {
            val plaintext = decrypt(payload)
            try {
              val value = JSONObject(String(plaintext, Charsets.UTF_8))
              if (value.optString("runId").matches(RUN_ID)) events.add(value)
            } finally { plaintext.fill(0) }
          } catch (_: Exception) {
            // Preserve earlier records and advance to the next framed record.
            // A corrupted GCM frame can never be interpreted as a valid log.
          } finally { payload.fill(0) }
        }
      }
    }
    return events
  }

  /** Startup must not decrypt the entire historical journal on the critical
   * path. Historical runs are requested separately only after UI is ready. */
  fun startRun(runId: String): JSONObject = synchronized(IO_LOCK) {
    require(runId.matches(RUN_ID)) { "Invalid diagnostic run identity." }
    if (activeRunId != runId) {
      append(listOf(JSONObject().put("runId", runId).put("timestampMs", System.currentTimeMillis())
        .put("level", "info").put("event", "app.run.started").put("message", "Syncpeer process started.")))
      activeRunId = runId
    }
    JSONObject().put("started", true)
  }

  fun listRuns(): JSONArray = synchronized(IO_LOCK) {
    val grouped = readAll().groupBy { it.getString("runId") }
    return JSONArray(grouped.map { (id, values) ->
      JSONObject().put("runId", id).put("startedAtMs", values.first().optLong("timestampMs"))
        .put("lastEventAtMs", values.last().optLong("timestampMs")).put("count", values.size)
    }.sortedByDescending { it.getLong("lastEventAtMs") }.take(MAX_SEGMENTS))
  }

  fun readRun(runId: String, offset: Int, limit: Int): JSONObject = synchronized(IO_LOCK) {
    require(runId.matches(RUN_ID) && offset >= 0 && limit in 1..100)
    val values = cachedRun?.takeIf { it.first == runId }?.second
      ?: readAll().filter { it.optString("runId") == runId }.also { cachedRun = runId to it }
    return JSONObject().put("total", values.size)
      .put("items", JSONArray(values.drop(offset).take(limit)))
  }

  companion object {
    private const val KEY_ALIAS = "syncpeer.diagnostic.journal.v1"
    private val AAD = "syncpeer-diagnostic-v1".toByteArray(Charsets.UTF_8)
    private val RUN_ID = Regex("[a-fA-F0-9-]{8,64}")
    private val EVENT_ID = Regex("[a-zA-Z0-9._-]{1,128}")
    private val LEVELS = setOf("info", "warning", "error")
    private const val MAX_RECORD_BYTES = 4096
    private const val MAX_MESSAGE_CHARS = 600
    private const val MAX_DETAILS_CHARS = 2400
    private const val MAX_BATCH = 32
    private const val SEGMENT_BYTES = 512 * 1024L
    private const val MAX_SEGMENTS = 8
    private val IO_LOCK = Any()
    @Volatile private var activeRunId = ""
    // A service may initialize and even crash before the WebView registers
    // its run ID. Keep those native events in a process-scoped encrypted run.
    private val processRunId = java.util.UUID.randomUUID().toString()
    private val crashHandlerInstalled = AtomicBoolean(false)
    private val nativeWriter = Executors.newSingleThreadExecutor { task ->
      Thread(task, "syncpeer-diagnostic-writer").apply { isDaemon = true }
    }

    /** Android 11+ can report fatal process exits even when SIGKILL/OOM
     * prevented both JavaScript and Java uncaught-exception handlers. */
    fun recordPreviousProcessExit(context: Context, journal: DiagnosticLogJournal, runId: String): JSONObject? {
      if (android.os.Build.VERSION.SDK_INT < 30 || !runId.matches(RUN_ID)) return null
      return runCatching {
        val manager = context.getSystemService(android.app.ActivityManager::class.java)
          ?: return@runCatching null
        val prefs = context.getSharedPreferences("syncpeer-diagnostic-exit", Context.MODE_PRIVATE)
        val reported = prefs.getLong("lastExitAtMs", 0)
        val abnormal = setOf(
          android.app.ApplicationExitInfo.REASON_CRASH,
          android.app.ApplicationExitInfo.REASON_CRASH_NATIVE,
          android.app.ApplicationExitInfo.REASON_ANR,
          android.app.ApplicationExitInfo.REASON_LOW_MEMORY,
        )
        val exit = manager.getHistoricalProcessExitReasons(context.packageName, 0, 8)
          .filter { it.reason in abnormal && it.timestamp > reported }
          .maxByOrNull { it.timestamp } ?: return@runCatching null
        val record = JSONObject()
          .put("runId", runId).put("timestampMs", System.currentTimeMillis())
          .put("level", "error").put("event", "native.previous_process_exit")
          .put("message", "Android recorded an abnormal previous Syncpeer process exit.")
          .put("details", JSONObject()
            .put("reasonCode", exit.reason)
            .put("statusCode", exit.status)
            .put("exitTimestampMs", exit.timestamp)
            .put("pssKb", exit.pss)
            .put("rssKb", exit.rss))
        journal.append(listOf(record))
        prefs.edit().putLong("lastExitAtMs", exit.timestamp).apply()
        record
      }.getOrNull()
    }

    fun installCrashHandler(context: Context) {
      if (!crashHandlerInstalled.compareAndSet(false, true)) return
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        try {
          val id = activeRunId.takeIf { it.matches(RUN_ID) } ?: processRunId
          val frames = error.stackTrace.take(8).joinToString(" | ") {
            // No file paths, arguments, exception messages or credentials.
            "${it.className.substringAfterLast('.') }.${it.methodName}"
          }
          DiagnosticLogJournal(context.applicationContext).append(listOf(JSONObject()
            .put("runId", id).put("timestampMs", System.currentTimeMillis())
            .put("level", "error").put("event", "native.uncaught_exception")
            .put("message", error.javaClass.simpleName)
            .put("details", frames)))
        } catch (_: Throwable) { /* Never prevent Android's crash handler. */ }
        previous?.uncaughtException(thread, error)
      }
    }

    fun recordNative(context: Context, event: String, level: String = "info",
      details: JSONObject? = null) {
      val id = activeRunId.takeIf { it.matches(RUN_ID) } ?: processRunId
      if (!event.matches(EVENT_ID) || level !in LEVELS) return
      nativeWriter.execute {
        runCatching {
          val record = JSONObject().put("runId", id)
            .put("timestampMs", System.currentTimeMillis())
            .put("level", level).put("event", event).put("message", event)
          if (details != null) record.put("details", details.toString().take(MAX_DETAILS_CHARS))
          DiagnosticLogJournal(context.applicationContext).append(listOf(record))
        }
      }
    }
  }
}
