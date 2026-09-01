import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { createLanFixture } from "./lan-test/syncthing.ts";
import { buildLanApp, runLanWdio } from "./lan-test/tauri-runner.ts";
import type { PendingSyncthingDevice } from "./lan-test/approval.ts";
import {
  isValidSyncthingDeviceId,
  normalizeDeviceId,
} from "../packages/core/src/ui/helpers.ts";

// The test server prints peer-provided text; replace terminal controls before logging it.
const terminalText = (value: string): string =>
  // eslint-disable-next-line no-control-regex -- intentionally removes terminal controls
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();

const promptForApproval = async (
  device: PendingSyncthingDevice,
  terminal: readline.Interface,
  signal: AbortSignal,
): Promise<"trusted" | "untrusted" | "rejected" | "aborted"> => {
  console.log("Pending client device ID: " + device.deviceId);
  if (device.name) console.log("Device name: " + terminalText(device.name));
  if (device.address) console.log("Observed address: " + terminalText(device.address));
  try {
    const answer = (await terminal.question(
      "Approve as [y] trusted, [u] encrypted-test, or [N] reject? ",
      { signal },
    )).trim().toLowerCase();
    if (answer === "y") return "trusted";
    if (answer === "u") return "untrusted";
    return "rejected";
  } catch (error) {
    if (signal.aborted) return "aborted";
    throw error;
  }
};

const runServer = async (serverRoot: string): Promise<number> => {
  const fixture = await createLanFixture({
    root: serverRoot,
    serverHost: "relay-only",
    mode: "relay",
  });
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const dismissed = new Set<string>();
  let eventId = 0;

  console.log("\nSyncpeer development server is running.");
  console.log("Server device ID: " + fixture.fixture.remoteDeviceId);
  console.log("Syncthing Web UI: " + fixture.syncGuiUrl);
  console.log("Transport: global discovery with relay fallback");
  console.log("Relay selection: Syncthing dynamic relay pool");
  console.log("No inbound firewall port is required for relay traffic.");
  console.log("Waiting for pending clients. Press Ctrl-C to stop.\n");

  try {
    while (!controller.signal.aborted) {
      const pending = await fixture.listPendingDevices();
      for (const device of pending.filter((candidate) => !dismissed.has(candidate.deviceId))) {
        const approval = await promptForApproval(device, terminal, controller.signal);
        if (approval === "aborted") break;
        if (approval === "rejected") {
          dismissed.add(device.deviceId);
          console.log("Client left unapproved.\n");
          continue;
        }
        await fixture.approveDevice({
          deviceId: device.deviceId,
          untrusted: approval === "untrusted",
        });
        console.log(
          (approval === "untrusted" ? "Encrypted test client" : "Trusted client") +
          " approved. The client can reconnect now.\n",
        );
      }
      if (!controller.signal.aborted) {
        try {
          eventId = await fixture.waitForPendingDeviceChange(
            eventId,
            controller.signal,
          );
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
      }
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    terminal.close();
    await fixture.stop();
    console.log("Syncpeer development server stopped. State was preserved at " + serverRoot);
  }
};

const readServerDeviceId = async (clientRoot: string): Promise<string> => {
  fs.mkdirSync(clientRoot, { recursive: true });
  const savedPath = path.join(clientRoot, "server-device-id");
  const configured = process.env.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim() ?? "";
  const saved = fs.existsSync(savedPath) ? fs.readFileSync(savedPath, "utf8").trim() : "";
  let entered = configured;
  if (!entered && !saved) {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      entered = (await terminal.question("Enter the Syncthing server device ID: ")).trim();
    } finally {
      terminal.close();
    }
  }
  const deviceId = normalizeDeviceId(entered || saved);
  if (!isValidSyncthingDeviceId(deviceId)) {
    throw new Error("Expected a valid Syncthing server device ID.");
  }
  fs.writeFileSync(savedPath, deviceId + "\n", { mode: 0o600 });
  return deviceId;
};

const runClient = async (clientRoot: string, uiSmoke = false): Promise<number> => {
  const serverDeviceId = await readServerDeviceId(clientRoot);
  console.log("Using Syncthing server device ID: " + serverDeviceId);
  buildLanApp();
  const configuredHome = process.env.SYNCPEER_DEV_CLIENT_CONFIG_HOME?.trim();
  const clientEnvironment = configuredHome
    ? {
        XDG_CONFIG_HOME: path.resolve(configuredHome),
        SYNCPEER_DEFAULT_IDENTITY_DIR: path.resolve(
          configuredHome,
          "syncpeer",
          "cli-node",
        ),
      }
    : {};
  return runLanWdio({
    SYNCPEER_LAN_SPEC: uiSmoke
      ? "scripts/lan-test/ui-smoke-spec.ts"
      : "scripts/lan-test/dev-spec.ts",
    SYNCPEER_LAN_CLIENT_ROOT: clientRoot,
    SYNCPEER_LAN_MOCHA_TIMEOUT: String((uiSmoke ? 8 : 15) * 60_000),
    SYNCPEER_DEV_SERVER_DEVICE_ID: serverDeviceId,
    ...clientEnvironment,
  });
};

const main = async (): Promise<number> => {
  const serverMode = process.argv.includes("--server");
  const clientMode = process.argv.includes("--client");
  const uiSmokeMode = process.argv.includes("--ui-smoke");
  if (serverMode === clientMode) {
    throw new Error("Choose exactly one of --server or --client.");
  }
  if (uiSmokeMode && !clientMode) {
    throw new Error("The --ui-smoke option requires --client.");
  }
  if (serverMode) {
    const serverRoot = path.resolve(
      process.env.SYNCPEER_DEV_SERVER_ROOT ?? ".tmp/syncpeer-dev-server",
    );
    return runServer(serverRoot);
  }
  const clientRoot = path.resolve(
    process.env.SYNCPEER_DEV_CLIENT_ROOT ?? ".tmp/syncpeer-dev-client",
  );
  return runClient(clientRoot, uiSmokeMode);
};

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
