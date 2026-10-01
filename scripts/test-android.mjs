import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  create,
  emulatorArguments,
  profile,
} from "./android-emulator.mjs";

const editorPackage = "dev.syncpeer.synthetic.editor";
const appApk = "packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/" +
  "universal/debug/app-universal-debug.apk";
const editorApk = "packages/tauri-shell/src-tauri/plugins/syncpeer-android/" +
  "editor-test-app/build/outputs/apk/debug/syncpeer-document-editor-debug.apk";
const androidProject = "packages/tauri-shell/src-tauri/gen/android";
const editorProject = "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app";

export const run = (executable, args, options = {}) => execFileSync(executable, args, {
  stdio: "inherit",
  ...options,
});

const pull = (remote, local) => run("adb", ["pull", remote, local]);

export const adb = (args, options = {}) => execFileSync("adb", args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  ...options,
});

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const deviceLines = (detailed = false) => adb(detailed ? ["devices", "-l"] : ["devices"]).split("\n")
  .slice(1)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => /^\S+\s+\S+/.test(line));

export const listDeviceSerials = () => deviceLines().map((line) => line.split(/\s+/)[0]);
export const listDeviceTransports = () => deviceLines(true).map((line) => {
  const serial = line.split(/\s+/)[0];
  const transport = line.match(/\btransport_id:(\d+)\b/)?.[1] ?? "unknown";
  return `${serial}:${transport}`;
});

export const newEmulatorSerials = (lines, knownSerials) => {
  const known = new Set(knownSerials);
  return lines.flatMap((line) => {
    const serial = line.trim().match(/^(emulator-\d+)\s+device(?:\s|$)/)?.[1];
    if (!serial) return [];
    const transport = line.match(/\btransport_id:(\d+)\b/)?.[1] ?? "unknown";
    return known.has(`${serial}:${transport}`) ? [] : [serial];
  });
};

const assertNoDevices = () => {
  const devices = deviceLines();
  if (devices.length > 0) {
    throw new Error(`Android test needs an empty adb device list; found ${devices.join(", ")}.`);
  }
};

export const uninstallIfPresent = (packageName) => {
  try {
    if (!adb(["shell", "pm", "path", packageName], { timeout: 10_000 }).trim()) return;
  } catch {
    return;
  }
  run("adb", ["uninstall", packageName]);
};

export const waitForBoot = async (child, avdName, knownSerials = []) => {
  const deadline = Date.now() + 180_000;
  let state = "not started";
  let launchError;
  child.once("error", (error) => {
    launchError = error;
  });
  while (Date.now() < deadline) {
    if (launchError) {
      throw new Error(`Could not start Android emulator ${avdName}.`, { cause: launchError });
    }
    if (child.exitCode !== null) {
      throw new Error(`Android emulator ${avdName} exited before booting.`);
    }
    try {
      const candidates = newEmulatorSerials(deviceLines(true), knownSerials);
      state = candidates.length === 0 ? "target emulator not online" : "target emulator booting";
      for (const serial of candidates) {
        const name = adb(["-s", serial, "emu", "avd", "name"], { timeout: 10_000 })
          .split(/\r?\n/)[0].trim();
        if (name !== avdName) continue;
        state = adb(["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeout: 10_000 }).trim();
        if (state !== "1") continue;
        const packageManager = adb(["-s", serial, "shell", "pm", "path", "android"], { timeout: 10_000 }).trim();
        if (packageManager.startsWith("package:")) return serial;
        state = "package manager not ready";
      }
    } catch {
      state = "adb unavailable";
    }
    await wait(1_000);
  }
  throw new Error(`Android emulator ${avdName} did not finish booting (state=${state}).`);
};

const waitForExit = async (child, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (child.exitCode === null && Date.now() < deadline) await wait(250);
  if (child.exitCode === null) child.kill("SIGTERM");
};

export const stopEmulator = async (child, serial) => {
  if (!/^emulator-\d+$/.test(serial)) throw new Error("A specific emulator serial is required for cleanup.");
  try {
    adb(["-s", serial, "emu", "kill"], { timeout: 10_000 });
  } catch {
    // The emulator may already have exited after a failed test.
  }
  await waitForExit(child);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (!listDeviceSerials().includes(serial)) return;
    } catch {
      return;
    }
    await wait(500);
  }
};

const captureWebViewFixture = (directory) => {
  const webViewPath = adb(["shell", "pm", "path", "com.google.android.webview"])
    .split(/\r?\n/)
    .map((line) => line.replace(/^package:/, "").trim())
    .find(Boolean);
  if (!webViewPath) throw new Error("The modern emulator has no Android System WebView APK.");

  const compressedLibrary = path.join(directory, "TrichromeLibrary.apk.gz");
  const libraryApk = path.join(directory, "TrichromeLibrary.apk");
  const webViewApk = path.join(directory, "WebViewGoogle.apk");
  pull(webViewPath, webViewApk);
  pull("/product/app/TrichromeLibrary/TrichromeLibrary.apk.gz", compressedLibrary);
  fs.writeFileSync(libraryApk, gunzipSync(fs.readFileSync(compressedLibrary)));

  const packageDetails = adb(["shell", "dumpsys", "package", "com.google.android.webview"]);
  const version = packageDetails.match(/versionName=([^\s]+)/)?.[1];
  if (!version) throw new Error("Could not determine the modern WebView version.");
  console.log(`Using modern WebView ${version} for the API 29 compatibility emulator.`);
  return { libraryApk, webViewApk, version };
};

export const webViewSelected = (state, version) => state.includes(
  `Current WebView package (name, version): (com.google.android.webview, ${version})`,
);

const installWebViewFixture = async (fixture) => {
  run("adb", ["install", "-r", "-d", fixture.libraryApk]);
  run("adb", ["install", "-r", "-d", fixture.webViewApk]);
  run("adb", ["shell", "cmd", "webviewupdate", "set-webview-implementation", "com.google.android.webview"]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (webViewSelected(adb(["shell", "dumpsys", "webviewupdate"]), fixture.version)) return;
    await wait(250);
  }
  throw new Error(`API 29 did not select the provisioned WebView ${fixture.version} within 30 seconds.`);
};

const legacyCrashFrames = (serial) => {
  try {
    const log = adb(["-s", serial, "logcat", "-d", "-s", "AndroidRuntime:E"], { timeout: 10_000 });
    const crash = log.slice(log.lastIndexOf("Process: dev.syncpeer.app"));
    if (crash === log) return { frames: [], missingTypes: [] };
    const frames = crash.split("\n").flatMap(line => {
      const exception = line.match(/\b(?:java|kotlin)\.[\w.$]*(?:Error|Exception)\b/);
      const frame = line.match(/\bat ([\w.$]+)\(/);
      return exception ? [exception[0]] : frame ? [frame[1]] : [];
    }).slice(0, 25);
    const missingTypes = [...new Set([...crash.matchAll(/L(?:java|javax|android|com|kotlin)\/[\w/$]+;/g)]
      .map(match => match[0].slice(1, -1).replaceAll("/", ".")))].slice(0, 5);
    return { frames, missingTypes };
  } catch {
    return { frames: [], missingTypes: [] };
  }
};

const runProfile = async (profileName, testArguments, prepareDevice,
  installEditor = false, allowOtherDevices = false) => {
  if (!allowOtherDevices) assertNoDevices();
  const knownTransports = listDeviceTransports();
  const selected = profile(profileName);
  create(selected);
  const child = spawn("emulator", emulatorArguments(selected), { stdio: "ignore" });
  const previousSerial = process.env.ANDROID_SERIAL;
  let serial;
  try {
    serial = await waitForBoot(child, selected.avdName, knownTransports);
    process.env.ANDROID_SERIAL = serial;
    uninstallIfPresent(editorPackage);
    uninstallIfPresent("dev.syncpeer.plugin.android.test");
    uninstallIfPresent("dev.syncpeer.app");
    await prepareDevice?.();
    run("npm", ["run", "android:install:e2e"]);
    if (installEditor) run("adb", ["install", "-r", editorApk]);
    try {
      run(process.execPath, ["scripts/test-android-e2e.mjs", ...testArguments]);
    } catch (error) {
      if (profileName === "legacy") {
        console.error("API 24 startup crash classes:", JSON.stringify(legacyCrashFrames(serial)));
      }
      throw error;
    }
  } finally {
    if (serial) await stopEmulator(child, serial);
    else child.kill("SIGTERM");
    if (previousSerial === undefined) delete process.env.ANDROID_SERIAL;
    else process.env.ANDROID_SERIAL = previousSerial;
  }
};

const main = async () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-webview-"));
  try {
    if (process.argv.includes("--legacy-smoke-only")) {
      if (!fs.existsSync(appApk)) throw new Error("Build the Android E2E APK before the API 24 smoke.");
      await runProfile("legacy", ["--expect-sdk", "24", "--legacy-smoke"], undefined, false, true);
      return;
    }
    if (process.argv.includes("--compat-startup-only")) {
      if (!fs.existsSync(appApk)) throw new Error("Build the Android E2E APK before the API 29 smoke.");
      await runProfile("compat", ["--expect-sdk", "29", "--startup-smoke"], undefined, false, true);
      return;
    }
    run("npm", ["run", "build:android:e2e"]);
    run(path.join(androidProject, "gradlew"), [
      "-p", editorProject, "assembleDebug", "--no-daemon", "--console=plain",
    ]);
    if (!fs.existsSync(editorApk)) throw new Error(`Synthetic editor APK was not built: ${editorApk}`);
    let webViewFixture;
    await runProfile("modern", ["--modern-smoke"], () => {
      webViewFixture = captureWebViewFixture(fixtureDirectory);
    });
    await runProfile("compat", [
      "--expect-sdk", "29", "--reboot", "--skip-network",
    ], async () => {
      if (!webViewFixture) throw new Error("Modern WebView fixture was not captured.");
      await installWebViewFixture(webViewFixture);
    }, true);
    await runProfile("legacy", [
      "--expect-sdk", "24", "--legacy-smoke",
    ]);
    run(process.execPath, [
      "--experimental-strip-types",
      "scripts/test-android-peer.ts",
    ]);
    console.log("Combined Android compatibility and modern smoke tests passed.");
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
