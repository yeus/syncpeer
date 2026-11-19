import assert from "node:assert/strict";
import test from "node:test";
import { safeNativeDiscoveryDiagnostic } from "../packages/tauri-shell/src/nativeDiagnosticFields.ts";

test("native diagnostics retain transport provenance without personal or network identifiers", () => {
  const source = {
    message: "TLS certificate mismatch for secret token at 192.0.2.42",
    address: "tcp://192.0.2.42:22000",
    host: "192.0.2.42",
    deviceId: "TOPSECRETDEVICEID",
    password: "TOPSECRETPASSWORD",
    protocol: "tcp", source: "local", scope: "lan", addressFamily: "ipv4",
    directCandidateCount: 37, relayCandidateCount: 2,
    candidateOrdinal: 12, durationMs: 2149, timeoutMs: 2500,
  };
  const saved = safeNativeDiscoveryDiagnostic(source);
  assert.deepEqual(saved, {
    category: "tls", directCount: 37, relayCount: 2,
    protocol: "tcp", source: "local", scope: "lan", addressFamily: "ipv4",
    candidateOrdinal: 12, durationMs: 2149, timeoutMs: 2500,
  });
  const serialized = JSON.stringify(saved);
  for (const secret of ["192.0.2.42", "TOPSECRETDEVICEID", "TOPSECRETPASSWORD", "token"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("untrusted candidate labels cannot leak into persistent Android logs", () => {
  const saved = safeNativeDiscoveryDiagnostic({
    message: "Host unreachable",
    protocol: "tcp://secret",
    source: "user@example.com",
    scope: "private:192.168.1.1",
    addressFamily: "192.0.2.1",
    directCandidateCount: Number.POSITIVE_INFINITY, relayCandidateCount: 3000,
    candidateOrdinal: 100000, durationMs: 200000, timeoutMs: -500,
  });
  assert.deepEqual(saved, {
    category: "unreachable", directCount: 0, relayCount: 1000,
    protocol: "unknown", source: "unknown", scope: "unknown", addressFamily: "unknown",
    candidateOrdinal: 1000, durationMs: 120000, timeoutMs: 0,
  });
});

test("native bridge and Android journal persist anonymized candidate start, winner and failure", async () => {
  const { readFileSync } = await import("node:fs");
  const bridge = readFileSync("packages/tauri-shell/src/document-runtime.ts", "utf8");
  const journal = readFileSync("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt", "utf8");
  const connector = readFileSync("packages/core/src/client.ts", "utf8");
  for (const event of ["core.discovery.candidate.try", "core.discovery.candidate.connected", "core.discovery.candidate.failed"]) {
    assert.ok(bridge.includes(`"${event}"`));
    assert.ok(journal.includes(`"${event}"`));
    assert.ok(connector.includes(`"${event}"`));
  }
  for (const field of ["candidateOrdinal", "durationMs", "timeoutMs"]) {
    assert.ok(journal.includes(`.put("${field}"`));
  }
  const directMode = connector.slice(connector.indexOf("async function openDirectMode("),
    connector.indexOf("async function openWithDiscoveryRetry("));
  assert.match(directMode, /core\.discovery\.candidate\.try/);
  assert.match(directMode, /core\.discovery\.candidate\.connected/);
  assert.match(directMode, /core\.discovery\.candidate\.failed/);
});

test("native diagnostics separate authorization, TLS, DNS, and transport timeouts", () => {
  for (const [message, expected] of [
    ["Peer is not authorized", "authorization"],
    ["TLS handshake failed", "tls"],
    ["DNS name resolution failed", "dns"],
    ["Dial timed out", "timeout"],
    ["Connection refused", "unreachable"],
    ["Socket disconnected", "disconnected"],
    ["No candidate message", "other"],
  ] as const) {
    assert.equal(safeNativeDiscoveryDiagnostic({ message }).category, expected, message);
  }
});
