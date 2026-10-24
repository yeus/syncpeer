import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Destructive reset is intentionally limited to the dedicated disposable test AVD.
// Never use this with personal Android devices or unrelated emulator profiles.
const serial = process.env.ANDROID_SERIAL?.trim() ?? "";
assert.match(serial, /^emulator-\d+$/, "Provide ANDROID_SERIAL for a disposable emulator.");
const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
}).trim();
assert.equal(adb("get-state"), "device");
assert.equal(adb("shell", "getprop", "ro.kernel.qemu"), "1");
const avd = adb("emu", "avd", "name").split(/\r?\n/)[0];
assert.equal(avd, "syncpeer-unified-e2e",
  "Refusing to clear data outside the dedicated syncpeer-unified-e2e AVD.");
assert.match(adb("shell", "pm", "path", "dev.syncpeer.app"), /^package:/);
assert.equal(adb("shell", "pm", "clear", "dev.syncpeer.app"), "Success");
// Explicitly start the fresh app before Appium attaches; noReset may otherwise
// reuse a WebView session while the emulator launcher is foreground.
assert.match(adb("shell", "am", "start", "-n", "dev.syncpeer.app/.MainActivity"), /Starting: Intent|Warning: Activity not started/);
console.log(`Reset isolated Syncpeer fixture on ${avd} (${serial}).`);
