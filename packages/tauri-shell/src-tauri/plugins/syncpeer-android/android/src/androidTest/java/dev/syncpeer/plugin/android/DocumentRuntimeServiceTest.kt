package dev.syncpeer.plugin.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.database.ContentObserver
import android.os.IBinder
import android.provider.DocumentsContract
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assume.assumeTrue
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Starts the runtime from an application Context; no Activity or WebView is created. */
@RunWith(AndroidJUnit4::class)
class DocumentRuntimeServiceTest {
  @Test fun pickerUsesRegisteredEncryptedFilesAndKeystoreWithoutAnActivity() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val client = connect(context)
    try {
      val runtime = client.second.get(15, TimeUnit.SECONDS)
      assumeTrue(runtime.status().get(30, TimeUnit.SECONDS).phase == "locked")
      fun command(operation: String, values: JSONObject = JSONObject()): Any? =
        runtime.command(values.put("operation", operation)).get(30, TimeUnit.SECONDS).opt("result")
      val status = command("status") as JSONObject
      when (status.getJSONObject("vault").getString("phase")) {
        "uninitialized" -> command("createVault", JSONObject().put("password", "synthetic-master"))
        "locked" -> command("unlock", JSONObject().put("password", "synthetic-master"))
      }
      if ((command("status") as JSONObject).getJSONArray("folders").length() == 0) {
        command("register", JSONObject().put("id", "fixture-folder").put("label", "Fixture").put("password", "synthetic-folder-password"))
      }
      val folder = (command("list", JSONObject().put("id", "syncpeer-root")) as JSONArray).getJSONObject(0).getString("id")
      val authority = "${context.packageName}.documents"
      val folderUri = DocumentsContract.buildDocumentUri(authority, folder)
      val resolver = context.contentResolver
      val uri = DocumentsContract.createDocument(resolver, folderUri, "application/octet-stream", "sample-${System.nanoTime()}.bin")!!
      // Exercise large-file I/O once; restart phases focus on persistence, not throughput.
      val expectedSize = if (InstrumentationRegistry.getArguments().getString("documentsRestartPhase") == "seed") 131075 else 4 * 1024 * 1024 + 3
      val expected = ByteArray(expectedSize) { (it % 251).toByte() }
      resolver.openFileDescriptor(uri, "rwt")!!.use { descriptor ->
        java.io.FileOutputStream(descriptor.fileDescriptor).use { output ->
          output.write(expected)
          output.flush()
          output.fd.sync()
        }
      }
      resolver.openInputStream(uri)!!.use { assertArrayEquals(expected, it.readBytes()) }
      command("attachDownloads", JSONObject().put("id", "fixture-folder"))
      val cached = command("cachedFiles") as JSONArray
      assertTrue((0 until cached.length()).any { cached.getJSONObject(it).getLong("sizeBytes") == expected.size.toLong() })
      val downloaded = (command("beginDownload", JSONObject().put("folderId", "fixture-folder")
        .put("path", "downloaded.bin").put("size", 4).put("modifiedMs", 1000)) as Number).toInt()
      command("write", JSONObject().put("handle", downloaded).put("offset", 0).put("bytes", JSONArray(listOf(1, 2, 3, 4))))
      command("finishDownload", JSONObject().put("handle", downloaded))
      val files = command("list", JSONObject().put("id", folder)) as JSONArray
      val downloadedId = (0 until files.length()).map { files.getJSONObject(it) }.first { it.getString("name") == "downloaded.bin" }.getString("id")
      val downloadUri = DocumentsContract.buildDocumentUri(authority, downloadedId)
      resolver.openInputStream(downloadUri)!!.use { assertArrayEquals(byteArrayOf(1, 2, 3, 4), it.readBytes()) }
      val openReader = resolver.openFileDescriptor(uri, "r")!!
      assertTrue(VaultSecretStore(context).execute("documents", "load", null) == "synthetic-master")
      command("lock")
      assertEquals("locked", (command("status") as JSONObject).getJSONObject("vault").getString("phase"))
      try {
        java.io.FileInputStream(openReader.fileDescriptor).use {
          try { it.read(); fail("Locked document remained readable") } catch (_: java.io.IOException) { }
        }
      } finally { openReader.close() }
      command("unlock", JSONObject().put("password", "synthetic-master"))
      resolver.openInputStream(uri)!!.use { assertArrayEquals(expected, it.readBytes()) }
      if (InstrumentationRegistry.getArguments().getString("documentsRestartPhase") == "seed") {
        val interrupted = DocumentsContract.createDocument(resolver, folderUri, "application/octet-stream", "interrupted.bin")!!
        val id = DocumentsContract.getDocumentId(interrupted)
        val pending = (command("open", JSONObject().put("id", id).put("mode", "rwt")) as Number).toInt()
        command("write", JSONObject().put("handle", pending).put("offset", 0).put("bytes", JSONArray(listOf(7, 8, 9))))
        assertEquals(0, (command("stat", JSONObject().put("id", id)) as JSONObject).getInt("size"))
        // No subsequent lock/unlock, fsync or release may recover this in the same runtime.
        // The runner kills the process before opening the next phase.
      }
    } finally { context.unbindService(client.first) }
  }

  @Test fun vaultReopensAfterProcessRestart() {
    val phase = InstrumentationRegistry.getArguments().getString("documentsRestartPhase") ?: return
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val client = connect(context)
    try {
      val runtime = client.second.get(15, TimeUnit.SECONDS)
      fun command(operation: String, values: JSONObject = JSONObject()) =
        runtime.command(values.put("operation", operation)).get(30, TimeUnit.SECONDS).getJSONObject("result")
      val status = command("status")
      assertEquals(if (phase == "locked") "locked" else "unlocked", status.getJSONObject("vault").getString("phase"))
      assertEquals(1, status.getJSONArray("folders").length())
      if (phase != "locked") {
        val folders = runtime.command(JSONObject().put("operation", "list").put("id", "syncpeer-root"))
          .get(30, TimeUnit.SECONDS).getJSONArray("result")
        val files = runtime.command(JSONObject().put("operation", "list").put("id", folders.getJSONObject(0).getString("id")))
          .get(30, TimeUnit.SECONDS).getJSONArray("result")
        assertTrue(files.length() > 0)
        val sample = (0 until files.length()).map { files.getJSONObject(it) }.first { it.getString("name").startsWith("sample-") }
        val uri = DocumentsContract.buildDocumentUri("${context.packageName}.documents", sample.getString("id"))
        context.contentResolver.openInputStream(uri)!!.use { input ->
          assertArrayEquals(ByteArray(131075) { (it % 251).toByte() }, input.readBytes())
        }
        val interrupted = (0 until files.length()).map { files.getJSONObject(it) }.first { it.getString("name") == "interrupted.bin" }
        val recoveredUri = DocumentsContract.buildDocumentUri("${context.packageName}.documents", interrupted.getString("id"))
        context.contentResolver.openInputStream(recoveredUri)!!.use { assertArrayEquals(byteArrayOf(7, 8, 9), it.readBytes()) }
      }
      if (phase == "lock") command("lock")
      if (phase == "locked") command("unlock", JSONObject().put("password", "synthetic-master"))
    } finally { context.unbindService(client.first) }
  }

  @Test fun sharedCoreEncryptsAndReadsAcrossBlocksWithoutAnActivity() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val client = connect(context)
    try {
      val runtime = client.second.get(15, TimeUnit.SECONDS)
      val status = runtime.status().get(30, TimeUnit.SECONDS)
      assumeTrue("Document runtime unavailable: ${status.phase}", status.phase == "locked")
      val content = ByteArray(131075) { (it % 251).toByte() }
      val hashes = JSONArray(listOf(content.copyOfRange(0, 131072), content.copyOfRange(131072, content.size))
        .map { chunk -> JSONArray(MessageDigest.getInstance("SHA-256").digest(chunk).map { it.toInt() and 255 }) })
      val input = JSONObject().put("hashes", hashes).toString().toByteArray(Charsets.UTF_8)
      val result = runtime.evaluate("""
        const core = globalThis.syncpeerDocumentsCore;
        const folder = await core.deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
        const bytes = new Uint8Array(131075).map((_, i) => i % 251);
        const fileInfo = { name: "synthetic-file", type: 0, size: bytes.length,
          blocks: [0, 131072].map((offset, i) => ({offset, size: Math.min(131072, bytes.length-offset), hash: new Uint8Array(input.hashes[i])})) };
        let stored;
        const { sink, encrypted } = await core.createEncryptedDownloadSink({fileInfo, folderKey: folder.folderKey,
          randomBytes: size => new Uint8Array(size).fill(7),
          createSink: async (_, size) => {
            stored = new Uint8Array(size);
            return {write: async (offset, chunk) => stored.set(chunk, offset), commit: async () => {}, abort: async () => {}};
          }});
        await sink.write(0, bytes);
        await sink.commit();
        const source = {size: stored.length, readRange: async (offset, size) => stored.slice(offset, offset+size)};
        const metadata = await core.loadEncryptedDiskMetadata(source, encrypted.name, folder.folderKey);
        try {
          const range = await core.readEncryptedDiskRange(source, metadata, 131070, 5);
          if (!range.every((byte, i) => byte === bytes[131070+i])) throw Error("Range mismatch");
          stored[1] ^= 1;
          let rejected = false;
          try { await core.readEncryptedDiskRange(source, metadata, 0, 4); } catch { rejected = true; }
          if (!rejected) throw Error("Corrupt ciphertext accepted");
          return "verified";
        } finally { metadata.fileKey.fill(0); folder.folderKey.fill(0); }
      """.trimIndent(), input).get(30, TimeUnit.SECONDS)
      assertEquals("verified", result)
    } finally { context.unbindService(client.first) }
  }

  @Test fun applicationClientsShareOneRuntimeWithoutAnActivity() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val first = connect(context)
    val second = connect(context)
    try {
      val a = first.second.get(15, TimeUnit.SECONDS)
      val b = second.second.get(15, TimeUnit.SECONDS)
      assertSame(a, b)
      // Abandoning one caller's request must not cancel shared initialization.
      a.status().cancel(true)
      val status = a.status().get(30, TimeUnit.SECONDS)
      println("Document runtime: ${status.phase}; missing features: ${status.missingFeatures}")
      assertEquals(status, b.status().get(5, TimeUnit.SECONDS))
      assertTrue(status.phase in listOf("locked", "unsupported", "error"))
      assertFalse("Engine initialization failed: ${status.failureType}", status.phase == "error")
      if (status.phase == "locked") {
        assertTrue(status.missingFeatures.isEmpty())
      } else {
        assertTrue(status.summary.isNotBlank())
      }
      if (InstrumentationRegistry.getArguments().getString("requireDocumentRuntime") == "true") {
        assertEquals("Document runtime acceptance requires a supporting WebView", "locked", status.phase)
      }
      // A disappearing UI client must not destroy another caller's runtime.
      context.unbindService(first.first)
      assertEquals(status, b.status().get(5, TimeUnit.SECONDS))
      checkProviderStatus(context, status.summary)
    } finally {
      runCatching { context.unbindService(first.first) }
      context.unbindService(second.first)
    }
  }

  private fun checkProviderStatus(context: Context, expected: String) {
    val roots = DocumentsContract.buildRootsUri("${context.packageName}.documents")
    val changed = CompletableFuture<Unit>()
    val observer = object : ContentObserver(null) {
      override fun onChange(selfChange: Boolean) { changed.complete(Unit) }
    }
    context.contentResolver.registerContentObserver(roots, false, observer)
    try {
      val alreadyReady = context.contentResolver.query(roots, null, null, null, null)!!.use { cursor ->
        cursor.moveToFirst() && cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Root.COLUMN_SUMMARY)) == expected
      }
      if (!alreadyReady) changed.get(15, TimeUnit.SECONDS)
      context.contentResolver.query(roots, null, null, null, null)!!.use { cursor ->
        assertTrue(cursor.moveToFirst())
        assertEquals(expected, cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Root.COLUMN_SUMMARY)))
      }
    } finally {
      context.contentResolver.unregisterContentObserver(observer)
    }
  }

  private fun connect(context: Context): Pair<ServiceConnection, CompletableFuture<DocumentRuntimeService.RuntimeBinder>> {
    val result = CompletableFuture<DocumentRuntimeService.RuntimeBinder>()
    val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, service: IBinder) {
        result.complete(service as DocumentRuntimeService.RuntimeBinder)
      }
      override fun onServiceDisconnected(name: ComponentName) {
        result.completeExceptionally(IllegalStateException("Runtime service disconnected"))
      }
    }
    assertTrue(context.bindService(Intent(context, DocumentRuntimeService::class.java), connection, Context.BIND_AUTO_CREATE))
    return connection to result
  }
}
