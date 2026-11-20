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

/** Fixed categories only; never persist exception messages containing user paths or secrets. */
internal fun documentStorageFailureCategory(error: Throwable): String {
  val chain = generateSequence(error as Throwable?) { it.cause }.take(5).toList()
  val messages = chain.map { it.message.orEmpty() }
  return when {
    messages.any { it.contains(PRIVATE_STORAGE_UNRECOGNIZED) } -> "unrecognized-private-storage"
    messages.any { it.contains("Existing metadata requires") } -> "protected-metadata-key-missing"
    messages.any { it.contains("Protected metadata key is invalid") } -> "protected-metadata-key-invalid"
    messages.any { it.contains("Remembered credential key is missing") } -> "keystore-alias-missing"
    messages.any { it.contains("Invalid remembered credential") } -> "remembered-secret-invalid"
    chain.any { it.javaClass.simpleName == "AEADBadTagException" } -> "protected-secret-decryption"
    messages.any { it.contains("Replica root is busy", ignoreCase = true) } -> "replica-lock"
    messages.any { it.contains("permission denied", ignoreCase = true) } -> "permission"
    else -> "other"
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
