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

  @Test fun fullDigestReadsTheCurrentFileLength() {
    val digest = digestSafFile { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
    assertArrayEquals(
      byteArrayOf(0x03, 0x90.toByte(), 0x58, 0xC6.toByte(), 0xF2.toByte(), 0xC0.toByte(), 0xCB.toByte(), 0x49,
        0x2C, 0x53, 0x3B, 0x0A, 0x4D, 0x14, 0xEF.toByte(), 0x77,
        0xCC.toByte(), 0x0F, 0x78, 0xAB.toByte(), 0xCC.toByte(), 0xCE.toByte(), 0xD5.toByte(), 0x28,
        0x7D, 0x84.toByte(), 0xA1.toByte(), 0xA2.toByte(), 0x01, 0x1C, 0xFB.toByte(), 0x81.toByte()),
      digest,
    )
  }
}
