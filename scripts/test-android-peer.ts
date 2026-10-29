import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { normalizeDeviceId } from "../packages/core/src/ui/helpers.ts";

import { create, emulatorArguments, profile } from "./android-emulator.mjs";
import {
  adb,
  listDeviceSerials,
  listDeviceTransports,
  run,
  stopEmulator,
  uninstallIfPresent,
  waitForBoot,
} from "./test-android.mjs";
import { createLanFixture, freePort, generateSyncthingIdentity } from "./lan-test/syncthing.ts";

const appPackage = "dev.syncpeer.app";
const editorPackage = "dev.syncpeer.synthetic.editor";
const appApk = "packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk";
const editorApk = "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/build/outputs/apk/debug/syncpeer-document-editor-debug.apk";
const peerApiLevel = Number(process.env.SYNCPEER_ANDROID_PEER_API || 29);
type RunningEmulator = { child: ChildProcess; serial: string };

const peerProfile = peerApiLevel === 26 ? "minimum" : peerApiLevel === 36 ? "modern" : "compat";
const requestedDiscoveryMode = process.env.SYNCPEER_ANDROID_PEER_DISCOVERY_MODE;
const discoveryMode = requestedDiscoveryMode === "automatic" || requestedDiscoveryMode === "global"
  ? requestedDiscoveryMode : "direct";

/** Pinned, disposable Syncthing discovery endpoint. No public discovery or real credentials. */
const startSyntheticDiscovery = async (root: string, remoteId: string, peerPort: number) => {
  const identity = generateSyncthingIdentity(path.join(root, "discovery"));
  let lookups = 0;
  let handshakes = 0;
  const server = createServer({
    cert: fs.readFileSync(identity.certPath, "utf8"),
    key: fs.readFileSync(identity.keyPath, "utf8"),
    requestCert: true,
    rejectUnauthorized: false,
  }, (request, response) => {
    if (request.method === "POST") {
      response.writeHead((request.socket as TLSSocket).getPeerCertificate()?.raw ? 204 : 403).end();
      return;
    }
    const device = normalizeDeviceId(new URL(request.url ?? "/", "https://localhost")
      .searchParams.get("device") ?? "");
    if (request.method !== "GET" || device !== normalizeDeviceId(remoteId)) {
      console.warn("Synthetic discovery unexpected query", {
        method: request.method, device, expectedDevice: normalizeDeviceId(remoteId),
      });
      response.writeHead(404).end();
      return;
    }
    lookups += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ addresses: [`tcp://127.0.0.1:${peerPort}`] }));
  });
  server.on("secureConnection", () => { handshakes += 1; });
  server.on("tlsClientError", error => console.warn(`Synthetic discovery TLS rejected: ${error.message}`));
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic discovery failed to bind.");
  return {
    port: address.port,
    // Use the per-emulator ADB reverse listener with a DNS hostname, so the
    // HTTP client also exercises the TLS SNI path rather than an IP literal.
    url: `https://localhost:${address.port}/v2/?id=${identity.deviceId}`,
    lookupCount: () => lookups,
    handshakeCount: () => handshakes,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

const startEmulator = async (): Promise<RunningEmulator> => {
  const selected = profile(peerProfile);
  create(selected);
  const knownSerials = listDeviceTransports();
  const child = spawn("emulator", emulatorArguments(selected, ["-no-window", "-no-snapshot"]), {
    stdio: "ignore",
  });
  try {
    const serial = await waitForBoot(child, selected.avdName, knownSerials);
    process.env.ANDROID_SERIAL = serial;
    if (peerApiLevel < 29) {
      // The API 26/29 google_apis images allow adb root. Wi-Fi cannot be
      // disabled as the shell user on API 26, and the session-policy test needs
      // a real loss of the active default network.
      try {
        adb(["root"]);
        await new Promise(resolve => setTimeout(resolve, 2_000));
        adb(["wait-for-device"], { timeout: 30_000 });
      } catch {
        // The policy phase reports the exact unsupported transition.
      }
    }
    return { child, serial };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
};

const killEmulatorAbruptly = async (emulator: RunningEmulator): Promise<void> => {
  emulator.child.kill("SIGKILL");
  const deadline = Date.now() + 30_000;
  while (emulator.child.exitCode === null && emulator.child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (emulator.child.exitCode === null && emulator.child.signalCode === null) {
    throw new Error("Android emulator did not terminate after SIGKILL.");
  }
  const deviceDeadline = Date.now() + 30_000;
  while (Date.now() < deviceDeadline) {
    if (!listDeviceSerials().includes(emulator.serial)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Abruptly terminated emulator remained visible to adb.");
};

/** Do not block the parent event loop: it owns the synthetic HTTPS discovery
 * server that the Android subprocess must contact during acceptance tests. */
const runPhase = async (phase: string, env: NodeJS.ProcessEnv): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath,
      ["scripts/test-android-e2e.mjs", "--expect-sdk", String(peerApiLevel), phase],
      { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Android E2E ${phase} failed with ${code === null ? `signal ${signal}` : `exit ${code}`}.`));
    });
  });
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

/** Serialise real-peer emulator acceptance across independent invocations.
 * Android 36 E2E is particularly sensitive to competing emulator boots and
 * shared adb state. Recover a lock left by a killed test process. */
const acquirePeerE2ELock = async (): Promise<() => void> => {
  // Nix shells often assign a distinct TMPDIR to each invocation, so a lock
  // inside os.tmpdir() would NOT protect separate E2E emulator processes.
  // The user's home directory remains stable across those shells.
  const lockPath = path.join(os.homedir(), ".syncpeer-android-peer-e2e.lock");
  const deadline = Date.now() + 10 * 60_000;
  let announcedWait = false;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockPath);
        } catch { /* The lock can already be gone after a forced process kill. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let ownerPid = 0;
    try { ownerPid = Number(fs.readFileSync(lockPath, "utf8").trim()); }
    catch { /* Previous owner may be exiting. */ }
    if (Number.isSafeInteger(ownerPid) && ownerPid > 1) {
      try { process.kill(ownerPid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          try { fs.unlinkSync(lockPath); } catch { /* Another contender recovered it. */ }
          continue;
        }
      }
    }
    if (!announcedWait) {
      console.log("Waiting for another real-peer Android E2E test to release the emulator lock.");
      announcedWait = true;
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for the shared Android real-peer E2E emulator lock.");
};

const main = async (): Promise<void> => {
  const releasePeerLock = await acquirePeerE2ELock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-android-peer-"));
  const previousSerial = process.env.ANDROID_SERIAL;
  let emulator: RunningEmulator | null = null;
  let fixture: Awaited<ReturnType<typeof createLanFixture>> | null = null;
  let forwardedPort: number | null = null;
  let discovery: Awaited<ReturnType<typeof startSyntheticDiscovery>> | null = null;
  // In the discovery regression Android MUST initiate the peer transport: a
  // host-initiated connection would produce a misleading green result.
  const outboundOnly = discoveryMode !== "direct" ||
    process.env.SYNCPEER_ANDROID_PEER_OUTBOUND_ONLY === "1";
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
      throw new Error("Android document runtime is unavailable; real-peer acceptance cannot be skipped.");
    }
    if (!outboundOnly) {
      forwardedPort = await freePort();
      run("adb", ["forward", `tcp:${forwardedPort}`, "tcp:22000"]);
    }
    fixture = await createLanFixture({
      root: path.join(root, "host"),
      serverHost: "10.0.2.2",
      untrustedDeviceId: deviceId,
      untrustedDeviceAddress: outboundOnly ? "tcp://127.0.0.1:9" : `tcp://127.0.0.1:${forwardedPort}`,
      mode: "direct",
      publicNetwork: false,
      encryptedFolderType: "sendreceive",
      includeBlob: false,
    });
    run("adb", ["reverse", `tcp:${fixture.fixture.directPort}`, `tcp:${fixture.fixture.directPort}`]);
    if (discoveryMode !== "direct") {
      discovery = await startSyntheticDiscovery(root, fixture.fixture.remoteDeviceId, fixture.fixture.directPort);
      run("adb", ["reverse", `tcp:${discovery.port}`, `tcp:${discovery.port}`]);
    }
    // The ordinary Android transfer suite covers 128 MiB. This fixture stays
    // smaller so it can prove multi-block journal recovery plus a full
    // DocumentsProvider hash within emulator time limits.
    const largeFileSize = 4 * 1024 * 1024;
    const env = {
      ...process.env,
      SYNCPEER_DEV_SERVER_DEVICE_ID: fixture.fixture.remoteDeviceId,
      SYNCPEER_ANDROID_DISCOVERY_MODE: discoveryMode,
      ...(discovery ? { SYNCPEER_LAN_DISCOVERY_SERVER: discovery.url } : {}),
      SYNCPEER_ANDROID_DIRECT_HOST: "127.0.0.1",
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

    if (process.env.SYNCPEER_ANDROID_PEER_CONNECTION_ONLY === "1") {
      await runPhase("--peer-connect-smoke", env);
      if (discovery && discovery.lookupCount() === 0) {
        throw new Error("Automatic Android connection never queried pinned synthetic discovery.");
      }
      console.log(`Android ${discoveryMode} real-peer connection E2E passed.`);
      return;
    }
    if (process.env.SYNCPEER_ANDROID_PEER_POLICY_ONLY === "1") {
      await runPhase("--session-policy-transition", env);
      return;
    }
    if (process.env.SYNCPEER_ANDROID_PEER_CROSSAPP_ONLY === "1") {
      await runPhase("--peer-cross-app", env);
      console.log("Android real-peer cross-app E2E passed.");
      return;
    }
    const powerCutOnly = process.env.SYNCPEER_ANDROID_PEER_POWER_CUT_ONLY === "1";
    if (powerCutOnly) {
      await runPhase("--peer-power-cut-setup", env);
    } else {
      await runPhase("--peer-cross-app", env);
      await runPhase("--session-policy-transition", env);
    }
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
    await runPhase("--prepare-transfer-power-cut", env);
    await waitForPeerTransfer(
      fixture.syncGuiUrl,
      fixture.apiKey,
      startingPeerOutBytes,
    );
    await killEmulatorAbruptly(emulator);
    emulator = await startEmulator();
    if (forwardedPort !== null) run("adb", ["forward", `tcp:${forwardedPort}`, "tcp:22000"]);
    run("adb", ["reverse", `tcp:${fixture.fixture.directPort}`, `tcp:${fixture.fixture.directPort}`]);
    await runPhase("--verify-transfer-power-cut", env);

    await setPeerPaused(fixture.syncGuiUrl, fixture.apiKey, true);
    await runPhase("--prepare-edit-power-cut", env);
    await killEmulatorAbruptly(emulator);
    emulator = await startEmulator();
    if (forwardedPort !== null) run("adb", ["forward", `tcp:${forwardedPort}`, "tcp:22000"]);
    run("adb", ["reverse", `tcp:${fixture.fixture.directPort}`, `tcp:${fixture.fixture.directPort}`]);
    await setPeerPaused(fixture.syncGuiUrl, fixture.apiKey, false);
    await runPhase("--verify-edit-power-cut", env);
    console.log(powerCutOnly
      ? "Android real-peer abrupt-termination recovery E2E passed."
      : "Android real-peer, cross-app, and abrupt-termination acceptance passed.");
  } catch (error) {
    if (fixture) {
      try {
        const headers = { "X-API-Key": fixture.apiKey };
        const [connections, folder] = await Promise.all([
          fetch(`${fixture.syncGuiUrl}/rest/system/connections`, { headers })
            .then(response => response.json()) as Promise<{ connections?: Record<string, { connected?: boolean }> }>,
          fetch(`${fixture.syncGuiUrl}/rest/db/status?folder=${encodeURIComponent(fixture.fixture.encryptedFolderId)}`,
            { headers }).then(response => response.json()) as Promise<{
              localFiles?: number; globalFiles?: number; needFiles?: number; state?: string }>,
        ]);
        console.error("Synthetic Syncthing failure state:", JSON.stringify({
          connectedPeers: Object.values(connections.connections ?? {}).filter(value => value.connected).length,
          localFiles: folder.localFiles, globalFiles: folder.globalFiles,
          needFiles: folder.needFiles, folderState: folder.state,
        }));
      } catch { console.error("Synthetic Syncthing failure state could not be read."); }
    }
    if (discovery) console.error("Synthetic discovery observations:",
      { lookups: discovery.lookupCount(), tlsHandshakes: discovery.handshakeCount() });
    if (process.env.SYNCPEER_ANDROID_FAILURE_DIAGNOSTICS === "1") {
      try {
        console.error("Android process:", adb(["shell", "pidof", appPackage]).trim());
        console.error("Android focus:", adb(["shell", "dumpsys", "activity", "activities"])
          .split("\n").filter(line => /mResumedActivity|mCurrentFocus|mFocusedApp/.test(line)).join(" | "));
        console.error("Android WebView:", adb(["shell", "dumpsys", "webviewupdate"])
          .split("\n").filter(line => /Current WebView package/.test(line)).join(" | "));
        const runtimeLog = adb(["logcat", "-d", "-s", "SyncpeerRuntime:W"]).split("\n")
          .slice(-60).join("\n");
        console.error("Android SyncpeerRuntime log:", runtimeLog);
        // Bound the logcat output: the complete emulator buffer can exceed
        // Node's execFileSync maxBuffer and hide the original test failure.
        const failureLog = adb(["logcat", "-d", "-t", "700"]).split("\n")
          .filter(line => /AndroidRuntime|FATAL EXCEPTION|chromium|Tauri\/Console|WebViewFactory|crash/i.test(line))
          .slice(-60).join("\n");
        console.error("Android failure log:", failureLog);
      } catch (diagnosticError) {
        console.error("Android failure diagnostics unavailable.", diagnosticError);
      }
    }
    try {
      const runtimeEvents = adb(["logcat", "-d", "-s", "SyncpeerRuntime:W"])
        .split("\n")
        .flatMap(line => {
          const event = /SyncpeerRuntime.*?:\s+((?:core|document|session)\.[a-z0-9_.-]+)/i.exec(line)?.[1];
          return event ? [event] : [];
        })
        .slice(-60);
      console.error("Android runtime event names:", JSON.stringify(runtimeEvents));
    } catch { console.error("Android runtime event names unavailable."); }
    throw error;
  } finally {
    if (discovery) {
      try { adb(["reverse", "--remove", `tcp:${discovery.port}`]); } catch { /* Emulator stopped. */ }
      await discovery.close();
    }
    if (fixture) {
      try { adb(["reverse", "--remove", `tcp:${fixture.fixture.directPort}`]); }
      catch { /* The emulator may already have been abruptly terminated. */ }
    }
    if (forwardedPort !== null) {
      try { adb(["forward", "--remove", `tcp:${forwardedPort}`]); }
      catch { /* The emulator may already have been abruptly terminated. */ }
    }
    if (emulator && process.env.SYNCPEER_KEEP_ANDROID_EMULATOR !== "1") {
      await stopEmulator(emulator.child, emulator.serial);
    }
    if (previousSerial === undefined) delete process.env.ANDROID_SERIAL;
    else process.env.ANDROID_SERIAL = previousSerial;
    if (fixture) await fixture.stop();
    fs.rmSync(root, { recursive: true, force: true });
    releasePeerLock();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
