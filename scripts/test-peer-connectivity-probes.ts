import assert from "node:assert/strict";
import test from "node:test";
import { runPeerConnectivityProbes } from "../packages/core/src/ui/peerConnectivityDiagnostics.ts";
import type { SyncpeerHostAdapter, SyncpeerTlsSocket } from "../packages/core/src/client.ts";
import { formatPeerSupportBundle, peerSupportBundleFileName } from "../packages/app/src/app/peerSupportBundle.ts";
import { createAppBuildInfo } from "../packages/core/src/appInfo.ts";

const A = "A".repeat(52);
const B = "B".repeat(52);

const fakeAdapter = (args: {
  globalAddresses?: string[];
  localAddresses?: Array<{ address: string; deviceId: string; protocol: "tcp" | "quic"; host: string; port: number }>;
  globalError?: boolean;
  tlsErrorFor?: string[];
  failFirstTcpFor?: string;
  remoteIdentity?: string;
} = {}) => {
  const opens: string[] = [];
  const closes: string[] = [];
  const socketFor = (host: string): SyncpeerTlsSocket => ({
    read: async () => new Uint8Array(),
    write: async () => {},
    close: async () => { closes.push(host); },
    peerCertificateDer: async () => new TextEncoder().encode(args.remoteIdentity ?? A),
  });
  const adapter: SyncpeerHostAdapter = {
    connectTls: async request => {
      opens.push(`tcp:${request.host}:${request.port}`);
      if (args.failFirstTcpFor === request.host &&
        opens.filter(value => value === `tcp:${request.host}:${request.port}`).length === 1) {
        throw new Error("First direct TCP attempt timed out");
      }
      if (args.tlsErrorFor?.includes(request.host)) throw new Error(`TLS timeout on ${request.host}`);
      return socketFor(request.host);
    },
    connectQuic: async request => {
      opens.push(`quic:${request.host}:${request.port}`);
      if (args.tlsErrorFor?.includes(request.host)) throw new Error(`QUIC transport timeout ${request.host}`);
      return socketFor(request.host);
    },
    connectRelay: async request => {
      opens.push("relay");
      assert.equal(request.expectedDeviceId, A);
      return { socket: socketFor("relay"), connectedVia: request.relayAddress };
    },
    discoveryFetch: async () => {
      if (args.globalError) throw new Error("Lookup for secret endpoint failed (DNS)");
      return {
        ok: true, status: 200,
        json: async () => ({ addresses: args.globalAddresses ?? [] }),
        text: async () => "",
      };
    },
    discoverLocalCandidates: async () => args.localAddresses ?? [],
    sha256: async () => new Uint8Array(32),
    randomBytes: () => new Uint8Array(32),
  };
  return { adapter, opens, closes };
};

const run = async (adapter: SyncpeerHostAdapter, targets = [{ deviceId: A, knownTcp: {
  host: "192.168.5.7", port: 22000,
} }]) => runPeerConnectivityProbes({
  adapter,
  identity: { certPem: "synthetic-cert", keyPem: "synthetic-private-key" },
  targets,
  identifyRemote: async cert => new TextDecoder().decode(cert),
});

test("saved peer diagnostic checks known LAN TCP, discovered LAN, global v4/v6 TCP and QUIC", async () => {
  const { adapter, opens, closes } = fakeAdapter({
    localAddresses: [
      { deviceId: A, address: "tcp://192.168.5.8:22000", protocol: "tcp", host: "192.168.5.8", port: 22000 },
      { deviceId: B, address: "tcp://192.168.5.50:22000", protocol: "tcp", host: "192.168.5.50", port: 22000 },
    ],
    globalAddresses: [
      "tcp://203.0.113.10:22000",
      "tcp://[2001:db8::20]:22000",
      "quic://203.0.113.10:22000",
      "relay://relay.example.invalid/?id=ABCD",
    ],
    tlsErrorFor: ["2001:db8::20"],
  });
  const report = await run(adapter);
  assert.equal(report.savedPeerCount, 1);
  assert.equal(report.peers[0]?.localDiscovery.tcp, 1, "other peers must not be counted");
  assert.deepEqual(report.peers[0]?.attempts.map(item => item.route), [
    "saved-lan-tcp", "saved-lan-tcp", "saved-lan-tcp",
    "discovered-lan-tcp", "global-ipv4-tcp",
    "global-ipv6-tcp", "global-ipv4-quic", "global-relay",
  ]);
  assert.deepEqual(report.peers[0]?.attempts.slice(0, 3).map(item => item.trial), [1, 2, 3]);
  assert.equal(report.peers[0]?.attempts.filter(item => item.outcome === "verified").length, 7);
  assert.equal(report.peers[0]?.attempts[5]?.category, "timeout");
  assert.equal(report.peers[0]?.intermittentDirectTcp, false);
  assert.equal(closes.length, 7, "every opened TLS/QUIC/relay socket must be closed");
  assert.ok(!opens.some(value => value.includes("192.168.5.50")));
  const serialized = JSON.stringify(report);
  for (const secret of ["192.168", "203.0.113", "2001:db8", A, B, "synthetic-private-key"]) {
    assert.ok(!serialized.includes(secret), `the report must not contain ${secret.slice(0, 8)}`);
  }
});

test("identity mismatch is a failed probe, never a success; socket is still closed", async () => {
  const { adapter, closes } = fakeAdapter({ remoteIdentity: B, globalAddresses: [] });
  const report = await run(adapter);
  assert.equal(report.peers[0]?.attempts[0]?.outcome, "failed");
  assert.equal(report.peers[0]?.attempts[0]?.category, "identity");
  assert.equal(closes.length, 3);
});

test("global lookup failure still performs independently configured LAN TCP test", async () => {
  const { adapter, opens } = fakeAdapter({ globalError: true });
  const report = await run(adapter);
  assert.equal(report.peers[0]?.globalDiscovery.status, "failed");
  assert.equal(report.peers[0]?.globalDiscovery.category, "dns");
  assert.deepEqual(report.peers[0]?.attempts.map(item => item.outcome),
    ["verified", "verified", "verified"]);
  assert.deepEqual(opens, Array(3).fill("tcp:192.168.5.7:22000"));
});

test("three direct-TCP attempts surface intermittent failures rather than reporting a clean pass", async () => {
  const { adapter, opens } = fakeAdapter({ failFirstTcpFor: "192.168.5.7" });
  const report = await run(adapter);
  assert.deepEqual(report.peers[0]?.attempts.map(item => item.outcome),
    ["failed", "verified", "verified"]);
  assert.deepEqual(report.peers[0]?.attempts.map(item => item.trial), [1, 2, 3]);
  assert.equal(opens.length, 3);
  assert.equal(report.peers[0]?.intermittentDirectTcp, true);
  assert.equal(report.peers[0]?.attempts[0]?.category, "timeout");
});


test("configured direct and discovered LAN QUIC failures remain visible beside working global QUIC", async () => {
  const { adapter, opens, closes } = fakeAdapter({
    localAddresses: [{
      deviceId: A, address: "quic://192.168.5.8:22000",
      protocol: "quic", host: "192.168.5.8", port: 22000,
    }],
    globalAddresses: ["quic://203.0.113.10:22000"],
    tlsErrorFor: ["192.168.5.7", "192.168.5.8"],
  });
  const report = await run(adapter, [{ deviceId: A,
    configuredQuic: { host: "192.168.5.7", port: 22000 },
  }]);
  assert.deepEqual(report.peers[0]?.attempts.map(item => [item.route, item.outcome]), [
    ["configured-direct-quic", "failed"],
    ["discovered-lan-quic", "failed"],
    ["global-ipv4-quic", "verified"],
  ]);
  assert.deepEqual(opens, ["quic:192.168.5.7:22000", "quic:192.168.5.8:22000",
    "quic:203.0.113.10:22000"]);
  assert.equal(closes.length, 1);
  const serialized = JSON.stringify(report);
  for (const secret of ["192.168.5.7", "192.168.5.8", "203.0.113.10", A]) {
    assert.ok(!serialized.includes(secret), "report exposed a peer or network identifier");
  }
});

test("already authenticated peer gets discovery diagnostics without duplicate TLS, QUIC or relay connections", async () => {
  const { adapter, opens } = fakeAdapter({
    globalAddresses: ["tcp://203.0.113.44:22000", "quic://203.0.113.44:22000"],
    localAddresses: [{ deviceId: A, address: "tcp://192.168.5.7:22000",
      protocol: "tcp", host: "192.168.5.7", port: 22000 }],
  });
  const report = await run(adapter, [{ deviceId: A,
    knownTcp: { host: "192.168.5.7", port: 22000 }, activeSession: true }]);
  assert.equal(report.peers[0]?.activeSessionPreserved, true);
  assert.deepEqual(report.peers[0]?.attempts, []);
  assert.equal(report.peers[0]?.localDiscovery.tcp, 1);
  assert.equal(report.peers[0]?.globalDiscovery.tcp, 1);
  assert.deepEqual(opens, [], "must not open competing sockets to an active peer");
});

test("large saved peer inventories are capped and overflow is explicitly reported", async () => {
  const { adapter } = fakeAdapter();
  const targets = Array.from({ length: 7 }, (_, i) => ({
    deviceId: String.fromCharCode(65 + i).repeat(52),
    knownTcp: { host: "192.168.0.3", port: 22000 },
  }));
  const result = await runPeerConnectivityProbes({
    adapter,
    identity: { certPem: "cert", keyPem: "key" },
    targets, identifyRemote: async () => A,
  });
  assert.equal(result.savedPeerCount, 7);
  assert.equal(result.testedPeerCount, 4);
  assert.equal(result.truncated, true);
});

test("focused support bundle combines sanitized results with current native transport events", () => {
  const info = createAppBuildInfo({
    appVersion: "test", coreVersion: "test", buildCommit: "test",
    buildTimeUtc: "2026-11-18T00:00:00Z", buildMode: "development",
    runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
    platform: "android", architecture: "arm64", osVersion: "synthetic",
  });
  const output = formatPeerSupportBundle(
    info,
    JSON.stringify({ savedPeerCount: 1, leaked: "192.168.5.7", peerId: A,
      peers: [{ peerNumber: 1, attempts: [
        { route: "configured-direct-quic", outcome: "failed", category: "timeout" },
        { route: "saved-lan-tcp", outcome: "verified" },
      ] }] }),
    [{ timestampMs: 1000, level: "info", event: "diagnostics.peer_probe.completed", message: "test done" }],
    [{ timestampMs: 900, level: "error", event: "native.tls.failed", message: "TLS handshake failed 10.3.2.1" }],
    true,
  );
  assert.match(output, /Focused Test Results/);
  assert.match(output, /Current Native Service Diagnostics/);
  assert.match(output, /"route": "configured-direct-quic"/,
    "sanitized report must retain the exact route category that failed");
  assert.match(output, /"route": "saved-lan-tcp"/);
  assert.match(output, /native\.tls\.failed/);
  assert.ok(!output.includes(A));
  assert.ok(!output.includes("192.168.5.7"));
  assert.ok(!output.includes("10.3.2.1"));
  assert.match(peerSupportBundleFileName(new Date("2026-11-18T17:45:00Z")), /^syncpeer-peer-connectivity-.*\.txt$/);
});
