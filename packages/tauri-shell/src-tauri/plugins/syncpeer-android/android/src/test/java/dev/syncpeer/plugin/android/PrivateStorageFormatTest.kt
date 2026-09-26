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
