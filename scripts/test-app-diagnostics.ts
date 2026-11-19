import assert from "node:assert/strict";
import test from "node:test";
import {
  createAppBuildInfo,
  type SyncpeerBrowserClient,
} from "../packages/core/src/browser.ts";
import { createDiagnosticsActions } from "../packages/app/src/app/diagnosticsActions.ts";
import { createInitialState } from "../packages/app/src/app/state.ts";

const createFixture = () =>
  createDiagnosticsActions({
    state: createInitialState(null),
    client: {} as SyncpeerBrowserClient,
    appInfo: createAppBuildInfo({
      appVersion: "test",
      coreVersion: "test",
      buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z",
      buildMode: "development",
      runtimeEnvironment: "node",
      runtimeSurface: "web-ui",
      platform: "linux",
      architecture: "x64",
      osVersion: "synthetic-os-version",
    }),
  });

test("exposes the complete in-app diagnostics catalog", async () => {
  const catalog = await createFixture().loadDiagnosticsCatalog();

  assert.deepEqual(
    catalog.categories.map((category) => category.id),
    ["device", "network", "core", "pim", "syncthing", "android"],
  );
  assert.deepEqual(
    catalog.tests.map((item) => item.id),
    [
      "device.health_snapshot",
      "device.journal_readability",
      "device.transfer_job_status",
      "network.saved_peer_paths",
      "core.folder_diagnostics",
      "pim.canonical_paths",
      "pim.vcf_roundtrip",
      "pim.ics_roundtrip",
      "syncthing.pim_favorite_cached",
      "syncthing.pim_write_read_probe",
      "android.contacts_list_smoke",
      "android.calendar_list_smoke",
      "android.transfer_runtime_command",
    ],
  );
});

test("runs a selected diagnostics definition", async () => {
  const report = await createFixture().runDiagnosticsTestById(
    "pim.vcf_roundtrip",
  );

  assert.equal(report.summary.mode, "single");
  assert.equal(report.summary.testId, "pim.vcf_roundtrip");
  assert.equal(report.summary.allPassed, true);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]?.ok, true);
});

test("rejects an unknown diagnostics identifier", async () => {
  await assert.rejects(
    createFixture().runDiagnosticsTestById("missing"),
    /Unknown diagnostics test: missing/,
  );
});

test("focused peer diagnostic uses saved peers (selected first) without altering live session or settings", async () => {
  const A = "A".repeat(52);
  const B = "B".repeat(52);
  const state = createInitialState(null);
  state.devices.savedDevices = [A, B].map(id => ({
    id, name: id.slice(0, 1), createdAtMs: Date.now(), isIntroducer: false,
  }));
  state.devices.selectedSavedDeviceId = B;
  state.connection.remoteId = A;
  state.connection.discoveryMode = "automatic";
  state.connection.host = "192.168.10.22";
  state.session.isConnected = true;
  const original = JSON.stringify({ connection: state.connection, session: state.session });
  const invoked: string[] = [];
  const progress: string[] = [];
  const client = {
    probeSavedPeerConnectivity: async (targets: Array<{ deviceId: string }>, _server: string,
      onProgress: (peer: number, stage: string) => void) => {
      assert.deepEqual(targets.map(target => target.deviceId), [B, A]);
      invoked.push("probe");
      onProgress(1, "global-discovery");
      return {
        savedPeerCount: 2, testedPeerCount: 2, truncated: false,
        scope: "isolated-transport-and-tls-identity" as const, note: "synthetic",
        peers: [1, 2].map(peerNumber => ({
          peerNumber, localDiscovery: { tcp: 0, quic: 0, relay: 0, status: "ok" as const },
          globalDiscovery: { tcp: 1, quic: 0, relay: 0, status: "ok" as const },
          attempts: [{ path: "global-ipv4-tcp" as const,
            outcome: peerNumber === 1 ? "verified" as const : "failed" as const,
            durationMs: 50, category: peerNumber === 2 ? "timeout" : undefined }],
        })),
      };
    },
    disconnect: () => { throw new Error("Must not disconnect the live session"); },
    connectAndSync: () => { throw new Error("Must not adopt a new BEP session"); },
  } as unknown as SyncpeerBrowserClient;
  const actions = createDiagnosticsActions({
    state, client,
    appInfo: createAppBuildInfo({
      appVersion: "test", coreVersion: "test", buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z", buildMode: "development",
      runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
      platform: "android", architecture: "arm64", osVersion: "synthetic",
    }),
  });
  const report = await actions.runDiagnosticsTestById("network.saved_peer_paths", {
    onProgress: (peerNumber, stage) => progress.push(`${peerNumber}:${stage}`),
  });
  assert.equal(report.summary.allPassed, false);
  assert.equal(report.summary.failed, 1);
  assert.deepEqual(invoked, ["probe"]);
  assert.deepEqual(progress, ["1:global-discovery"]);
  assert.equal(JSON.stringify({ connection: state.connection, session: state.session }), original);
  assert.ok(!JSON.stringify(report).includes(A));
  assert.ok(!JSON.stringify(report).includes(B));
});

test("saved peer diagnosis marks active native session to avoid competing socket probes", async () => {
  const id = "A".repeat(52);
  const state = createInitialState(null);
  state.devices.savedDevices = [{
    id, name: "Server", createdAtMs: 1, isIntroducer: false,
  }];
  state.session.isConnected = true;
  state.session.activeConnectDeviceId = id;
  const client = {
    probeSavedPeerConnectivity: async (targets: Array<{ deviceId: string; activeSession?: boolean }>) => {
      assert.deepEqual(targets.map(target => ({
        deviceId: target.deviceId, activeSession: target.activeSession,
      })), [{ deviceId: id, activeSession: true }]);
      return {
        savedPeerCount: 1, testedPeerCount: 1, truncated: false,
        scope: "isolated-transport-and-tls-identity" as const, note: "synthetic",
        peers: [{ peerNumber: 1, attempts: [], activeSessionPreserved: true,
          intermittentDirectTcp: false, localDiscovery: { tcp: 1, quic: 0, relay: 0, status: "ok" },
          globalDiscovery: { tcp: 1, quic: 0, relay: 0, status: "ok" } }],
      };
    },
  } as unknown as SyncpeerBrowserClient;
  const actions = createDiagnosticsActions({
    state, client,
    appInfo: createAppBuildInfo({
      appVersion: "test", coreVersion: "test", buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z", buildMode: "development",
      runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
      platform: "android", architecture: "arm64", osVersion: "synthetic",
    }),
  });
  const report = await actions.runDiagnosticsTestById("network.saved_peer_paths");
  assert.equal(report.summary.allPassed, true);
  assert.equal(report.summary.failed, 0);
  assert.equal(state.session.isConnected, true);
});

test("peer diagnosis with no saved devices skips safely without touching sockets", async () => {
  const report = await createFixture().runDiagnosticsTestById("network.saved_peer_paths");
  assert.equal(report.summary.failed, 0);
  assert.deepEqual(report.results[0]?.details, {
    skipped: true, reason: "No saved peers configured.",
  });
});

test("one-tap Android peer diagnostics shares same-run native logs and never requires manual peer settings", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync("packages/app/src/DiagnosticsPage.svelte", "utf8");
  const app = readFileSync("packages/app/src/App.svelte", "utf8");
  assert.match(page, /data-testid="diagnostics-run-peer-connectivity"/);
  assert.match(page, /onRunTest\("network\.saved_peer_paths"/);
  assert.match(page, /onSharePeerSupportBundle\(resultJson\)/);
  assert.match(app, /readCurrentNativeTrace\(\)/);
  assert.match(app, /onSharePeerSupportBundle=\{logFile\?\.share \? sharePeerSupportBundle : undefined\}/);
});

test("core folder diagnostics do not dial, disconnect or mutate while connection is pending", async () => {
  const calls: string[] = [];
  const client = {
    disconnect: async () => { calls.push("disconnect"); },
    connectAndSync: async () => { calls.push("connectAndSync"); throw new Error("unexpected dial"); },
    connectAndGetOverview: async () => { calls.push("connectAndGetOverview"); throw new Error("unexpected overview"); },
  } as unknown as SyncpeerBrowserClient;
  const state = createInitialState(null);
  const actions = createDiagnosticsActions({
    state, client,
    appInfo: createAppBuildInfo({
      appVersion: "test", coreVersion: "test", buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z", buildMode: "development",
      runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
      platform: "android", architecture: "arm64", osVersion: "synthetic",
    }),
  });
  const report = await actions.runDiagnosticsTestById("core.folder_diagnostics");
  assert.equal(report.summary.failed, 1);
  assert.deepEqual(calls, []);
  const details = JSON.stringify(report.results[0]?.details);
  assert.match(details, /No active authenticated peer session/);
});

test("phone health diagnostics are read-only and report journal availability", async () => {
  let healthCalls = 0;
  let journalCalls = 0;
  const actions = createDiagnosticsActions({
    state: createInitialState(null),
    client: {} as SyncpeerBrowserClient,
    appInfo: createAppBuildInfo({
      appVersion: "test", coreVersion: "test", buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z", buildMode: "development",
      runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
      platform: "android", architecture: "arm64", osVersion: "synthetic",
    }),
    readDeviceHealth: async () => { healthCalls++; return { batteryPercent: 65, deviceIdle: false }; },
    readDiagnosticJournal: async () => { journalCalls++; return {
      writeInitialized: true, runCount: 2, queued: 0,
    }; },
  });
  const result = await actions.runDiagnosticsCategory("device");
  assert.equal(result.summary.failed, 0);
  assert.equal(healthCalls, 1);
  assert.equal(journalCalls, 1);
});

test("uninitialized phone journal is reported as a diagnostic failure", async () => {
  const state = createInitialState(null);
  const actions = createDiagnosticsActions({
    state, client: {} as SyncpeerBrowserClient,
    appInfo: createAppBuildInfo({
      appVersion: "test", coreVersion: "test", buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z", buildMode: "development",
      runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
      platform: "android", architecture: "arm64", osVersion: "synthetic",
    }),
    readDiagnosticJournal: async () => ({ writeInitialized: false, runCount: 0, queued: 5 }),
  });
  const result = await actions.runDiagnosticsTestById("device.journal_readability");
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.allPassed, false);
});
test("native transfer diagnostics report phases without exporting file names or peer identities", async () => {
  const peerId = "A".repeat(52);
  const actions = createDiagnosticsActions({
    state: createInitialState(null),
    client: {
      listServiceTransferJobs: async () => [
        {
          id: "11111111-1111-1111-1111-111111111111", direction: "upload",
          folderId: "secret-folder", path: "private/photo.jpg", peerId,
          phase: "failed", reason: "network", attempts: 2, transferredBytes: 1024,
          totalBytes: 2048, updatedAtMs: 42,
        },
      ],
    } as unknown as SyncpeerBrowserClient,
    appInfo: createAppBuildInfo({
      appVersion: "test", coreVersion: "test", buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z", buildMode: "development",
      runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
      platform: "android", architecture: "arm64", osVersion: "synthetic",
    }),
  });
  const report = await actions.runDiagnosticsTestById("device.transfer_job_status");
  assert.equal(report.summary.failed, 0);
  const text = JSON.stringify(report);
  assert.match(text, /"failed":1/);
  assert.match(text, /"reason":"network"/);
  for (const sensitive of ["photo.jpg", "secret-folder", peerId, "11111111-1111"]) {
    assert.equal(text.includes(sensitive), false, "Native job report must not contain sensitive identifiers.");
  }
});
