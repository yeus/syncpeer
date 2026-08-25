import path from "node:path";
import type { Options } from "@wdio/types";

const driverProvider = process.env.SYNCPEER_LAN_DRIVER ?? "embedded";

if (driverProvider !== "embedded" && driverProvider !== "external") {
  throw new Error(
    "SYNCPEER_LAN_DRIVER must be either embedded or external.",
  );
}

export const config = {
  runner: "local",
  specs: [path.resolve(
    process.cwd(),
    process.env.SYNCPEER_LAN_SPEC ?? "scripts/lan-test/spec.ts",
  )],
  maxInstances: 1,
  logLevel: "warn",
  baseUrl: "about:blank",
  services: [
    ["tauri", {
      appBinaryPath: process.env.SYNCPEER_LAN_APP_BINARY,
      driverProvider,
      ...(driverProvider === "external"
        ? { autoInstallTauriDriver: true }
        : {}),
    }],
  ],
  capabilities: [{
    browserName: "tauri",
    "tauri:options": {
      application: process.env.SYNCPEER_LAN_APP_BINARY,
    },
  }],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    timeout: Number(process.env.SYNCPEER_LAN_MOCHA_TIMEOUT ?? 180_000),
  },
} satisfies Options.Testrunner & { capabilities: unknown };
