package dev.syncpeer.plugin.android

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PrivateStorageFormatTest {
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
}
