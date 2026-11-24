package dev.syncpeer.plugin.android

import android.webkit.MimeTypeMap

/** Resolve the visible document name, never the encrypted backing file's name. */
internal fun guessMimeType(fileName: String): String {
  val extension = fileName.substringAfterLast('.', "").lowercase()
  if (extension.isBlank()) return "application/octet-stream"
  return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
    ?: "application/octet-stream"
}
