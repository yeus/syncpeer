import fs from "node:fs";
import path from "node:path";
import { nodeScript, runTestSuite, type TestSuitePhase } from "./test-suite-runner.ts";

const hasRemoteServer = (): boolean => {
  if (process.env.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim()) return true;
  const clientRoot = path.resolve(
    process.env.SYNCPEER_LAN_CLIENT_ROOT ?? ".tmp/syncpeer-dev-client",
  );
  return fs.existsSync(path.join(clientRoot, "server-device-id"));
};

const main = async (): Promise<void> => {
  const requireExternal = process.env.SYNCPEER_REQUIRE_EXTERNAL_CHECKS === "1";
  const localTauriArgs = process.env.SYNCPEER_E2E_KEEP === "1"
    ? ["--self", "--keep"]
    : ["--self"];
  const phases: TestSuitePhase[] = [
    {
      ...nodeScript("scripts/test-lan.ts", localTauriArgs),
      name: "Local Tauri end-to-end workflows",
      env: { SYNCPEER_LAN_XVFB: "1" },
    },
    {
      ...nodeScript("scripts/test-dev.ts", ["--client", "--ui-smoke"]),
      name: "Remote Tauri UI workflows and in-app diagnostics",
      skipReason: () => hasRemoteServer()
        ? undefined
        : "no SYNCPEER_DEV_SERVER_DEVICE_ID or saved server-device-id",
      required: requireExternal,
    },
    {
      ...nodeScript("scripts/test-lan.ts"),
      name: "Two-host LAN/internet Tauri workflows",
      skipReason: () => process.env.SYNCPEER_RUN_TWO_COMPUTER_E2E === "1"
        ? undefined
        : "set SYNCPEER_RUN_TWO_COMPUTER_E2E=1 to use the two-host harness",
      required: requireExternal,
    },
    {
      name: "Android end-to-end workflows",
      command: process.execPath,
      args: ["scripts/test-android-e2e.mjs"],
      skipReason: () => process.env.SYNCPEER_RUN_ANDROID_E2E === "1"
        ? undefined
        : "set SYNCPEER_RUN_ANDROID_E2E=1 to use the Android harness",
      required: requireExternal,
    },
  ];
  const exitCode = await runTestSuite({
    name: "e2e",
    reportPath: ".tmp/syncpeer-test-reports/e2e-report.json",
    phases,
  });
  process.exitCode = exitCode;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
