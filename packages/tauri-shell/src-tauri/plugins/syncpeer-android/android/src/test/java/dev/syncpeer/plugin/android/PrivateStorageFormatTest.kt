package dev.syncpeer.plugin.android

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PrivateStorageFormatTest {
  @Test fun ignoresOtherOwnersInAndroidNoBackupDirectory() {
    val androidRoot = Files.createTempDirectory("syncpeer-android-no-backup").toFile()
    try {
      val webViewFile = androidRoot.resolve(".webview/BrowserMetrics-spare.pma")
      assertTrue(webViewFile.parentFile.mkdirs())
      webViewFile.writeText("synthetic WebView data")
      val root = prepareSyncpeerPrivateStorageRoot(androidRoot)
      assertEquals(androidRoot.resolve("syncpeer"), root)
      assertTrue(root.resolve(PRIVATE_STORAGE_FORMAT_FILE).isFile)
      assertEquals("synthetic WebView data", webViewFile.readText())
      assertEquals(root, prepareSyncpeerPrivateStorageRoot(androidRoot))
    } finally { androidRoot.deleteRecursively() }
  }

  @Test fun preservesPreviousSyncpeerRootUntilConfirmedReset() {
    val androidRoot = Files.createTempDirectory("syncpeer-android-no-backup").toFile()
    try {
      val oldMarker = androidRoot.resolve(PRIVATE_STORAGE_FORMAT_FILE)
      oldMarker.writeText("{\"owner\":\"syncpeer\",\"version\":1}")
      try {
        prepareSyncpeerPrivateStorageRoot(androidRoot)
        fail("Previous Syncpeer data must not silently acquire a new identity")
      } catch (error: IllegalStateException) {
        assertTrue(error.message.orEmpty().startsWith(PRIVATE_STORAGE_UNRECOGNIZED))
      }
      assertTrue(oldMarker.isFile)
      assertTrue(!androidRoot.resolve("syncpeer").exists())
    } finally { androidRoot.deleteRecursively() }
  }

  @Test fun marksAnEmptyRootAndAcceptsItAgain() {
    val root = Files.createTempDirectory("syncpeer-private-storage").toFile()
    try {
      preparePrivateStorageRoot(root)
      preparePrivateStorageRoot(root)
      assertTrue(root.resolve(PRIVATE_STORAGE_FORMAT_FILE).isFile)
    } finally { root.deleteRecursively() }
  }

  @Test fun incompatibleStorageVersionIsActionableAndNeverOverwritten() {
    val root = Files.createTempDirectory("syncpeer-v1-storage").toFile()
    try {
      val marker = root.resolve(PRIVATE_STORAGE_FORMAT_FILE)
      val original = """{"owner":"syncpeer","version":1}"""
      marker.writeText(original)
      val saved = root.resolve("keep-my-config")
      saved.writeText("unchanged")
      try {
        preparePrivateStorageRoot(root)
        fail("Format v1 must not be opened as format v2")
      } catch (error: IllegalStateException) {
        assertTrue(error.message.orEmpty().contains("stored storage format v1 is incompatible with required v2"))
      }
      assertEquals(original, marker.readText())
      assertEquals("unchanged", saved.readText())
    } finally { root.deleteRecursively() }
  }

  @Test fun parallelFirstUsePublishesOneFormatMarker() {
    val androidRoot = Files.createTempDirectory("syncpeer-parallel-no-backup").toFile()
    val executor = java.util.concurrent.Executors.newFixedThreadPool(16)
    try {
      val ready = java.util.concurrent.CountDownLatch(16)
      val go = java.util.concurrent.CountDownLatch(1)
      val tasks = (0 until 16).map {
        executor.submit(java.util.concurrent.Callable {
          ready.countDown()
          go.await()
          prepareSyncpeerPrivateStorageRoot(androidRoot)
        })
      }
      assertTrue(ready.await(10, java.util.concurrent.TimeUnit.SECONDS))
      go.countDown()
      tasks.forEach {
        assertEquals(androidRoot.resolve("syncpeer"), it.get(20, java.util.concurrent.TimeUnit.SECONDS))
      }
      assertTrue(androidRoot.resolve("syncpeer").resolve(PRIVATE_STORAGE_FORMAT_FILE).isFile)
    } finally {
      executor.shutdownNow()
      androidRoot.deleteRecursively()
    }
  }

  @Test fun rejectsAndPreservesUnrecognizedData() {
    val root = Files.createTempDirectory("syncpeer-private-storage").toFile()
    try {
      val existing = root.resolve("unknown-state")
      existing.writeText("synthetic local state")
      try {
        preparePrivateStorageRoot(root)
        fail("Expected unrecognized private storage")
      } catch (error: IllegalStateException) {
        assertTrue(error.message.orEmpty().startsWith(PRIVATE_STORAGE_UNRECOGNIZED))
      }
      assertEquals("synthetic local state", existing.readText())
    } finally { root.deleteRecursively() }
  }

  @Test fun rejectsMalformedMarkerContent() {
    val root = Files.createTempDirectory("syncpeer-private-storage").toFile()
    try {
      root.resolve(PRIVATE_STORAGE_FORMAT_FILE)
        .writeText("not-json {\"owner\":\"syncpeer\",\"version\":1}")
      try {
        preparePrivateStorageRoot(root)
        fail("Expected malformed private storage marker to be rejected")
      } catch (error: IllegalStateException) {
        assertTrue(error.message.orEmpty().startsWith(PRIVATE_STORAGE_UNRECOGNIZED))
      }
    } finally { root.deleteRecursively() }
  }

  @Test fun rejectsSymlinkedRootAndMarker() {
    val parent = Files.createTempDirectory("syncpeer-private-storage")
    try {
      val real = Files.createDirectory(parent.resolve("real")).toFile()
      val linkedRoot = Files.createSymbolicLink(parent.resolve("linked"), real.toPath()).toFile()
      try {
        preparePrivateStorageRoot(linkedRoot)
        fail("Expected a symlinked private root to be rejected")
      } catch (error: IllegalStateException) {
        assertTrue(error.message.orEmpty().startsWith(PRIVATE_STORAGE_UNRECOGNIZED))
      }
      val markerTarget = parent.resolve("marker-target")
      markerTarget.toFile().writeText("{\"owner\":\"syncpeer\",\"version\":1}")
      Files.createSymbolicLink(real.toPath().resolve(PRIVATE_STORAGE_FORMAT_FILE), markerTarget)
      try {
        preparePrivateStorageRoot(real)
        fail("Expected a symlinked format marker to be rejected")
      } catch (error: IllegalStateException) {
        assertTrue(error.message.orEmpty().startsWith(PRIVATE_STORAGE_UNRECOGNIZED))
      }
    } finally { parent.toFile().deleteRecursively() }
  }
}

class DocumentFailureMessagesTest {
  @Test fun mapsDocumentRuntimeRecoveryToPlainMessages() {
    assertEquals(DOCUMENT_RUNTIME_RESTARTING_MESSAGE,
      documentRuntimeFailureMessage("Document runtime is restarting."))
    assertEquals(DOCUMENT_RUNTIME_RESTARTING_MESSAGE,
      documentRuntimeFailureMessage("Document runtime is retrying (2 of 5)."))
    assertEquals(DOCUMENT_RUNTIME_UNAVAILABLE_MESSAGE,
      documentRuntimeFailureMessage("Document runtime could not recover. Reopen Syncpeer to retry."))
    assertEquals("Existing metadata requires its protected key or a confirmed local reset",
      documentRuntimeFailureMessage("Existing metadata requires its protected key or a confirmed local reset"))
    assertEquals(DOCUMENT_RUNTIME_RESTARTING_MESSAGE,
      documentRuntimeFailureMessage("Starting document access…"))
  }

  @Test fun storageFailuresAreClassifiedWithoutPersistingSensitiveExceptionText() {
    assertEquals("protected-metadata-key-missing",
      documentStorageFailureCategory(IllegalStateException(
        "Existing metadata requires its protected key or a confirmed local reset")))
    assertEquals("keystore-alias-missing",
      documentStorageFailureCategory(IllegalStateException("Remembered credential key is missing")))
    assertEquals("protected-secret-decryption",
      documentStorageFailureCategory(javax.crypto.AEADBadTagException("secret /data/private/profile")))
    assertEquals("other",
      documentStorageFailureCategory(IllegalStateException("Private /data/user/0/secret document")))
  }

  @Test fun preservesOnlySafeDocumentCommandFailures() {
    assertEquals(DOCUMENT_RUNTIME_RESTARTING_MESSAGE,
      documentCommandFailureMessage(java.io.FileNotFoundException(DOCUMENT_RUNTIME_RESTARTING_MESSAGE)))
    assertEquals("Document operation failed. Check the vault and Android System WebView.",
      documentCommandFailureMessage(java.io.IOException("Could not open /data/user/0/secret")))
  }
}
