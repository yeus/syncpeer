package dev.syncpeer.plugin.android

import android.content.Context
import android.os.Build
import android.os.UserManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Platform wrapping only. Folder encryption and manual-lock policy remain in core. */
class VaultSecretStore(private val context: Context) {
  fun isDeviceUnlocked(): Boolean = Build.VERSION.SDK_INT >= 24 &&
    (context.getSystemService(Context.USER_SERVICE) as UserManager).isUserUnlocked

  @Synchronized
  fun execute(profileId: String, operation: String, secret: String?): Any? {
    require(profileId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "Invalid vault profile" }
    if (operation == "isDeviceUnlocked") return isDeviceUnlocked()
    check(isDeviceUnlocked()) { "Device credentials are unavailable before first unlock" }
    val alias = "syncpeer.vault.$profileId"
    val file = AtomicFile(File(context.noBackupFilesDir, "$alias.secret"))
    val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return when (operation) {
      "save" -> {
        require(secret != null && secret.isNotEmpty() && secret.length <= 4096) { "Invalid unlock secret" }
        val key = if (keys.containsAlias(alias)) keys.getKey(alias, null) as SecretKey else generateKey(alias)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(alias.toByteArray(Charsets.UTF_8))
        val plaintext = secret.toByteArray(Charsets.UTF_8)
        try {
          val encrypted = cipher.doFinal(plaintext)
          check(cipher.iv.size == 12) { "Unexpected credential nonce" }
          val output = file.startWrite()
          try {
            output.write(1)
            output.write(cipher.iv)
            output.write(encrypted)
            file.finishWrite(output)
          } catch (error: Exception) { file.failWrite(output); throw error }
        } finally { plaintext.fill(0) }
        null
      }
      "load" -> {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
        check(keys.containsAlias(alias)) { "Remembered credential key is missing" }
        file.openRead().use { input ->
          val payload = input.readBytesBounded(16413)
          check(payload.size >= 29 && payload[0].toInt() == 1) { "Invalid remembered credential" }
          val cipher = Cipher.getInstance("AES/GCM/NoPadding")
          cipher.init(Cipher.DECRYPT_MODE, keys.getKey(alias, null), GCMParameterSpec(128, payload.copyOfRange(1, 13)))
          cipher.updateAAD(alias.toByteArray(Charsets.UTF_8))
          val plaintext = cipher.doFinal(payload, 13, payload.size - 13)
          try { String(plaintext, Charsets.UTF_8) } finally { plaintext.fill(0) }
        }
      }
      "remove" -> { file.delete(); if (keys.containsAlias(alias)) keys.deleteEntry(alias); null }
      else -> throw IllegalArgumentException("Unknown credential operation")
    }
  }

  private fun generateKey(alias: String): SecretKey {
    check(Build.VERSION.SDK_INT >= 23) { "Android Keystore is unavailable" }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    return generator.generateKey()
  }

  private fun java.io.InputStream.readBytesBounded(limit: Int): ByteArray {
    val bytes = ByteArray(limit + 1)
    var offset = 0
    while (offset < bytes.size) {
      val count = read(bytes, offset, bytes.size - offset)
      if (count < 0) break
      offset += count
    }
    check(offset <= limit) { "Remembered credential is oversized" }
    return bytes.copyOf(offset)
  }
}
