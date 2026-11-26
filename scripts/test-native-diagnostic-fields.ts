import assert from "node:assert/strict";
import test from "node:test";
import { safeNativeBepDiagnostic, safeNativeDiscoveryDiagnostic, safeNativeTransferDiagnostic } from "../packages/tauri-shell/src/nativeDiagnosticFields.ts";

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
    category: "tls", directCount: 37, relayCount: 2, priorSuccessCount: 0, cooldownCount: 0,
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
    category: "unreachable", directCount: 0, relayCount: 1000, priorSuccessCount: 0, cooldownCount: 0,
    protocol: "unknown", source: "unknown", scope: "unknown", addressFamily: "unknown",
    candidateOrdinal: 1000, durationMs: 120000, timeoutMs: 0,
  });
});

test("download timings persist only bounded counts and fixed stages", () => {
  const safe = safeNativeTransferDiagnostic({
    stage: "blocks_complete", durationMs: 300_000, bytes: 2048,
    totalBytes: 4096, networkBytes: 1024, requestMs: 12_345, maxRequestMs: 2345,
    storageMs: 100, reason: "other", folderId: "personal-folder",
    path: "secret.kdbx", deviceId: "TOPSECRETDEVICEID",
  });
  assert.deepEqual(safe, {
    stage: "blocks_complete", durationMs: 300_000, bytes: 2048, totalBytes: 4096,
    networkBytes: 1024, requestMs: 12_345, maxRequestMs: 2345,
    storageMs: 100, reason: "other",
  });
  assert.equal(safeNativeTransferDiagnostic({ stage: "secret" }), null);
  assert.ok(!JSON.stringify(safe).includes("TOPSECRET"));
  assert.ok(!JSON.stringify(safe).includes("secret.kdbx"));
});

test("native BEP logs distinguish TLS success from failed Hello without leaking endpoints", () => {
  const source = { stage: "hello_exchange", direction: "outgoing", durationMs: 600,
    message: "Connection closed before BEP hello on 192.0.2.42",
    host: "192.0.2.42", remoteDeviceId: "SECRETDEVICEID", password: "SECRET" };
  const saved = safeNativeBepDiagnostic("core.bep.handshake.failed", source);
  assert.deepEqual(saved, { stage: "hello_exchange", direction: "outgoing",
    category: "disconnected", durationMs: 600 });
  for (const secret of ["192.0.2.42", "SECRET"]) assert.ok(!JSON.stringify(saved).includes(secret));
  assert.equal(safeNativeBepDiagnostic("core.bep.handshake.untrusted", source), null);
  assert.equal(safeNativeBepDiagnostic("core.bep.handshake.hello_sent", source)?.stage, "hello_sent");
});

test("BEP handshake stages pass the native bridge and Kotlin allow-list", async () => {
  const { readFileSync } = await import("node:fs");
  const bridge = readFileSync("packages/tauri-shell/src/document-runtime.ts", "utf8");
  const journal = readFileSync("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt", "utf8");
  for (const event of ["core.bep.handshake.peer_cert", "core.bep.handshake.hello_sent",
    "core.bep.handshake.hello_recv", "core.bep.handshake.ready", "core.bep.handshake.failed"]) {
    assert.ok(journal.includes(`"${event}"`), event);
    assert.ok(bridge.includes("safeNativeBepDiagnostic"), event);
  }
});

test("native bridge and Android journal persist anonymized candidate start, winner and failure", async () => {
  const { readFileSync } = await import("node:fs");
  const bridge = readFileSync("packages/tauri-shell/src/document-runtime.ts", "utf8");
  const journal = readFileSync("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt", "utf8");
  const connector = readFileSync("packages/core/src/client.ts", "utf8");
  assert.ok(bridge.includes('"core.discovery.candidate.order"'));
  assert.ok(journal.includes('"core.discovery.candidate.order"'));
  assert.ok(connector.includes('"core.discovery.candidate.order"'));
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

test("Android relay registration retains anonymized native diagnostics", async () => {
  const { readFileSync } = await import("node:fs");
  const bridge = readFileSync("packages/tauri-shell/src/document-runtime.ts", "utf8");
  const journal = readFileSync("packages/tauri-shell/src-tauri/plugins/syncpeer-android/android/src/main/java/dev/syncpeer/plugin/android/DocumentRuntimeService.kt", "utf8");
  for (const event of ["core.relay.registered", "core.relay.announced",
    "core.relay.announcement.failed", "core.relay.presence.failed",
    "core.relay.pool.start", "core.relay.pool.available",
    "core.incoming.context.no_peer", "core.incoming.context.no_approved_peer",
    "core.incoming.relay.enabled", "core.incoming.relay.disabled",
    "core.incoming.listener.reused", "core.incoming.listener.started",
    "core.incoming.prepare.failed", "core.incoming.failed"]) {
    assert.ok(bridge.includes('"' + event + '"'), "TypeScript native relay diagnostic missing " + event);
    assert.ok(journal.includes('"' + event + '"'), "Kotlin native relay diagnostic missing " + event);
  }
  const safe = safeNativeDiscoveryDiagnostic({ message: "Relay timed out at 192.0.2.42",
    deviceId: "TOPSECRETDEVICEID", address: "relay://192.0.2.42:22067" });
  assert.equal(safe.category, "timeout");
  assert.ok(!JSON.stringify(safe).includes("192.0.2.42"));
});

test("native diagnostics separate authorization, TLS, DNS, and transport timeouts", () => {
  for (const [message, expected] of [
    ["Peer is not authorized", "authorization"],
    ["TLS handshake failed", "tls"],
    ["DNS name resolution failed", "dns"],
    ["Dial timed out", "timeout"],
    ["Connection refused", "unreachable"],
    ["Socket disconnected", "disconnected"],
    ["Connection closed; approval may be missing", "disconnected"],
    ["Connection timed out; approval is a first-pairing possibility", "timeout"],
    ["Remote Syncthing reports unknown device", "authorization"],
    ["No candidate message", "other"],
  ] as const) {
    assert.equal(safeNativeDiscoveryDiagnostic({ message }).category, expected, message);
  }
});
