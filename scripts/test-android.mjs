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

const deviceLines = () => adb(["devices"]).split("\n")
  .slice(1)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => /^\S+\s+\S+/.test(line));

const onlineDevices = () => deviceLines().filter((line) => /\sdevice(?:\s|$)/.test(line));

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

export const waitForBoot = async (child, avdName) => {
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
      const devices = onlineDevices();
      if (devices.length === 1) {
        state = adb(["shell", "getprop", "sys.boot_completed"], { timeout: 10_000 }).trim();
        if (state === "1") return;
      } else {
        state = devices.length === 0 ? "no device" : `${devices.length} devices`;
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

export const stopEmulator = async (child) => {
  try {
    adb(["emu", "kill"], { timeout: 10_000 });
  } catch {
    // The emulator may already have exited after a failed test.
  }
  await waitForExit(child);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (deviceLines().length === 0) return;
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

const runProfile = async (profileName, testArguments, prepareDevice, installEditor = false) => {
  assertNoDevices();
  const selected = profile(profileName);
  create(selected);
  const child = spawn("emulator", emulatorArguments(selected), { stdio: "ignore" });
  try {
    await waitForBoot(child, selected.avdName);
    uninstallIfPresent(editorPackage);
    uninstallIfPresent("dev.syncpeer.plugin.android.test");
    uninstallIfPresent("dev.syncpeer.app");
    await prepareDevice?.();
    run("npm", ["run", "android:install:e2e"]);
    if (installEditor) run("adb", ["install", "-r", editorApk]);
    run(process.execPath, ["scripts/test-android-e2e.mjs", ...testArguments]);
  } finally {
    await stopEmulator(child);
  }
};

const main = async () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-webview-"));
  try {
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
