import fs from "node:fs";
import path from "node:path";
import {
  nodeScript,
  runTestSuite,
  tsxScript,
  type TestSuitePhase,
} from "./test-suite-runner.ts";

const hasRemoteServer = (): boolean => {
  if (process.env.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim()) return true;
  const clientRoot = path.resolve(
    process.env.SYNCPEER_LAN_CLIENT_ROOT ?? ".tmp/syncpeer-dev-client",
  );
  return fs.existsSync(path.join(clientRoot, "server-device-id"));
};

const remoteApiUrl = (): string | undefined =>
  process.env.SYNCPEER_SYNCTHING_API_URL?.trim() ||
  process.env.SYNCTHING_API_URL?.trim();

const main = async (): Promise<void> => {
  const localArgs = process.env.SYNCPEER_DIAGNOSTICS_KEEP === "1" ? ["--keep"] : [];
  const apiUrl = remoteApiUrl();
  const phases: TestSuitePhase[] = [
    {
      name: "Build core diagnostics target",
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "build:core"],
    },
    {
      name: "CLI help and build",
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "build:cli"],
    },
    {
      name: "CLI help command",
      command: process.execPath,
      args: ["packages/cli/dist/main.js", "--help"],
    },
    {
      ...nodeScript("scripts/test-core-diagnostics.ts"),
      name: "Core protocol, session, and runtime diagnostics",
    },
    {
      ...nodeScript("scripts/release.mjs", ["--check"]),
      name: "Release metadata diagnostics",
    },
    {
      ...nodeScript("scripts/test-local.ts", localArgs),
      name: "Local Syncthing integration diagnostics",
    },
    {
      ...nodeScript("scripts/test-local.ts", ["--skip-encrypted", "--download-iterations", "8", ...localArgs]),
      name: "Local Syncthing repeated-download diagnostics",
    },
    {
      ...tsxScript("scripts/test-pim.ts"),
      name: "PIM model diagnostics",
    },
    {
      ...tsxScript("scripts/test-syncthing-pim-stub.ts"),
      name: "Syncthing PIM layout diagnostics",
    },
    {
      ...tsxScript("scripts/test-syncthing-approval.ts"),
      name: "Syncthing approval API diagnostics",
    },
    {
      ...tsxScript("scripts/test-syncthing-approval-integration.ts"),
      name: "Syncthing approval integration diagnostics",
    },
    {
      ...nodeScript("scripts/test-node-local-discovery-selftest.ts"),
      name: "Node local-discovery packet diagnostics",
    },
    {
      ...nodeScript("scripts/test-node-local-discovery.ts", [
        "--once",
        "--timeout-ms",
        "1200",
        "--idle-log-ms",
        "1200",
      ]),
      name: "Node local-discovery scan diagnostics",
    },
    {
      ...tsxScript("scripts/test-lan-discovery.ts"),
      name: "Delayed LAN discovery diagnostics",
    },
    {
      ...tsxScript("scripts/test-lan-firewall.ts"),
      name: "NixOS firewall helper diagnostics",
    },
    {
      ...nodeScript("scripts/test-tauri-local-discovery.ts"),
      name: "Tauri native discovery diagnostics",
    },
    {
      ...nodeScript("scripts/test-dev-cli.ts"),
      name: "Remote CLI diagnostics",
      skipReason: () => hasRemoteServer()
        ? undefined
        : "no SYNCPEER_DEV_SERVER_DEVICE_ID or saved server-device-id",
    },
    {
      ...nodeScript("scripts/test-syncthing-client-diagnostics.ts", [
        "--api-url",
        apiUrl ?? "",
      ]),
      name: "Syncthing REST API diagnostics",
      skipReason: () => apiUrl
        ? undefined
        : "set SYNCPEER_SYNCTHING_API_URL to enable this external check",
    },
  ];
  const exitCode = await runTestSuite({
    name: "diagnostics",
    reportPath: ".tmp/syncpeer-test-reports/diagnostics-report.json",
    phases,
  });
  process.exitCode = exitCode;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
