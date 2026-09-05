package dev.syncpeer.plugin.android

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream

class SafStorageTest {
  data class Doc(var name: String, var deleted: Boolean = false)

  @Test fun successfulReplacementRetainsNewDocument() {
    val temp = Doc("temp")
    val old = Doc("file")
    finishDocumentReplacement(temp, old, "file", "backup",
      { doc, name -> doc.name = name; true }, { doc -> doc.deleted = true; true })
    assertEquals("file", temp.name)
    assertFalse(temp.deleted)
    assertTrue(old.deleted)
  }

  @Test fun failedReplacementRestoresPreviousDocument() {
    val temp = Doc("temp")
    val old = Doc("file")
    try {
      finishDocumentReplacement(temp, old, "file", "backup",
        { doc, name -> if (doc === temp) false else { doc.name = name; true } },
        { doc -> doc.deleted = true; true })
      fail("Expected replacement failure")
    } catch (_: IllegalStateException) {}
    assertEquals("file", old.name)
    assertFalse(old.deleted)
    assertTrue(temp.deleted)
  }

  @Test fun rangesBeyondOldEndAreCacheMisses() {
    val digests = digestAvailableSafRanges({ ByteArrayInputStream(byteArrayOf(1,2,3)) }, listOf(0L to 2L, 2L to 3L, 8L to 2L))
    assertEquals(1, digests.size)
    assertEquals(0L, digests[0].first)
    assertEquals(2L, digests[0].second)
  }
}
