package dev.syncpeer.plugin.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DocumentRuntimeCompatibilityTest {
  @Test fun unsupportedSandboxExplainsTheRequiredPlatformCapability() {
    val status = documentRuntimeCompatibility(false, listOf("message-ports")) { true }

    assertEquals("unsupported", status?.phase)
    assertEquals("Document access needs a supported Android System WebView.", status?.summary)
  }

  @Test fun missingFeaturesAreReportedWithoutStartingTheRuntime() {
    val status = documentRuntimeCompatibility(
      true,
      listOf("promises", "message-ports", "array-buffers"),
    ) { it != "message-ports" }

    assertEquals("unsupported", status?.phase)
    assertEquals(listOf("message-ports"), status?.missingFeatures)
    assertEquals(
      "This Android System WebView lacks required document-access capabilities.",
      status?.summary,
    )
  }

  @Test fun completeCapabilitySetAllowsRuntimeStartup() {
    assertNull(documentRuntimeCompatibility(true, listOf("message-ports")) { true })
  }
}
