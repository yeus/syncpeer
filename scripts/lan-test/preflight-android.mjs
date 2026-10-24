import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";

const serial = process.env.ANDROID_SERIAL?.trim() ?? "";
assert.match(serial, /^emulator-\d+$/, "ANDROID_SERIAL must identify a disposable emulator (emulator-NNNN).");

const adb = (...args) => {
  try {
    return execFileSync("adb", ["-s", serial, ...args], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`Could not reach emulator ${serial} with adb. Start the emulator and check adb devices.`);
  }
};

assert.equal(adb("get-state"), "device", `Emulator ${serial} is not online.`);
assert.equal(adb("shell", "getprop", "ro.kernel.qemu"), "1",
  "Refusing to run this onboarding test against a physical Android device.");
assert.match(adb("shell", "pm", "path", "dev.syncpeer.app"), /^package:/,
  "Install the Syncpeer Android E2E APK on this disposable emulator first.");

const executable = process.env.SYNCPEER_UI_CHROMEDRIVER?.trim();
if (executable) await access(executable);

const host = process.env.SYNCPEER_APPIUM_HOST ?? "127.0.0.1";
const port = Number(process.env.SYNCPEER_APPIUM_PORT ?? 4723);
const basePath = (process.env.SYNCPEER_APPIUM_BASE_PATH ?? "/").replace(/\/$/, "");
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "Invalid Appium port.");

const endpoint = new URL(`http://${host}:${port}${basePath}/status`);
const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
  .catch(cause => { throw new Error("Appium is not reachable; start Appium with UiAutomator2.", { cause }); });
assert.ok(response.ok, `Appium status returned HTTP ${response.status}`);
const status = await response.json();
assert.ok(status?.value?.ready !== false, "Appium is running but reports not ready.");
console.log(`Android test preflight OK: ${serial}, Syncpeer installed, Appium reachable.`);
