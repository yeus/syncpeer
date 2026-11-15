package dev.syncpeer.plugin.android

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises real Android Keystore, ciphertext chunk authentication, fsync and
 * stage publication; no peer connection, Activity or WebView is needed. */
@RunWith(AndroidJUnit4::class)
class EncryptedUploadStagingTest {
  @Test fun encryptedStageSurvivesNewStoreInstanceAndSupportsUnalignedReads() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val bytes = ByteArray(3 * 65536 + 19) { (it % 251).toByte() }
    val store = EncryptedUploadStaging(context)
    val stageId = store.begin(bytes.size.toLong(), 12345)
    try {
      var offset = 0
      while (offset < bytes.size) {
        val part = bytes.copyOfRange(offset, minOf(bytes.size, offset + 65536))
        offset = store.append(stageId, offset.toLong(),
          Base64.encodeToString(part, Base64.NO_WRAP)).toInt()
      }
      val result = store.finish(stageId)
      assertEquals(bytes.size.toLong(), result["sizeBytes"])
      assertEquals(64, (result["sha256"] as String).length)

      // A fresh service instance can read the same authenticated ciphertext
      // from private storage without retaining the staging writer.
      val restarted = EncryptedUploadStaging(context)
      val middle = Base64.decode(restarted.read(stageId, bytes.size.toLong(), 29101, 65536), Base64.NO_WRAP)
      assertArrayEquals(bytes.copyOfRange(29101, 29101 + 65536), middle)
      val end = Base64.decode(restarted.read(stageId, bytes.size.toLong(),
        bytes.size.toLong() - 20, 20), Base64.NO_WRAP)
      assertArrayEquals(bytes.copyOfRange(bytes.size - 20, bytes.size), end)
    } finally { store.discard(stageId) }
  }

  @Test fun uncommittedAndTamperedStagingCanNeverBeUploaded() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val store = EncryptedUploadStaging(context)
    val stageId = store.begin(10, 12)
    try {
      store.append(stageId, 0, Base64.encodeToString(ByteArray(10) { it.toByte() }, Base64.NO_WRAP))
      var rejected = false
      try { store.read(stageId, 10, 0, 10) } catch (_: IllegalStateException) { rejected = true }
      assertTrue("An uncommitted .part must not be readable", rejected)

      store.finish(stageId)
      val root = File(syncpeerPrivateStorageRoot(context.noBackupFilesDir), "transfer-staging")
      val encrypted = File(root, "$stageId.ready")
      assertTrue(encrypted.isFile)
      java.io.RandomAccessFile(encrypted, "rw").use { file ->
        file.seek(13)
        val original = file.readByte()
        file.seek(13)
        file.writeByte(original.toInt() xor 0x01)
      }
      rejected = false
      try { store.read(stageId, 10, 0, 10) } catch (_: Exception) { rejected = true }
      assertTrue("Authentication must reject altered ciphertext", rejected)
    } finally {
      store.discard(stageId)
      val root = File(syncpeerPrivateStorageRoot(context.noBackupFilesDir), "transfer-staging")
      assertFalse(File(root, "$stageId.ready").exists())
    }
  }
}
