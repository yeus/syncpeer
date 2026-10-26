// Read-only physical-device readiness report. This never installs, clears,
// starts, or modifies the app or device. Run it from the host with adb access.
import { spawnSync } from "node:child_process";

const packageName = "dev.syncpeer.app";
const adbArgs = (args) => process.env.ANDROID_SERIAL
  ? ["-s", process.env.ANDROID_SERIAL, ...args] : args;
const adb = (args, options = {}) => spawnSync("adb", adbArgs(args), {
  encoding: "utf8", ...options,
});
const capture = (args, optional = false) => {
  const result = adb(args);
  if (result.status !== 0) {
    if (optional) return "";
    throw new Error(`adb ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return (result.stdout || "").trim();
};
const shell = (command, optional = false) => capture(["shell", command], optional);
const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

const devices = capture(["devices"]).split("\n").slice(1)
  .map(line => line.trim().split(/\s+/))
  .filter(parts => parts[1] === "device")
  .map(parts => parts[0]);
if (devices.length === 0) {
  console.error("No authorized Android device is connected. Enable USB debugging and authorize this host.");
  process.exit(1);
}
if (devices.length > 1 && !process.env.ANDROID_SERIAL) {
  console.error(`Multiple Android devices are connected. Set ANDROID_SERIAL to one of: ${devices.length} device(s).`);
  process.exit(1);
}

const api = Number(shell("getprop ro.build.version.sdk"));
const model = shell("getprop ro.product.model");
const release = shell("getprop ro.build.version.release");
const abi = shell("getprop ro.product.cpu.abi");
const emulator = shell("getprop ro.kernel.qemu", true) === "1";
const webview = shell("dumpsys webviewupdate", true)
  .split("\n").find(line => line.includes("Current WebView package"))?.trim() ?? "unavailable";
const webviewLabel = webview.match(/\(([^)]+)\)\s*$/)?.[1] ?? webview;
const packagePath = shell(`pm path ${packageName}`, true);
const packageDump = shell(`dumpsys package ${packageName}`, true);
const versionName = /versionName=([^\s]+)/.exec(packageDump)?.[1] ?? "not installed";
const versionCode = /versionCode=(\d+)/.exec(packageDump)?.[1] ?? "n/a";
const storage = lines(shell("df -k /data", true)).at(-1) ?? "";
const storageFields = storage.split(/\s+/);
const availableKb = Number(storageFields[3]);
const background = shell(`cmd appops get ${packageName} RUN_IN_BACKGROUND`, true) || "unavailable";
const notifications = api >= 33
  ? shell(`cmd appops get ${packageName} POST_NOTIFICATION`, true) || "unavailable"
  : "not required below API 33";
const batterySaver = shell("settings get global low_power", true) || "unknown";
const idleWhitelist = shell("dumpsys deviceidle whitelist", true).includes(packageName);
const batteryOptimized = shell("dumpsys deviceidle", true).includes("mDeviceIdleMode=true");

const webviewVersion = Number(webviewLabel.match(/(\d+)/)?.[1] ?? 0);
const warnings = [];
if (api < 26) warnings.push("API < 26: the main app is unsupported below Android 8.0.");
if (webviewVersion > 0 && webviewVersion < 69) {
  warnings.push("WebView is older than Chrome 69; the UI bundle targets the API 26 stock baseline.");
}
if (!packagePath) warnings.push("Syncpeer is not installed; install a debug or release-signed APK before acceptance tests.");
if (Number.isFinite(availableKb) && availableKb < 512 * 1024) warnings.push("Less than 512 MiB free on /data.");
if (/deny|ignore/.test(background)) warnings.push("Background app-op may restrict background work; verify the keep-syncing opt-in.");
if (api >= 33 && /deny|ignore/.test(notifications)) warnings.push("Notification permission is not granted.");

console.log("Syncpeer Android device readiness (read-only)");
console.log(`  Device: ${model} / Android ${release} (API ${api}) / ${abi}`);
console.log(`  Type: ${emulator ? "emulator" : "physical device"}`);
console.log(`  WebView: ${webviewLabel}`);
console.log(`  Syncpeer: ${versionName} (versionCode ${versionCode}), installed=${Boolean(packagePath)}`);
console.log(`  Free /data: ${Number.isFinite(availableKb) ? `${Math.round(availableKb / 1024)} MiB` : "unavailable"}`);
console.log(`  Background app-op: ${background.split("\n")[0]}`);
console.log(`  Notification app-op: ${notifications.split("\n")[0]}`);
console.log(`  Battery saver: low_power=${batterySaver}; doze-whitelisted=${idleWhitelist}; currently-idle=${batteryOptimized}`);
if (warnings.length) {
  console.log("  Warnings:");
  for (const warning of warnings) console.log(`    - ${warning}`);
} else {
  console.log("  Warnings: none");
}
console.log("\nSuggested host-side acceptance commands:");
console.log("  npm run build:android:e2e");
console.log("  npm run android:install:e2e");
console.log("  node --experimental-strip-types scripts/test-android-e2e.mjs --startup-smoke");
console.log("  node --experimental-strip-types scripts/test-android-e2e.mjs --onboarding-smoke  # fresh install only");
console.log("  npm run test:ui:android  # Appium shared onboarding, requires the configured device");
console.log("  npm run test:android:signed-upgrade  # synthetic release signing in a disposable emulator");
if (!emulator) {
  console.log("\nThis is a physical device. Run the onboarding and shared UI acceptance only on");
  console.log("a disposable device or after backing up its local data; the scripts may replace app data.");
}
process.exit(api < 26 ? 1 : 0);
