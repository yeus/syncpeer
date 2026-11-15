package dev.syncpeer.plugin.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Isolated Keystore profile; never modifies a production transfer journal. */
@RunWith(AndroidJUnit4::class)
class TransferJobStoreTest {
  @Test fun encryptedRetryJournalPersistsEpochsAndRejectsLateCallbacks() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val profileId = "transfer-test-" + UUID.randomUUID()
    try {
      val store = TransferJobStore(context, profileId)
      val created = store.enqueue("download", "folder", "keepass.kdbx", "A".repeat(52))
      val id = created.getString("id")
      val pending = store.progress(id, "failed", 100, 200, "network", 0)!!
      assertEquals("queued", pending.getString("phase"))
      assertEquals(1, pending.getInt("attempts"))
      assertTrue(pending.getLong("nextAttemptMs") > System.currentTimeMillis())

      val restored = TransferJobStore(context, profileId)
      assertEquals(1, restored.pending().size)
      assertEquals(id, restored.list().single().getString("id"))
      // An old asynchronous completion must not publish after the retry epoch changes.
      assertEquals("queued", restored.progress(id, "completed", 200, 200, null, 0)!!.getString("phase"))
      assertEquals("running", restored.progress(id, "running", 0, 200, null, 1)!!.getString("phase"))
      assertEquals("failed", restored.progress(id, "failed", 0, 200, "storage", 1)!!.getString("phase"))
      assertTrue(restored.pending().isEmpty())
    } finally {
      VaultSecretStore(context).execute(profileId, "remove", null)
    }
  }

  @Test fun stagedUploadIntentSurvivesNewServiceAndCancelIsTerminal() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val profileId = "transfer-test-" + UUID.randomUUID()
    try {
      val stageId = UUID.randomUUID().toString()
      val expectedHash = "a".repeat(64)
      val store = TransferJobStore(context, profileId)
      val job = store.enqueue("upload", "folder", "keepass.kdbx", "A".repeat(52),
        mapOf("stageId" to stageId, "sizeBytes" to 1024L,
          "modifiedMs" to 123L, "sha256" to expectedHash))
      val restored = TransferJobStore(context, profileId)
      assertEquals(stageId, restored.pending().single().getString("stageId"))
      assertEquals(setOf(stageId), restored.referencedStages())
      assertEquals("cancelled", restored.cancel(job.getString("id"))!!.getString("phase"))
      assertTrue(restored.referencedStages().isEmpty())
      // A late network callback cannot resurrect a canceled upload.
      assertEquals("cancelled", restored.progress(job.getString("id"), "running",
        900, 1024, null, 0)!!.getString("phase"))
    } finally {
      VaultSecretStore(context).execute(profileId, "remove", null)
    }
  }
}
