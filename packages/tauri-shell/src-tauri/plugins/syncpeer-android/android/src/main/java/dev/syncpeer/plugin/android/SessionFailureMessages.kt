package dev.syncpeer.plugin.android

/** The provider marks app-authored session failures so the plugin can preserve them. */
internal const val SESSION_FAILURE_PREFIX = "SYNCPEER_SESSION_FAILURE:"

internal fun prefixedSessionFailure(message: String): String = "$SESSION_FAILURE_PREFIX$message"

internal fun prefixedSessionFailureText(message: String?): String? {
  val value = message?.trim() ?: return null
  if (!value.startsWith(SESSION_FAILURE_PREFIX)) return null
  return value.removePrefix(SESSION_FAILURE_PREFIX).trim().takeIf { it.isNotEmpty() }
}

/** Map a raw session error to a plain, user-safe reason. */
internal fun safeSessionError(error: Throwable): String {
  val text = generateSequence(error as Throwable?) { it.cause }
    .mapNotNull { it.message }
    .joinToString(" ")
  return when {
    Regex("connection attempt was cancelled|signal is aborted", RegexOption.IGNORE_CASE)
      .containsMatchIn(text) -> "The previous connection attempt was cancelled. Try again."
    Regex("restarting its local storage service|document runtime", RegexOption.IGNORE_CASE)
      .containsMatchIn(text) -> "Syncpeer is restarting its local storage service. Try again in a moment."
    Regex("not authorized|approval|unknown device|not in config|not configured", RegexOption.IGNORE_CASE)
      .containsMatchIn(text) -> "The other device has not approved this device yet."
    Regex("timeout|timed out", RegexOption.IGNORE_CASE)
      .containsMatchIn(text) -> "The peer connection timed out. Try again."
    text.contains("No service-owned peer session", ignoreCase = true) ->
      "The peer session is not connected. Try again."
    else -> "Peer connection could not be established."
  }
}
