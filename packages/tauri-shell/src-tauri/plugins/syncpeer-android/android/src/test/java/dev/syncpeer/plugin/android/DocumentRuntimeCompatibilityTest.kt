package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import java.io.FileNotFoundException
import org.junit.Test

class DocumentRuntimeCompatibilityTest {
  @Test fun aFailedSandboxProviderFallsBackToWebView() {
    var wasReported = false
    val selected = sandboxOrWebView(
      sandbox = { throw FileNotFoundException("synthetic provider startup failure") },
      webView = { DocumentRuntimeKind.WEB_VIEW },
      onSandboxFailure = {
        wasReported = it is FileNotFoundException
      },
    )
    assertEquals(DocumentRuntimeKind.WEB_VIEW, selected)
    assertTrue(wasReported)
  }

  @Test fun aSuccessfulSandboxDoesNotStartWebView() {
    val selected = sandboxOrWebView(
      sandbox = { DocumentRuntimeKind.SANDBOX },
      webView = { error("Unused WebView startup") },
      onSandboxFailure = { error("Unexpected fallback") },
    )
    assertEquals(DocumentRuntimeKind.SANDBOX, selected)
  }

  @Test fun aFailingWebViewIsNotSilentlyAccepted() {
    val failure = runCatching {
      sandboxOrWebView(
        sandbox = { throw FileNotFoundException("synthetic provider startup failure") },
        webView = { error("synthetic WebView failure") },
        onSandboxFailure = {},
      )
    }.exceptionOrNull()
    assertTrue(failure is IllegalStateException)
    assertEquals("synthetic WebView failure", failure?.message)
  }

  @Test fun unavailableSandboxSelectsWebView() {
    assertEquals(
      DocumentRuntimeKind.WEB_VIEW,
      selectDocumentRuntime(false, listOf("message-ports"), true) { true },
    )
  }

  @Test fun missingSandboxFeatureSelectsWebView() {
    assertEquals(
      DocumentRuntimeKind.WEB_VIEW,
      selectDocumentRuntime(true, listOf("promises", "message-ports", "array-buffers"), true) {
        it != "message-ports"
      },
    )
  }

  @Test fun completeCapabilitySetSelectsSandbox() {
    assertEquals(
      DocumentRuntimeKind.SANDBOX,
      selectDocumentRuntime(true, listOf("message-ports"), true) { true },
    )
  }

  @Test fun sandboxWithoutWebCryptoSelectsWebView() {
    assertEquals(
      DocumentRuntimeKind.WEB_VIEW,
      selectDocumentRuntime(true, listOf("message-ports"), false) { true },
    )
  }
}
