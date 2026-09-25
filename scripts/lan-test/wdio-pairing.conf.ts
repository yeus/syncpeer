import path from "node:path";
import type { Options } from "@wdio/types";

const binary = process.env.SYNCPEER_LAN_APP_BINARY;
if (!binary) throw new Error("SYNCPEER_LAN_APP_BINARY must name the packaged desktop executable.");
const isolatedApp = path.resolve("scripts/lan-test/isolated-app.mjs");
const capability = {
  browserName: "tauri",
  "tauri:options": { application: isolatedApp, args: [path.resolve(binary)] },
};

export const config = {
  runner: "local",
  specs: [path.resolve("scripts/lan-test/packaged-pairing.spec.ts")],
  maxInstances: 1,
  logLevel: "error",
  services: [["tauri", { driverProvider: "external", autoInstallTauriDriver: true }]],
  capabilities: { owner: { capabilities: { ...capability } },
    joiner: { capabilities: { ...capability } } },
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { timeout: 300_000 },
} satisfies Options.Testrunner & { capabilities: unknown };
