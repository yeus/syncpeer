package dev.syncpeer.plugin.android

internal fun documentRuntimeCompatibility(
  sandboxSupported: Boolean,
  requiredFeatures: List<String>,
  featureSupported: (String) -> Boolean,
): DocumentRuntimeStatus? {
  if (!sandboxSupported) {
    return DocumentRuntimeStatus(
      "unsupported",
      "Document access needs a supported Android System WebView.",
    )
  }
  val missing = requiredFeatures.filterNot(featureSupported)
  return if (missing.isEmpty()) null else DocumentRuntimeStatus(
    "unsupported",
    "This Android System WebView lacks required document-access capabilities.",
    missing,
  )
}
