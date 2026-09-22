package dev.syncpeer.plugin.android

import java.io.File
import java.nio.file.Files

internal const val PRIVATE_STORAGE_FORMAT_FILE = ".syncpeer-storage-format.json"
internal const val PRIVATE_STORAGE_UNRECOGNIZED = "SYNCPEER_PRIVATE_STORAGE_UNRECOGNIZED"
private const val privateStorageFormatVersion = 1
private val currentMarker = Regex(
  """\s*\{\s*"owner"\s*:\s*"syncpeer"\s*,\s*"version"\s*:\s*$privateStorageFormatVersion\s*\}\s*""",
)

private fun unrecognizedPrivateStorage(detail: String): Nothing =
  error("$PRIVATE_STORAGE_UNRECOGNIZED: $detail")

private fun markerIsCurrent(marker: File): Boolean {
  if (!marker.exists()) return false
  if (!marker.isFile || Files.isSymbolicLink(marker.toPath())) {
    unrecognizedPrivateStorage("the storage format marker is not a regular file")
  }
  val value = marker.readText()
  return currentMarker.matches(value)
}

internal fun preparePrivateStorageRoot(root: File): File {
  if (root.exists()) {
    if (!root.isDirectory || Files.isSymbolicLink(root.toPath())) {
      unrecognizedPrivateStorage("the private storage root is not a regular directory")
    }
  } else if (!root.mkdirs()) {
    error("Private storage could not be created")
  }
  val marker = root.resolve(PRIVATE_STORAGE_FORMAT_FILE)
  if (markerIsCurrent(marker)) return root
  if (marker.exists() || (root.listFiles() ?: error("Private storage could not be inspected")).isNotEmpty()) {
    unrecognizedPrivateStorage("existing data has no supported storage format marker")
  }
  val temporary = root.resolve(".$PRIVATE_STORAGE_FORMAT_FILE.tmp")
  try {
    check(temporary.createNewFile()) { "Private storage marker could not be created" }
    temporary.writeText("{\"owner\":\"syncpeer\",\"version\":$privateStorageFormatVersion}")
    check(temporary.renameTo(marker)) { "Private storage marker could not be installed" }
  } finally {
    if (temporary.exists()) temporary.delete()
  }
  return root
}

internal fun privateStorageFailureMessage(error: Throwable): String? {
  var current: Throwable? = error
  while (current != null) {
    val message = current.message
    if (message?.contains(PRIVATE_STORAGE_UNRECOGNIZED) == true) {
      return message.substring(message.indexOf(PRIVATE_STORAGE_UNRECOGNIZED))
    }
    current = current.cause
  }
  return null
}
