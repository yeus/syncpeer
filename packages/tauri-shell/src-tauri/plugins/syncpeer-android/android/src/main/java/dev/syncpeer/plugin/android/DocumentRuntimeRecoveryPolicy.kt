package dev.syncpeer.plugin.android

internal data class DocumentRuntimeRecoveryDecision(
  val retryDelayMs: Long?,
  val failureType: String,
)

private val documentRuntimeRetryDelaysMs = listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L)

internal fun documentRuntimeRecoveryDecision(
  failedAttemptCount: Int,
  error: Throwable,
): DocumentRuntimeRecoveryDecision {
  require(failedAttemptCount > 0) { "The failed runtime attempt count must be positive." }
  if (privateStorageFailureMessage(error) != null) {
    return DocumentRuntimeRecoveryDecision(null, "PrivateStorageUnrecognized")
  }
  return DocumentRuntimeRecoveryDecision(
    retryDelayMs = documentRuntimeRetryDelaysMs.getOrNull(failedAttemptCount - 1),
    failureType = (error.cause ?: error).javaClass.simpleName,
  )
}

internal fun documentRuntimeCanStartSession(
  status: DocumentRuntimeStatus,
  isolateAvailable: Boolean,
): Boolean = status.phase == "locked" && isolateAvailable
