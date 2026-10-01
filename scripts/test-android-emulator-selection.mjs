import assert from "node:assert/strict";
import { newEmulatorSerials } from "./test-android.mjs";

const known = ["emulator-5554:29"];
assert.deepEqual(newEmulatorSerials([
  "emulator-5554          device transport_id:29",
  "emulator-5556          offline",
], known), []);
assert.deepEqual(newEmulatorSerials([
  "emulator-5554          device transport_id:29",
  "emulator-5556          device transport_id:30",
  "physical-device       device transport_id:31",
], known), ["emulator-5556"]);
assert.deepEqual(newEmulatorSerials([
  "emulator-5554          device transport_id:29",
], known), []);
assert.deepEqual(newEmulatorSerials([
  "emulator-5554          device transport_id:35",
], known), ["emulator-5554"], "A restarted AVD can reuse its adb serial with a new transport.");
console.log("Android emulator serial selection regression passed.");
