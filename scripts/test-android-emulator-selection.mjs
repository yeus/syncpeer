import assert from "node:assert/strict";
import { freshMatrixPrefix, newEmulatorSerials } from "./test-android.mjs";
import { emulatorArguments, profile } from "./android-emulator.mjs";

const args = emulatorArguments(profile("modern", "synthetic-qa"), ["-no-window"]);
assert.equal(args[args.indexOf("-partition-size") + 1], "10240");
assert.ok(args.includes("-no-window"));
const firstMatrixPrefix = freshMatrixPrefix();
const secondMatrixPrefix = freshMatrixPrefix();
assert.match(firstMatrixPrefix, /^syncpeer-matrix-\d+-[0-9a-f]{8}$/);
assert.notEqual(firstMatrixPrefix, secondMatrixPrefix,
  "The Android matrix must never reuse an existing disposable emulator by default.");
assert.equal(profile("modern", firstMatrixPrefix).avdName.endsWith("-api36-play"), true);


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
