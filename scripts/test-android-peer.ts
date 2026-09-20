import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { create, emulatorArguments, profile } from "./android-emulator.mjs";
import {
  adb,
  run,
  stopEmulator,
  uninstallIfPresent,
  waitForBoot,
} from "./test-android.mjs";
import { createLanFixture } from "./lan-test/syncthing.ts";

const appPackage = "dev.syncpeer.app";
const editorPackage = "dev.syncpeer.synthetic.editor";
const appApk = "packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk";
const editorApk = "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/build/outputs/apk/debug/syncpeer-document-editor-debug.apk";
const peerApiLevel = 29;

const startEmulator = async (): Promise<ChildProcess> => {
  const selected = profile("compat");
  create(selected);
  const child = spawn("emulator", emulatorArguments(selected, ["-no-snapshot"]), {
    stdio: "ignore",
  });
  await waitForBoot(child, selected.avdName);
  return child;
};

const killEmulatorAbruptly = async (child: ChildProcess): Promise<void> => {
  child.kill("SIGKILL");
  const deadline = Date.now() + 30_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Android emulator did not terminate after SIGKILL.");
  }
  const deviceDeadline = Date.now() + 30_000;
  while (Date.now() < deviceDeadline) {
    if (!adb(["devices"]).split("\n").some((line) => /\sdevice(?:\s|$)/.test(line))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Abruptly terminated emulator remained visible to adb.");
};

const runPhase = (phase: string, env: NodeJS.ProcessEnv): void => {
  run(process.execPath, ["scripts/test-android-e2e.mjs", "--expect-sdk", String(peerApiLevel), phase], { env });
};

const waitForHostIndex = async (guiUrl: string, apiKey: string, folderId: string, minimumBytes: number) => {
  const url = `${guiUrl}/rest/db/status?folder=${encodeURIComponent(folderId)}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (!response.ok) throw new Error(`Host Syncthing status failed: ${response.status}.`);
    const database = await response.json() as { localBytes?: number };
    if (Number(database.localBytes ?? 0) >= minimumBytes) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Host Syncthing did not index the large transfer fixture.");
};

const peerOutBytes = async (guiUrl: string, apiKey: string): Promise<number> => {
  const response = await fetch(`${guiUrl}/rest/system/connections`, {
    headers: { "X-API-Key": apiKey },
  });
  if (!response.ok) throw new Error(`Host Syncthing connections failed: ${response.status}.`);
  const result = await response.json() as {
    connections?: Record<string, { outBytesTotal?: number }>;
  };
  const connections = Object.values(result.connections ?? {});
  if (connections.length !== 1) {
    throw new Error(`Expected one synthetic Syncthing peer, found ${connections.length}.`);
  }
  return Number(connections[0].outBytesTotal ?? 0);
};

const waitForPeerTransfer = async (
  guiUrl: string,
  apiKey: string,
  startingBytes: number,
): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await peerOutBytes(guiUrl, apiKey) - startingBytes >= 512 * 1024) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Android headless replica did not begin the large-file transfer.");
};

const setPeerPaused = async (guiUrl: string, apiKey: string, paused: boolean): Promise<void> => {
  const state = await fetch(`${guiUrl}/rest/system/connections`, {
    headers: { "X-API-Key": apiKey },
  });
  if (!state.ok) throw new Error(`Host Syncthing connections failed: ${state.status}.`);
  const result = await state.json() as { connections?: Record<string, unknown> };
  const deviceIds = Object.keys(result.connections ?? {});
  if (deviceIds.length !== 1) {
    throw new Error(`Expected one synthetic Syncthing connection, found ${deviceIds.length}.`);
  }
  const operation = paused ? "pause" : "resume";
  const response = await fetch(
    `${guiUrl}/rest/system/${operation}?device=${encodeURIComponent(deviceIds[0])}`,
    { method: "POST", headers: { "X-API-Key": apiKey } },
  );
  if (!response.ok) throw new Error(`Host Syncthing peer ${operation} failed: ${response.status}.`);
};

const main = async (): Promise<void> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-android-peer-"));
  let emulator: ChildProcess | null = null;
  let fixture: Awaited<ReturnType<typeof createLanFixture>> | null = null;
  try {
    emulator = await startEmulator();
    uninstallIfPresent(editorPackage);
    uninstallIfPresent("dev.syncpeer.plugin.android.test");
    uninstallIfPresent(appPackage);
    run("adb", ["install", "-r", appApk]);
    run("adb", ["install", "-r", editorApk]);

    const deviceIdPath = path.join(root, "android-device-id");
    run(process.execPath, [
      "scripts/test-android-e2e.mjs", "--expect-sdk", String(peerApiLevel), "--write-device-id", deviceIdPath,
    ]);
    const deviceId = fs.readFileSync(deviceIdPath, "utf8").trim();
    const runtimeProbePath = path.join(root, "document-runtime-capability");
    run(process.execPath, [
      "scripts/test-android-e2e.mjs", "--expect-sdk", String(peerApiLevel),
      "--probe-document-runtime", runtimeProbePath,
    ]);
    if (fs.readFileSync(runtimeProbePath, "utf8").trim() !== "supported") {
      console.log(
        "Android real-peer acceptance skipped: the managed WebView lacks " +
        "JS_FEATURE_MESSAGE_PORTS required by the document runtime.",
      );
      return;
    }
    fixture = await createLanFixture({
      root: path.join(root, "host"),
      serverHost: "10.0.2.2",
      untrustedDeviceId: deviceId,
      mode: "direct",
      encryptedFolderType: "sendreceive",
      includeBlob: false,
    });
    // The ordinary Android transfer suite covers 128 MiB. This fixture stays
    // smaller so it can prove multi-block journal recovery plus a full
    // DocumentsProvider hash within emulator time limits.
    const largeFileSize = 4 * 1024 * 1024;
    const env = {
      ...process.env,
      SYNCPEER_DEV_SERVER_DEVICE_ID: fixture.fixture.remoteDeviceId,
      SYNCPEER_ANDROID_DISCOVERY_MODE: "direct",
      SYNCPEER_ANDROID_DIRECT_HOST: "10.0.2.2",
      SYNCPEER_ANDROID_DIRECT_PORT: String(fixture.fixture.directPort),
      SYNCPEER_E2E_FOLDER_ID: fixture.fixture.encryptedFolderId,
      SYNCPEER_E2E_FOLDER_TITLE: fixture.fixture.encryptedFolderId,
      SYNCPEER_E2E_FOLDER_PASSWORD: fixture.fixture.encryptedPassword,
      SYNCPEER_E2E_FILE_NAME: fixture.fixture.encryptedExpected.path,
      SYNCPEER_E2E_LARGE_FILE_SIZE: String(largeFileSize),
      SYNCPEER_PEER_HOST_FOLDER: fixture.encryptedSharePath,
      SYNCPEER_PEER_GUI_URL: fixture.syncGuiUrl,
      SYNCPEER_PEER_API_KEY: fixture.apiKey,
    };

    runPhase("--peer-cross-app", env);
    const startingPeerOutBytes = await peerOutBytes(fixture.syncGuiUrl, fixture.apiKey);
    const largeFile = Buffer.allocUnsafe(largeFileSize);
    for (let index = 0; index < largeFile.length; index += 1) largeFile[index] = index % 251;
    fs.writeFileSync(path.join(fixture.encryptedSharePath, "blob.bin"), largeFile);
    const scan = await fetch(
      `${fixture.syncGuiUrl}/rest/db/scan?folder=${encodeURIComponent(fixture.fixture.encryptedFolderId)}`,
      { method: "POST", headers: { "X-API-Key": fixture.apiKey } },
    );
    if (!scan.ok) throw new Error(`Host Syncthing scan failed: ${scan.status}.`);
    await waitForHostIndex(
      fixture.syncGuiUrl,
      fixture.apiKey,
      fixture.fixture.encryptedFolderId,
      largeFileSize,
    );
    runPhase("--prepare-transfer-power-cut", env);
    await waitForPeerTransfer(
      fixture.syncGuiUrl,
      fixture.apiKey,
      startingPeerOutBytes,
    );
    await killEmulatorAbruptly(emulator);
    emulator = await startEmulator();
    runPhase("--verify-transfer-power-cut", env);

    await setPeerPaused(fixture.syncGuiUrl, fixture.apiKey, true);
    runPhase("--prepare-edit-power-cut", env);
    await killEmulatorAbruptly(emulator);
    emulator = await startEmulator();
    await setPeerPaused(fixture.syncGuiUrl, fixture.apiKey, false);
    runPhase("--verify-edit-power-cut", env);
    console.log("Android real-peer, cross-app, and abrupt-termination acceptance passed.");
  } finally {
    if (emulator) await stopEmulator(emulator);
    if (fixture) await fixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
