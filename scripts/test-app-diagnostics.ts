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
    }),
  });

test("exposes the complete in-app diagnostics catalog", async () => {
  const catalog = await createFixture().loadDiagnosticsCatalog();

  assert.deepEqual(
    catalog.categories.map((category) => category.id),
    ["core", "pim", "syncthing", "android"],
  );
  assert.deepEqual(
    catalog.tests.map((item) => item.id),
    [
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
