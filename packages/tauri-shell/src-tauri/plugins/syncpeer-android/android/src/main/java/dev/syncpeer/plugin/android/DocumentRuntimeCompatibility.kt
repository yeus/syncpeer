package dev.syncpeer.plugin.android

internal enum class DocumentRuntimeKind { SANDBOX, WEB_VIEW }

internal fun selectDocumentRuntime(
  sandboxSupported: Boolean,
  requiredFeatures: List<String>,
  featureSupported: (String) -> Boolean,
): DocumentRuntimeKind = if (
  sandboxSupported && requiredFeatures.all(featureSupported)
) DocumentRuntimeKind.SANDBOX else DocumentRuntimeKind.WEB_VIEW
