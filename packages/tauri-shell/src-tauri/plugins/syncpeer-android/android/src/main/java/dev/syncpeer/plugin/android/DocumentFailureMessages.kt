package dev.syncpeer.plugin.android

/** User-facing text for a transient document-runtime restart. */
internal const val DOCUMENT_RUNTIME_RESTARTING_MESSAGE =
  "Syncpeer is restarting its local storage service. Try again in a moment."

/** User-facing text when automatic recovery gave up. */
internal const val DOCUMENT_RUNTIME_UNAVAILABLE_MESSAGE =
  "Syncpeer could not restart its local storage service. Reopen Syncpeer to retry."

private const val DOCUMENT_RUNTIME_UNKNOWN_MESSAGE =
  "Syncpeer's local storage service is unavailable. Reopen Syncpeer to retry."

/**
 * Only app-authored summaries may reach the UI. Arbitrary exception text can
 * contain storage paths, file names or credential material.
 */
private val safeDocumentFailureMessages = setOf(
  DOCUMENT_RUNTIME_RESTARTING_MESSAGE,
  DOCUMENT_RUNTIME_UNAVAILABLE_MESSAGE,
  DOCUMENT_RUNTIME_UNKNOWN_MESSAGE,
  "Document runtime unavailable.",
)

/** Translate a native runtime status into a safe, plain-language failure. */
internal fun documentRuntimeFailureMessage(summary: String): String {
  val text = summary.trim()
  return when {
    text.contains(PRIVATE_STORAGE_UNRECOGNIZED) -> text
    text.contains("Existing metadata requires") -> text
    text.contains("Protected metadata key is invalid") -> text
    text.contains("is restarting", ignoreCase = true) ||
      text.startsWith("Document runtime is retrying") ||
      text.startsWith("Starting document access") ||
      text == "Document runtime unavailable." -> DOCUMENT_RUNTIME_RESTARTING_MESSAGE
    text.contains("could not recover", ignoreCase = true) -> DOCUMENT_RUNTIME_UNAVAILABLE_MESSAGE
    else -> DOCUMENT_RUNTIME_UNKNOWN_MESSAGE
  }
}

/** Preserve a safe app-authored cause; never forward arbitrary exception text. */
internal fun documentCommandFailureMessage(error: Throwable): String {
  privateStorageFailureMessage(error)?.let { return it }
  var current: Throwable? = error
  while (current != null) {
    val message = current.message?.trim()
    if (message != null && message in safeDocumentFailureMessages) return message
    current = current.cause
  }
  return "Document operation failed. Check the vault and Android System WebView."
}
