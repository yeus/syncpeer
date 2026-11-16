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
    ["device", "core", "pim", "syncthing", "android"],
  );
  assert.deepEqual(
    catalog.tests.map((item) => item.id),
    [
      "device.health_snapshot",
      "device.journal_readability",
      "device.transfer_job_status",
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
