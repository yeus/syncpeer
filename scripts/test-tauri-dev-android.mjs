import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { runWithPrivateSecretService } from "./lan-test/private-secret-service.mjs";

const serial = process.env.SYNCPEER_ANDROID_SERIAL?.trim();
assert.match(serial ?? "", /^emulator-\d+$/, "Set SYNCPEER_ANDROID_SERIAL to one explicit emulator.");
assert.equal(process.env.SYNCPEER_ANDROID_RESET_EMULATOR, "1",
  "Set SYNCPEER_ANDROID_RESET_EMULATOR=1 to permit clearing the selected test app.");

const binary = path.resolve("packages/tauri-shell/src-tauri/target/debug/tauri-shell");
const apk = path.resolve("packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/" +
  "universal/debug/app-universal-debug.apk");
const editor = path.resolve("packages/tauri-shell/src-tauri/plugins/syncpeer-android/" +
  "editor-test-app/build/outputs/apk/debug/syncpeer-document-editor-debug.apk");
for (const [file, label] of [[binary, "Tauri debug binary"], [apk, "Android E2E APK"],
  [editor, "separate editor APK"]]) {
  assert.ok((await stat(file).catch(() => null))?.isFile(), `Build the ${label} before this test.`);
}

const sdk = process.env.ANDROID_HOME ?? "/sandbox-home/android-sdk";
const adb = path.join(sdk, "platform-tools", "adb");
process.env.ANDROID_HOME = sdk;
process.env.ANDROID_SDK_ROOT = sdk;
process.env.PATH = `${path.dirname(adb)}:${process.env.PATH ?? ""}`;
const target = spawnSync(adb, ["-s", serial, "shell", "getprop", "ro.kernel.qemu"],
  { encoding: "utf8", timeout: 30_000 });
if (target.error) throw target.error;
assert.equal(target.status, 0, "The selected emulator is unavailable.");
assert.equal(target.stdout.trim(), "1", "The selected Android target is not an emulator.");

const install = spawnSync(adb, ["-s", serial, "install", "-r", apk],
  { stdio: "inherit", timeout: 120_000 });
if (install.error) throw install.error;
assert.equal(install.status, 0, "Android fixture install failed.");
const reset = spawnSync(adb, ["-s", serial, "shell", "pm", "clear", "dev.syncpeer.app"],
  { encoding: "utf8", timeout: 120_000 });
if (reset.error) throw reset.error;
assert.equal(reset.status, 0, "Android fixture reset failed.");
assert.equal(reset.stdout.trim(), "Success", "Android fixture did not clear its private data.");

async function viteIsReady() {
  try {
    const response = await fetch("http://127.0.0.1:5174/", { signal: AbortSignal.timeout(2_000) });
    return response.ok && (await response.text()).includes("<title>Syncpeer UI</title>");
  }
  catch { return false; }
}

let vite;
try {
  if (!await viteIsReady()) {
    vite = spawn("npm", ["run", "dev", "-w", "@syncpeer/app", "--", "--port", "5174", "--strictPort"],
      { stdio: "inherit" });
    const deadline = Date.now() + 30_000;
    while (!await viteIsReady()) {
      assert.ok(vite.exitCode === null && Date.now() < deadline, "Vite did not become ready.");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const result = await runWithPrivateSecretService("xvfb-run", ["-a", process.execPath,
    "--import", "tsx", path.resolve("node_modules/@wdio/cli/bin/wdio.js"),
    "run", path.resolve("scripts/lan-test/wdio.conf.ts")], {
    SYNCPEER_LAN_SPEC: "scripts/lan-test/packaged-android-pairing.spec.ts",
    SYNCPEER_LAN_APP_BINARY: binary,
    SYNCPEER_LAN_DRIVER: "external",
    SYNCPEER_LAN_MOCHA_TIMEOUT: "900000",
    SYNCPEER_LAN_LOG_LEVEL: "error",
    SYNCPEER_ANDROID_SERIAL: serial,
    SYNCPEER_LAN_EXPECT_DEV_URL: "http://127.0.0.1:5174",
  });
  assert.equal(result, 0, "The Tauri-dev-to-Android editor test failed.");
} finally {
  vite?.kill("SIGTERM");
}
