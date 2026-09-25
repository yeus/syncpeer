import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { androidPeerTargets, androidPeerCdpPort } from "./android-peer-targets.ts";

const appPackage = "dev.syncpeer.app";
const editorPackage = "dev.syncpeer.synthetic.editor";
const appApk = "packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/" +
  "universal/debug/app-universal-debug.apk";
const editorApk = "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/" +
  "build/outputs/apk/debug/syncpeer-document-editor-debug.apk";
const phaseScript = "scripts/test-android-e2e.mjs";
const folderId = "syncpeer-direct-folder";
const folderPassword = "synthetic-direct-folder-password";

const adb = (serial: string, args: string[], inherit = false) => execFileSync(
  "adb", ["-s", serial, ...args], {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  },
);

const onlineSerials = () => execFileSync("adb", ["devices"], { encoding: "utf8" })
  .split("\n").slice(1)
  .filter(line => /\sdevice(?:\s|$)/.test(line))
  .map(line => line.split(/\s+/)[0]!);

const selectedSerials = () => {
  return androidPeerTargets(onlineSerials(), process.env.SYNCPEER_ANDROID_SERIALS,
    process.env.SYNCPEER_ANDROID_RESET_EMULATORS === "1",
    serial => adb(serial, ["shell", "getprop", "ro.kernel.qemu"]).trim() === "1");
};

const phaseEnvironment = (serial: string, remoteDeviceId = "") => ({
  ...process.env,
  ANDROID_SERIAL: serial,
  SYNCPEER_ANDROID_CDP_PORT: String(androidPeerCdpPort(serial)),
  SYNCPEER_DEV_SERVER_DEVICE_ID: remoteDeviceId,
  SYNCPEER_E2E_FOLDER_ID: folderId,
  SYNCPEER_E2E_FOLDER_PASSWORD: folderPassword,
});

const runPhase = (serial: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
  execFileSync(process.execPath, [phaseScript, ...args], {
    cwd: process.cwd(),
    env: { ...phaseEnvironment(serial), ...extra },
    stdio: "inherit",
    timeout: 10 * 60_000,
  });
};

const spawnPhase = (serial: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
  const child = spawn(process.execPath, [phaseScript, ...args], {
    cwd: process.cwd(),
    env: { ...phaseEnvironment(serial), ...extra },
    stdio: "inherit",
  });
  return {
    child,
    completed: new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0
        ? resolve()
        : reject(new Error(`Android phase failed (${args.join(" ")}): ${code ?? signal}`)));
    }),
  };
};

const waitForFile = async (file: string) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Android pairing owner did not produce an invitation.");
};

const readDeviceId = (serial: string, directory: string) => {
  const output = path.join(directory, `${serial}-device-id`);
  runPhase(serial, ["--write-device-id", output]);
  return fs.readFileSync(output, "utf8").trim();
};

const connectBoth = async (
  first: { serial: string; localId: string; remoteId: string; port: string },
  second: { serial: string; localId: string; remoteId: string; port: string },
) => {
  const connect = ({ serial, remoteId, port }: typeof first) => spawnPhase(
    serial,
    ["--connect-whole-folder"],
    {
      SYNCPEER_DEV_SERVER_DEVICE_ID: remoteId,
      SYNCPEER_ANDROID_DISCOVERY_MODE: "direct",
      SYNCPEER_ANDROID_DIRECT_HOST: "10.0.2.2",
      SYNCPEER_ANDROID_DIRECT_PORT: port,
    },
  );
  const [acceptor, dialer] = first.localId.localeCompare(first.remoteId) > 0
    ? [first, second]
    : [second, first];
  const accepting = connect(acceptor);
  await new Promise(resolve => setTimeout(resolve, 3_000));
  const dialing = connect(dialer);
  try { await Promise.all([accepting.completed, dialing.completed]); }
  catch (error) {
    accepting.child.kill("SIGTERM");
    dialing.child.kill("SIGTERM");
    throw error;
  }
};

const edit = (serial: string, remoteId: string, operation: string, name: string,
  content?: string, target?: string) => runPhase(serial, ["--edit-whole-folder"], {
    SYNCPEER_DEV_SERVER_DEVICE_ID: remoteId,
    SYNCPEER_E2E_EDIT_OPERATION: operation,
    SYNCPEER_E2E_FILE_NAME: name,
    ...(content === undefined ? {} : { SYNCPEER_E2E_FILE_CONTENT: content }),
    ...(target === undefined ? {} : { SYNCPEER_E2E_RENAME_TARGET: target }),
  });

const verify = (serial: string, remoteId: string, name: string,
  content?: string, missing = false) => runPhase(serial, ["--verify-whole-folder"], {
    SYNCPEER_DEV_SERVER_DEVICE_ID: remoteId,
    SYNCPEER_E2E_FILE_NAME: name,
    ...(content === undefined ? {} : { SYNCPEER_E2E_FILE_CONTENT: content }),
    ...(missing ? { SYNCPEER_E2E_EXPECT_MISSING: "1" } : {}),
  });

const main = async () => {
  if (!fs.existsSync(appApk)) throw new Error(`Android APK is missing: ${appApk}`);
  if (!fs.existsSync(editorApk)) throw new Error(`Android editor APK is missing: ${editorApk}`);
  const [firstSerial, secondSerial] = selectedSerials();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-two-android-"));
  const invitation = path.join(directory, "pairing-invitation.json");
  try {
    for (const serial of [firstSerial, secondSerial]) {
      try { adb(serial, ["uninstall", appPackage], true); } catch { /* Fresh install is best-effort. */ }
      try { adb(serial, ["uninstall", editorPackage], true); } catch { /* Fresh install is best-effort. */ }
      adb(serial, ["install", "-r", appApk], true);
      adb(serial, ["install", "-r", editorApk], true);
      try { adb(serial, ["emu", "redir", "del", "tcp:23000"], true); } catch { /* No stale redirect. */ }
      try { adb(serial, ["emu", "redir", "del", "tcp:23001"], true); } catch { /* No stale redirect. */ }
    }
    adb(firstSerial, ["emu", "redir", "add", "tcp:23000:22000"], true);
    adb(secondSerial, ["emu", "redir", "add", "tcp:23001:22000"], true);

    const owner = spawnPhase(firstSerial,
      ["--pairing-owner", "--pairing-invitation", invitation], {
        SYNCPEER_PAIRING_ADVERTISED_HOST: "10.0.2.2:23000",
      });
    await waitForFile(invitation);
    runPhase(secondSerial, ["--pairing-join", "--pairing-invitation", invitation]);
    await owner.completed;

    const firstId = readDeviceId(firstSerial, directory);
    const secondId = readDeviceId(secondSerial, directory);
    runPhase(firstSerial, ["--prepare-whole-folder"], {
      SYNCPEER_DEV_SERVER_DEVICE_ID: secondId,
    });
    runPhase(secondSerial, ["--prepare-whole-folder"], {
      SYNCPEER_DEV_SERVER_DEVICE_ID: firstId,
    });
    runPhase(firstSerial, ["--grant-whole-folder-editor"], {
      SYNCPEER_DEV_SERVER_DEVICE_ID: secondId,
    });
    runPhase(secondSerial, ["--grant-whole-folder-editor"], {
      SYNCPEER_DEV_SERVER_DEVICE_ID: firstId,
    });
    const first = { serial: firstSerial, localId: firstId, remoteId: secondId, port: "23001" };
    const second = { serial: secondSerial, localId: secondId, remoteId: firstId, port: "23000" };

    edit(firstSerial, secondId, "write", "direct.txt", "created-by-first-android");
    await connectBoth(first, second);
    verify(secondSerial, firstId, "direct.txt", "created-by-first-android");

    edit(secondSerial, firstId, "write", "direct.txt", "modified-by-second-android");
    verify(firstSerial, secondId, "direct.txt", "modified-by-second-android");

    edit(secondSerial, firstId, "rename", "direct.txt", undefined, "renamed.txt");
    verify(firstSerial, secondId, "direct.txt", undefined, true);
    verify(firstSerial, secondId, "renamed.txt", "modified-by-second-android");

    edit(firstSerial, secondId, "delete", "renamed.txt");
    verify(secondSerial, firstId, "renamed.txt", undefined, true);
    edit(firstSerial, secondId, "write", "retained.txt", "retained-by-second-peer");
    verify(secondSerial, firstId, "retained.txt", "retained-by-second-peer");
    runPhase(firstSerial, [process.env.SYNCPEER_ANDROID_TEST_SAFE_UI === "1"
      ? "--release-whole-folder-safe-ui" : "--release-whole-folder-safe"], {
      SYNCPEER_DEV_SERVER_DEVICE_ID: secondId,
      SYNCPEER_ANDROID_DISCOVERY_MODE: "direct",
      SYNCPEER_ANDROID_DIRECT_HOST: "10.0.2.2",
      SYNCPEER_ANDROID_DIRECT_PORT: first.port,
    });
    verify(secondSerial, firstId, "retained.txt", "retained-by-second-peer");
    runPhase(secondSerial, ["--release-whole-folder-dangerous"], {
      SYNCPEER_DEV_SERVER_DEVICE_ID: firstId,
    });
    console.log("Two packaged Android Syncpeer peers passed pairing, whole-folder CRUD, safe and unsafe local release.");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

await main();
