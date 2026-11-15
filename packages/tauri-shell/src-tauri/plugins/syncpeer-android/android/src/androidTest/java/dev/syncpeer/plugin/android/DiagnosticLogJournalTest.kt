package dev.syncpeer.plugin.android

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Tests actual Android Keystore and crash-safe journal files, isolated from
 * the installed app's production diagnostics. Requires an Android device. */
@RunWith(AndroidJUnit4::class)
class DiagnosticLogJournalTest {
  private class IsolatedLogs(context: Context) : ContextWrapper(context) {
    private val dir = File(context.cacheDir, "diagnostics-test-" + UUID.randomUUID()).apply { mkdirs() }
    override fun getNoBackupFilesDir(): File = dir
    fun cleanup() = dir.deleteRecursively()
  }

  @Test fun previousRunSurvivesRestartWithoutPlaintextAtRest() {
    val context = IsolatedLogs(InstrumentationRegistry.getInstrumentation().targetContext)
    try {
      val first = "11111111-1111-1111-1111-111111111111"
      val second = "22222222-2222-2222-2222-222222222222"
      val journal = DiagnosticLogJournal(context)
      journal.startRun(first)
      journal.append(listOf(JSONObject().put("runId", first)
        .put("timestampMs", System.currentTimeMillis())
        .put("level", "error").put("event", "test.crash")
        .put("message", "SyntheticCrashMarkerNotPlaintext")))
      val files = File(context.noBackupFilesDir, "diagnostic-journal").listFiles()!!
      assertTrue(files.isNotEmpty())
      assertFalse(files.joinToString("") { String(it.readBytes(), Charsets.ISO_8859_1) }
        .contains("SyntheticCrashMarkerNotPlaintext"))
      // AndroidKeyStore must generate a fresh nonce for each encrypted record.
      RandomAccessFile(files.single(), "r").use { stream ->
        val firstSize = stream.readInt()
        val firstNonce = ByteArray(12).also { stream.readFully(it) }
        stream.seek(4L + firstSize)
        val secondSize = stream.readInt()
        assertTrue(secondSize >= 29)
        val secondNonce = ByteArray(12).also { stream.readFully(it) }
        assertFalse(firstNonce.contentEquals(secondNonce))
      }

      val restarted = DiagnosticLogJournal(context)
      restarted.startRun(second)
      val previous = restarted.listRuns()
      assertTrue((0 until previous.length()).any {
        previous.getJSONObject(it).getString("runId") == first
      })
      val replay = restarted.readRun(first, 0, 100).getJSONArray("items")
      assertEquals(2, replay.length())
      assertEquals("test.crash", replay.getJSONObject(1).getString("event"))
    } finally { context.cleanup() }
  }

  @Test fun interruptedTailIsRepairedBeforeAppendingMoreDiagnostics() {
    val context = IsolatedLogs(InstrumentationRegistry.getInstrumentation().targetContext)
    try {
      val run = "33333333-3333-3333-3333-333333333333"
      val journal = DiagnosticLogJournal(context)
      journal.startRun(run)
      val last = File(context.noBackupFilesDir, "diagnostic-journal").listFiles()!!.single()
      RandomAccessFile(last, "rw").use { file ->
        file.seek(file.length())
        file.writeInt(180)
        file.write(ByteArray(6)) // Process killed mid encrypted record.
        file.fd.sync()
      }
      val reopened = DiagnosticLogJournal(context)
      reopened.append(listOf(JSONObject().put("runId", run)
        .put("timestampMs", System.currentTimeMillis())
        .put("level", "warning").put("event", "after.restart")
        .put("message", "Recovered after interruption")))
      val replay = reopened.readRun(run, 0, 100).getJSONArray("items")
      assertEquals(2, replay.length())
      assertEquals("after.restart", replay.getJSONObject(1).getString("event"))
    } finally { context.cleanup() }
  }
}
