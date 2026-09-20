package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Test

class DocumentRuntimeCompatibilityTest {
  @Test fun unavailableSandboxSelectsWebView() {
    assertEquals(
      DocumentRuntimeKind.WEB_VIEW,
      selectDocumentRuntime(false, listOf("message-ports")) { true },
    )
  }

  @Test fun missingSandboxFeatureSelectsWebView() {
    assertEquals(
      DocumentRuntimeKind.WEB_VIEW,
      selectDocumentRuntime(true, listOf("promises", "message-ports", "array-buffers")) {
        it != "message-ports"
      },
    )
  }

  @Test fun completeCapabilitySetSelectsSandbox() {
    assertEquals(
      DocumentRuntimeKind.SANDBOX,
      selectDocumentRuntime(true, listOf("message-ports")) { true },
    )
  }
}
