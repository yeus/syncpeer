package dev.syncpeer.plugin.android

internal enum class DocumentRuntimeKind { SANDBOX, WEB_VIEW }

internal fun selectDocumentRuntime(
  sandboxSupported: Boolean,
  requiredFeatures: List<String>,
  webCryptoSupported: Boolean,
  featureSupported: (String) -> Boolean,
): DocumentRuntimeKind = if (
  sandboxSupported && webCryptoSupported && requiredFeatures.all(featureSupported)
) DocumentRuntimeKind.SANDBOX else DocumentRuntimeKind.WEB_VIEW
