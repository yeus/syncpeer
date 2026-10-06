import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithPrivateSecretService } from "./lan-test/private-secret-service.mjs";

if (process.platform !== "linux") throw new Error("The .deb smoke test requires Linux.");
const artifactArg = process.argv[2];
if (!artifactArg?.endsWith(".deb")) {
  throw new Error("Pass the exact .deb artifact path to test; no previous build is selected implicitly.");
}
const artifact = path.resolve(artifactArg);
assert.ok((await stat(artifact)).isFile(), "The .deb artifact must be a file.");
const serial = process.env.SYNCPEER_ANDROID_SERIAL?.trim();
const crossAppOnly = process.argv.includes("--cross-app-only");
const skipAndroidRecovery = process.argv.includes("--skip-android-recovery");
if (crossAppOnly) assert.ok(serial, "--cross-app-only requires SYNCPEER_ANDROID_SERIAL.");
if (serial) {
  assert.match(serial, /^emulator-\d+$/, "The Android target must be an explicit emulator serial.");
  assert.equal(process.env.SYNCPEER_ANDROID_RESET_EMULATOR, "1",
    "Set SYNCPEER_ANDROID_RESET_EMULATOR=1 to permit clearing the selected test app.");
}
const root = await mkdtemp(path.join(tmpdir(), "syncpeer-deb-smoke-"));
try {
  const packageRoot = path.join(root, "package");
  const extracted = spawnSync("dpkg-deb", ["--extract", artifact, packageRoot], { stdio: "inherit" });
  if (extracted.error) throw extracted.error;
  assert.equal(extracted.status, 0, "The .deb payload could not be extracted.");
  const binary = path.join(packageRoot, "usr", "bin", "tauri-shell");
  assert.ok((await stat(binary)).isFile(), "The .deb payload has no Tauri executable.");
  if (!crossAppOnly) {
    const code = await runWithPrivateSecretService("xvfb-run", ["-a", process.execPath,
      "--import", "tsx", path.resolve("node_modules/@wdio/cli/bin/wdio.js"),
      "run", path.resolve("scripts/lan-test/wdio.conf.ts")], {
      SYNCPEER_LAN_SPEC: "scripts/lan-test/release-smoke.spec.ts",
      SYNCPEER_LAN_APP_BINARY: binary,
      SYNCPEER_LAN_DRIVER: "external",
      SYNCPEER_LAN_MOCHA_TIMEOUT: "300000",
      SYNCPEER_LAN_LOG_LEVEL: "error",
      XDG_DATA_DIRS: process.env.SYNCPEER_DEB_XDG_DATA_DIRS ?? "/usr/share",
    });
    assert.equal(code, 0, "The packaged fresh-profile smoke test failed.");
    const pairing = spawnSync("xvfb-run", ["-a", process.execPath, "--import", "tsx",
      path.resolve("node_modules/@wdio/cli/bin/wdio.js"), "run",
      path.resolve("scripts/lan-test/wdio-pairing.conf.ts")], {
      stdio: "inherit", env: { ...process.env, SYNCPEER_LAN_APP_BINARY: binary,
        XDG_DATA_DIRS: process.env.SYNCPEER_DEB_XDG_DATA_DIRS ?? "/usr/share" },
    });
    if (pairing.error) throw pairing.error;
    assert.equal(pairing.status, 0, "The two-instance packaged pairing test failed.");
  }
  if (serial) {
    const target = spawnSync("adb", ["-s", serial, "shell", "getprop", "ro.kernel.qemu"],
      { encoding: "utf8", timeout: 30_000 });
    if (target.error) throw target.error;
    assert.equal(target.status, 0, "The selected Android emulator is unavailable.");
    assert.equal(target.stdout.trim(), "1", "The selected Android target is not an emulator.");
    let androidReady = false;
    const androidReadyDeadline = Date.now() + 120_000;
    while (Date.now() < androidReadyDeadline) {
      const boot = spawnSync("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        { encoding: "utf8", timeout: 30_000 });
      const packages = spawnSync("adb", ["-s", serial, "shell", "pm", "path", "android"],
        { encoding: "utf8", timeout: 30_000 });
      if (boot.status === 0 && boot.stdout.trim() === "1" &&
        packages.status === 0 && packages.stdout.trim().startsWith("package:")) {
        androidReady = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    assert.equal(androidReady, true, "Android framework/package manager did not become ready.");
    const apk = path.resolve("packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/" +
      "universal/debug/app-universal-debug.apk");
    assert.ok((await stat(apk)).isFile(), "Build the Android E2E APK before the cross-app gate.");
    // The gate is explicitly allowed to reset this disposable emulator. Remove
    // the prior APK before installing so repeated runs do not need space for both
    // package versions at once.
    spawnSync("adb", ["-s", serial, "uninstall", "dev.syncpeer.app"],
      { stdio: "ignore", timeout: 120_000 });
    const installed = spawnSync("adb", ["-s", serial, "install", apk],
      { stdio: "inherit", timeout: 120_000 });
    if (installed.error) throw installed.error;
    assert.equal(installed.status, 0, "Android fixture install failed.");
    const clearAndroid = () => {
      const cleared = spawnSync("adb", ["-s", serial, "shell", "pm", "clear", "dev.syncpeer.app"],
        { encoding: "utf8", timeout: 120_000 });
      if (cleared.error) throw cleared.error;
      assert.equal(cleared.status, 0, "Android fixture reset failed.");
      assert.equal(cleared.stdout.trim(), "Success", "Android fixture did not clear its private data.");
    };
    if (!skipAndroidRecovery) {
      clearAndroid();
      const recovery = spawnSync(process.execPath,
        ["scripts/test-android-e2e.mjs", "--recovery-acceptance"], {
          cwd: process.cwd(), stdio: "inherit", timeout: 300_000,
          env: { ...process.env, ANDROID_SERIAL: serial },
        });
      if (recovery.error) throw recovery.error;
      assert.equal(recovery.status, 0, "Android packaged recovery acceptance failed.");
    }
    clearAndroid();
    const crossApp = await runWithPrivateSecretService("xvfb-run", ["-a", process.execPath,
      "--import", "tsx", path.resolve("node_modules/@wdio/cli/bin/wdio.js"),
      "run", path.resolve("scripts/lan-test/wdio.conf.ts")], {
      SYNCPEER_LAN_SPEC: "scripts/lan-test/packaged-android-pairing.spec.ts",
      SYNCPEER_LAN_APP_BINARY: binary,
      SYNCPEER_LAN_DRIVER: "external",
      SYNCPEER_LAN_MOCHA_TIMEOUT: "900000",
      SYNCPEER_LAN_LOG_LEVEL: "error",
      SYNCPEER_ANDROID_SERIAL: serial,
      XDG_DATA_DIRS: process.env.SYNCPEER_DEB_XDG_DATA_DIRS ?? "/usr/share",
    });
    assert.equal(crossApp, 0, "The packaged desktop-to-Android pairing test failed.");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
