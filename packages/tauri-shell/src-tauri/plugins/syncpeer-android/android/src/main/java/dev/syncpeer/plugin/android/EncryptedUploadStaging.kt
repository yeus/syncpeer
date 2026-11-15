package dev.syncpeer.plugin.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.File
import java.io.RandomAccessFile
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Independent encrypted upload staging, outside every replicated folder.
 * Each fixed-size chunk has its own random AES-256-GCM IV and authenticates
 * its stage identity + index. A .ready file exists only after fsync + rename;
 * a process death during staging therefore never exposes a partial source.
 */
internal class EncryptedUploadStaging(context: Context) {
  private val root = File(prepareSyncpeerPrivateStorageRoot(context.noBackupFilesDir), "transfer-staging").apply {
    check(isDirectory || mkdir()) { "Private transfer staging is unavailable." }
  }
  private val sessions = mutableMapOf<String, Writer>()
  private data class Writer(val file: RandomAccessFile, val expected: Long, val modifiedMs: Long,
    val digest: MessageDigest, var offset: Long = 0, var lastActivityMs: Long = System.currentTimeMillis())

  private val key: SecretKey by lazy {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (store.containsAlias(KEY_ALIAS)) store.getKey(KEY_ALIAS, null) as SecretKey
    else KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }

  private fun validated(id: String): String {
    require(ID.matches(id)) { "Invalid staged upload identity." }
    return id
  }
  private fun part(id: String) = File(root, "${validated(id)}.part")
  private fun ready(id: String) = File(root, "${validated(id)}.ready")

  @Synchronized fun begin(size: Long, modifiedMs: Long): String {
    require(size >= 0 && size <= MAX_SIZE && modifiedMs >= 0) { "Invalid staged upload size or time." }
    // A browser process can disappear during preparation while this service
    // survives. Reclaim abandoned writer handles before enforcing the limit.
    val cutoff = System.currentTimeMillis() - 10 * 60_000L
    for ((id, writer) in sessions.toMap()) {
      if (writer.lastActivityMs < cutoff) {
        runCatching { writer.file.close() }
        sessions.remove(id)
        part(id).delete()
      }
    }
    check(sessions.size < 2) { "Too many uploads are being prepared." }
    val encryptedSize = size + ((size + CHUNK_SIZE - 1) / CHUNK_SIZE) * OVERHEAD
    check(root.usableSpace > encryptedSize + CHUNK_SIZE) {
      "Insufficient private storage for upload staging."
    }
    val id = UUID.randomUUID().toString()
    val file = part(id)
    check(file.createNewFile()) { "Could not allocate upload staging." }
    try {
      sessions[id] = Writer(RandomAccessFile(file, "rw"), size, modifiedMs,
        MessageDigest.getInstance("SHA-256"))
    } catch (error: Exception) {
      file.delete()
      throw error
    }
    return id
  }

  @Synchronized fun append(id: String, offset: Long, base64: String): Long {
    val writer = sessions[validated(id)] ?: throw IllegalStateException("Upload staging was interrupted.")
    require(offset == writer.offset) { "Staged upload offsets must be contiguous." }
    require(base64.length <= 90 * 1024) { "Upload staging chunk exceeds limit." }
    val bytes = Base64.decode(base64, Base64.NO_WRAP)
    try {
      val remaining = writer.expected - writer.offset
      require(remaining > 0 && bytes.size == minOf(CHUNK_SIZE.toLong(), remaining).toInt()) {
        "Staged upload chunk size is invalid."
      }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key)
      cipher.updateAAD("${id}:${offset / CHUNK_SIZE}".toByteArray(Charsets.UTF_8))
      val encrypted = cipher.doFinal(bytes)
      check(cipher.iv.size == NONCE_SIZE) { "Unexpected staged upload nonce." }
      writer.file.write(cipher.iv)
      writer.file.write(encrypted)
      writer.digest.update(bytes)
      writer.offset += bytes.size
      writer.lastActivityMs = System.currentTimeMillis()
      return writer.offset
    } finally { bytes.fill(0) }
  }

  @Synchronized fun finish(id: String): Map<String, Any> {
    val writer = sessions[validated(id)] ?: throw IllegalStateException("Upload staging was interrupted.")
    check(writer.offset == writer.expected) { "Upload staging is incomplete." }
    val hash = writer.digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    writer.file.fd.sync()
    writer.file.close()
    sessions.remove(id)
    check(part(id).renameTo(ready(id))) { "Could not publish encrypted upload staging." }
    return mapOf("stageId" to id, "sizeBytes" to writer.expected,
      "modifiedMs" to writer.modifiedMs, "sha256" to hash)
  }

  /** Only the persistent service reads stages, never the WebView. */
  @Synchronized fun read(id: String, size: Long, offset: Long, count: Int): String {
    require(size in 0..MAX_SIZE && offset >= 0 && count in 0..CHUNK_SIZE &&
      offset <= size && count.toLong() <= size - offset) { "Invalid staged upload range." }
    val file = ready(id)
    check(file.isFile) { "Encrypted upload staging is missing." }
    val chunks = if (size == 0L) 0 else (size + CHUNK_SIZE - 1) / CHUNK_SIZE
    check(file.length() == size + chunks * OVERHEAD) { "Encrypted upload staging is damaged." }
    val output = ByteArray(count)
    RandomAccessFile(file, "r").use { source ->
      var done = 0
      while (done < count) {
        val at = offset + done
        val index = at / CHUNK_SIZE
        val within = (at % CHUNK_SIZE).toInt()
        val plainSize = minOf(CHUNK_SIZE.toLong(), size - index * CHUNK_SIZE).toInt()
        val encrypted = ByteArray(plainSize + OVERHEAD)
        source.seek(index * (CHUNK_SIZE + OVERHEAD))
        source.readFully(encrypted)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, encrypted.copyOfRange(0, NONCE_SIZE)))
        cipher.updateAAD("${id}:${index}".toByteArray(Charsets.UTF_8))
        val plain = cipher.doFinal(encrypted, NONCE_SIZE, encrypted.size - NONCE_SIZE)
        try {
          val n = minOf(count - done, plainSize - within)
          System.arraycopy(plain, within, output, done, n)
          done += n
        } finally { plain.fill(0); encrypted.fill(0) }
      }
    }
    try { return Base64.encodeToString(output, Base64.NO_WRAP) }
    finally { output.fill(0) }
  }

  @Synchronized fun discard(id: String) {
    validated(id)
    sessions.remove(id)?.file?.close()
    part(id).delete()
    ready(id).delete()
  }

  @Synchronized fun pruneOrphans(referenced: Set<String>) {
    // Never delete a still-referenced source. Stale unfinished stages are not
    // resumable; committed but orphaned files can be cleaned after a grace period.
    val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
    root.listFiles()?.forEach { file ->
      val id = file.name.substringBeforeLast('.')
      if (ID.matches(id) && !sessions.containsKey(id) && !referenced.contains(id) &&
        file.lastModified() < cutoff) file.delete()
    }
  }

  private companion object {
    const val KEY_ALIAS = "syncpeer.transfer.staging.v1"
    const val CHUNK_SIZE = 64 * 1024
    const val NONCE_SIZE = 12
    const val OVERHEAD = NONCE_SIZE + 16
    const val MAX_SIZE = 512L * 1024 * 1024
    val ID = Regex("[a-f0-9]{8}-[a-f0-9-]{27,56}")
  }
}
