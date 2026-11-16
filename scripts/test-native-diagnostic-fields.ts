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
  };
  const saved = safeNativeDiscoveryDiagnostic(source);
  assert.deepEqual(saved, {
    category: "tls", directCount: 37, relayCount: 2,
    protocol: "tcp", source: "local", scope: "lan", addressFamily: "ipv4",
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
  });
  assert.deepEqual(saved, {
    category: "unreachable", directCount: 0, relayCount: 1000,
    protocol: "unknown", source: "unknown", scope: "unknown", addressFamily: "unknown",
  });
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
