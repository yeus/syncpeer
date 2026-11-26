package dev.syncpeer.plugin.android

internal enum class DocumentRuntimeKind { SANDBOX, WEB_VIEW }

/** Use the browser-backed runtime when the isolated engine cannot start.
 * Never turn a failed browser fallback into a successful runtime.
 */
internal fun <T : Any> sandboxOrWebView(
  sandbox: () -> T?,
  webView: () -> T,
  onSandboxFailure: (Exception) -> Unit,
): T {
  val isolated = try {
    sandbox()
  } catch (error: Exception) {
    onSandboxFailure(error)
    null
  }
  return isolated ?: webView()
}

internal fun selectDocumentRuntime(
  sandboxSupported: Boolean,
  requiredFeatures: List<String>,
  webCryptoSupported: Boolean,
  featureSupported: (String) -> Boolean,
): DocumentRuntimeKind = if (
  sandboxSupported && webCryptoSupported && requiredFeatures.all(featureSupported)
) DocumentRuntimeKind.SANDBOX else DocumentRuntimeKind.WEB_VIEW
