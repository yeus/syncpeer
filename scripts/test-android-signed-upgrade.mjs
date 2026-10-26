// Release-signing + in-place upgrade acceptance with a synthetic keystore.
// This never touches production signing material. It builds two x86_64 release
// APKs, verifies same-signature data preservation, and proves a different
// signature is rejected. Run it inside the project Nix dev shell.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageName = "dev.syncpeer.app";
const avdName = "syncpeer-signed-upgrade-api29";
const systemImage = "system-images;android-29;google_apis;x86_64";
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
const javaHome = process.env.JAVA_HOME || "";
const adbPath = path.join(androidHome, "platform-tools", "adb");
const emulatorPath = path.join(androidHome, "emulator", "emulator");
const avdManagerPath = path.join(androidHome, "cmdline-tools", "13.0", "bin", "avdmanager");
const buildTools = path.join(androidHome, "build-tools", "35.0.0");
const apksignerPath = path.join(buildTools, "apksigner");
const tauriConfigPath = path.join(root, "packages/tauri-shell/src-tauri/tauri.conf.json");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-signed-upgrade-"));
const keystoreA = path.join(temp, "upgrade-a.jks");
const keystoreB = path.join(temp, "upgrade-b.jks");
const passwordA = crypto.randomBytes(18).toString("hex");
const passwordB = crypto.randomBytes(18).toString("hex");
const alias = "syncpeer-upgrade";
const originalTauriConfig = fs.readFileSync(tauriConfigPath, "utf8");
let emulator = null;
let emulatorLog = null;

const fail = message => { throw new Error(message); };
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed with status ${result.status}`);
  return result;
};
const capture = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
};
const adb = (...args) => capture(adbPath, args);
const adbRaw = (...args) => spawnSync(adbPath, args, { encoding: "utf8" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const requireTool = (value, label) => {
  if (!value || !fs.existsSync(value)) fail(`${label} is unavailable: ${value || "(unset)"}`);
};

const stopEmulator = async () => {
  if (!emulator) return;
  try { adbRaw("emu", "kill"); } catch { /* Best effort. */ }
  const deadline = Date.now() + 30_000;
  while (emulator.exitCode === null && Date.now() < deadline) await sleep(250);
  if (emulator.exitCode === null) emulator.kill("SIGTERM");
  emulator = null;
  if (emulatorLog !== null) { try { fs.closeSync(emulatorLog); } catch { /* Best effort. */ } emulatorLog = null; }
  try { adbRaw("kill-server"); } catch { /* Best effort. */ }
};

const waitForBoot = async () => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      if (adb("shell", "getprop", "sys.boot_completed").trim() === "1") return;
    } catch { /* Booting. */ }
    await sleep(1_000);
  }
  fail("Signed-upgrade emulator did not finish booting.");
};

const listSerials = () => capture(adbPath, ["devices"]).split("\n").slice(1)
  .map(line => line.trim().split(/\s+/))
  .filter(parts => parts[1] === "device")
  .map(parts => parts[0]);

const startEmulator = async () => {
  const knownSerials = new Set(listSerials());
  const created = spawnSync(avdManagerPath, ["create", "avd", "--name", avdName,
    "--package", systemImage, "--device", "pixel_2", "--force"],
  { cwd: root, input: "no\n", stdio: ["pipe", "inherit", "inherit"] });
  if (created.status !== 0) fail("Could not create the signed-upgrade AVD.");
  const logPath = path.join(temp, "emulator.log");
  emulatorLog = fs.openSync(logPath, "w");
  emulator = spawn(emulatorPath, ["-avd", avdName, "-no-window", "-no-audio", "-no-metrics",
    "-no-snapshot", "-gpu", "swiftshader_indirect", "-no-boot-anim"],
  { cwd: root, stdio: ["ignore", emulatorLog, emulatorLog] });
  await waitForBoot();
  const serial = listSerials().find(value => value.startsWith("emulator-") && !knownSerials.has(value));
  if (!serial) fail("Signed-upgrade emulator did not appear as a new emulator device.");
  process.env.ANDROID_SERIAL = serial;
  // The google_apis image is userdebug; root is required only for the private
  // app-data marker and for deterministic Wi-Fi state.
  adb("root");
  await sleep(2_000);
  adb("wait-for-device");
  if (!adb("shell", "id").includes("uid=0")) fail("Signed-upgrade emulator did not enter adb root mode.");
};

const packageInfo = () => {
  const dump = adb("shell", "dumpsys", "package", packageName);
  const versionCode = /versionCode=(\d+)/.exec(dump)?.[1];
  const versionName = /versionName=([^\s]+)/.exec(dump)?.[1];
  const firstInstallTime = /firstInstallTime=(.+)/.exec(dump)?.[1]?.trim();
  if (!versionCode || !versionName || !firstInstallTime) fail("Could not read package version metadata.");
  return { versionCode: Number(versionCode), versionName, firstInstallTime };
};

const launchApp = async () => {
  adb("shell", "monkey", "-p", packageName, "1");
  await sleep(8_000);
  const pid = adb("shell", "pidof", packageName).trim();
  if (!pid) fail("Signed-upgrade app process did not start.");
  const focus = adb("shell", "dumpsys", "activity", "activities");
  if (!focus.includes(packageName)) fail("Signed-upgrade app did not reach the foreground.");
};

const writeMarker = () => {
  const markerPath = "/data/data/dev.syncpeer.app/files/syncpeer-upgrade-marker";
  adb("shell", "mkdir", "-p", "/data/data/dev.syncpeer.app/files");
  adb("shell", `printf 'upgrade-marker-v1' > ${markerPath}`);
  const uid = adb("shell", "stat", "-c", "%u", "/data/data/dev.syncpeer.app").trim();
  if (!/^\d+$/.test(uid)) fail("Could not read the app UID for the upgrade marker.");
  adb("shell", "chown", `${uid}:${uid}`, markerPath);
  adb("shell", "chmod", "600", markerPath);
  return markerPath;
};

const readMarker = (markerPath) => adb("shell", "cat", markerPath).trim();

const buildRelease = (label, version, keystorePath, keystorePassword) => {
  const config = JSON.parse(originalTauriConfig);
  config.version = version;
  fs.writeFileSync(tauriConfigPath, JSON.stringify(config, null, 2) + "\n");
  const output = path.join(temp, label + ".apk");
  try {
    run("bash", ["scripts/build-android-prod-with-secrets.sh"], {
      env: {
        ...process.env,
        SYNCPEER_ANDROID_TARGET: "x86_64",
        ANDROID_KEYSTORE_PATH: keystorePath,
        ANDROID_KEYSTORE_PASSWORD: keystorePassword,
        ANDROID_KEY_ALIAS: alias,
        ANDROID_KEY_PASSWORD: keystorePassword,
      },
    });
    const candidates = [
      path.join(root, "syncpeer-android-release-x86_64.apk"),
      path.join(root, "dist", "syncpeer-android-release-x86_64.apk"),
    ];
    const source = candidates.find(candidate => fs.existsSync(candidate));
    if (!source) fail(`Release build ${label} did not produce an x86_64 APK.`);
    fs.copyFileSync(source, output);
  } finally {
    fs.writeFileSync(tauriConfigPath, originalTauriConfig);
    for (const candidate of [
      path.join(root, "syncpeer-android-release-x86_64.apk"),
      path.join(root, "dist", "syncpeer-android-release-x86_64.apk"),
    ]) {
      try { fs.rmSync(candidate, { force: true }); } catch { /* Generated artifact. */ }
    }
  }
  return output;
};

const certificateDigest = (apk) => {
  const output = capture(apksignerPath, ["verify", "--print-certs", apk]);
  const digest = /SHA-256 digest:\s*([0-9a-f]+)/i.exec(output)?.[1];
  if (!digest) fail(`Could not read the signing certificate from ${apk}.`);
  return digest;
};

const signWithDifferentKey = (source, target) => {
  const env = {
    ...process.env,
    UPGRADE_STORE_B: passwordB,
    UPGRADE_KEY_B: passwordB,
  };
  run(apksignerPath, ["sign", "--ks", keystoreB, "--ks-key-alias", alias,
    "--ks-pass", "env:UPGRADE_STORE_B", "--key-pass", "env:UPGRADE_KEY_B",
    "--out", target, source], { env });
  run(apksignerPath, ["verify", target]);
};

const main = async () => {
  requireTool(adbPath, "adb");
  requireTool(emulatorPath, "Android emulator");
  requireTool(avdManagerPath, "avdmanager");
  requireTool(apksignerPath, "apksigner");
  requireTool(path.join(javaHome, "bin", "keytool"), "keytool");
  delete process.env.ADB_SERVER_SOCKET;

  run(path.join(javaHome, "bin", "keytool"), ["-genkeypair", "-noprompt",
    "-keystore", keystoreA, "-alias", alias, "-storepass", passwordA, "-keypass", passwordA,
    "-dname", "CN=Syncpeer Upgrade Acceptance A", "-keyalg", "RSA", "-keysize", "2048",
    "-validity", "3650"]);
  run(path.join(javaHome, "bin", "keytool"), ["-genkeypair", "-noprompt",
    "-keystore", keystoreB, "-alias", alias, "-storepass", passwordB, "-keypass", passwordB,
    "-dname", "CN=Syncpeer Upgrade Acceptance B", "-keyalg", "RSA", "-keysize", "2048",
    "-validity", "3650"]);

  await startEmulator();
  try { adb("uninstall", packageName); } catch { /* Fresh emulator. */ }
  const apkA = buildRelease("upgrade-a", "0.6.1", keystoreA, passwordA);
  run(adbPath, ["install", "--no-streaming", apkA]);
  const first = packageInfo();
  if (first.versionName !== "0.6.1") fail(`Unexpected first version: ${first.versionName}`);
  await launchApp();
  const markerPath = writeMarker();

  const apkB = buildRelease("upgrade-b", "0.6.2", keystoreA, passwordA);
  run(adbPath, ["install", "--no-streaming", "-r", apkB]);
  const second = packageInfo();
  if (second.versionCode <= first.versionCode) {
    fail(`Upgrade versionCode did not advance: ${first.versionCode} -> ${second.versionCode}`);
  }
  if (second.firstInstallTime !== first.firstInstallTime) {
    fail("Same-signature upgrade changed firstInstallTime; this was not an in-place upgrade.");
  }
  if (readMarker(markerPath) !== "upgrade-marker-v1") {
    fail("Same-signature upgrade did not preserve private app data.");
  }
  await launchApp();

  const wrongApk = path.join(temp, "upgrade-wrong-key.apk");
  signWithDifferentKey(apkB, wrongApk);
  if (certificateDigest(apkB) === certificateDigest(wrongApk)) {
    fail("Synthetic negative-test APK reused the original signing certificate.");
  }
  const rejected = adbRaw("install", "--no-streaming", "-r", wrongApk);
  if (rejected.status === 0) {
    fail("Different-signature upgrade was accepted by Android.");
  }
  const afterRejected = packageInfo();
  if (afterRejected.versionCode !== second.versionCode ||
    readMarker(markerPath) !== "upgrade-marker-v1") {
    fail("Rejected different-signature install changed the installed app or its data.");
  }
  console.log(`Android signed upgrade acceptance passed: ${first.versionName} -> ` +
    `${second.versionName}, release signature preserved private data, and a different ` +
    `signature was rejected (${(rejected.stderr || rejected.stdout || "").trim().split("\n").at(-1)}).`);
};

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  await stopEmulator();
  try { run(avdManagerPath, ["delete", "avd", "-n", avdName], { stdio: "ignore" }); }
  catch { /* Best effort. */ }
  fs.rmSync(temp, { recursive: true, force: true });
});
