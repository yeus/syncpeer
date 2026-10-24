import path from "node:path";
import type { Options } from "@wdio/types";

// The runner wraps WebDriver in a private XDG/D-Bus session; the existing
// external Tauri driver launches the test-built native binary directly.
const binary = path.resolve(process.env.SYNCPEER_UI_DESKTOP_BINARY ??
  "packages/tauri-shell/src-tauri/target/debug/tauri-shell");

export const config = {
  runner: "local",
  specs: [path.resolve(process.env.SYNCPEER_UI_DESKTOP_SPEC ??
    "scripts/lan-test/shared-onboarding.spec.ts")],
  maxInstances: 1,
  logLevel: "warn",
  services: [["tauri", {
    appBinaryPath: binary, driverProvider: "external",
    autoInstallTauriDriver: true,
    captureBackendLogs: true, captureFrontendLogs: true,
  }]],
  capabilities: [{
    browserName: "tauri",
    "tauri:options": { application: binary },
    // Both launcher and worker must select external; otherwise the worker
    // wrongly sends /wdio/eval to the external driver (404).
    "wdio:tauriServiceOptions": { driverProvider: "external", appBinaryPath: binary },
  }],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { timeout: Number(process.env.SYNCPEER_UI_MOCHA_TIMEOUT ?? 180_000),
    ...(process.env.SYNCPEER_UI_GREP
    ? { grep: new RegExp(process.env.SYNCPEER_UI_GREP) } : {}) },
} satisfies Options.Testrunner & { capabilities: unknown };
