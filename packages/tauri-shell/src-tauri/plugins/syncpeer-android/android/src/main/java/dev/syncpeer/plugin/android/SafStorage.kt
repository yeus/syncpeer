package dev.syncpeer.plugin.android

import java.io.EOFException
import java.io.InputStream
import java.security.MessageDigest

internal fun <T> finishDocumentReplacement(
  temporary: T, previous: T?, name: String, backupName: String,
  rename: (T, String) -> Boolean, delete: (T) -> Boolean,
) {
  var committed = false
  var protected = false
  try {
    if (previous != null) {
      if (!rename(previous, backupName)) throw IllegalStateException("Could not protect existing SAF file.")
      protected = true
    }
    if (!rename(temporary, name)) throw IllegalStateException("Could not finalize SAF replacement.")
    committed = true
    if (previous != null && !delete(previous)) throw IllegalStateException("Replacement saved, but backup cleanup failed.")
  } finally {
    if (!committed) {
      delete(temporary)
      if (protected && previous != null && !rename(previous, name)) {
        throw IllegalStateException("Replacement failed; previous content remains in the SAF backup.")
      }
    }
  }
}

internal fun digestAvailableSafRanges(
  open: () -> InputStream, ranges: List<Pair<Long, Long>>,
): List<Triple<Long, Long, ByteArray>> {
  return ranges.mapNotNull { (offset, size) ->
    require(offset >= 0 && size >= 0) { "Invalid SAF range" }
    try {
      val digest = MessageDigest.getInstance("SHA-256")
      open().use { input ->
        var skipped = 0L
        while (skipped < offset) {
          val count = input.skip(offset - skipped)
          if (count > 0) skipped += count
          else if (input.read() < 0) throw EOFException() else skipped++
        }
        val buffer = ByteArray(64 * 1024)
        var remaining = size
        while (remaining > 0) {
          val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
          if (count < 0) throw EOFException()
          digest.update(buffer, 0, count)
          remaining -= count
        }
      }
      Triple(offset, size, digest.digest())
    } catch (_: EOFException) { null }
  }
}
