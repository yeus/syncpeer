import path from "node:path";
import assert from "node:assert/strict";
import { isUiE2eBuildMode } from "../packages/app/buildMode.ts";
import { configureSyncthingNetwork, syncthingListenAddresses, waitForSyncthingGui } from "./lan-test/syncthing.ts";
import { lanAppBinary } from "./lan-test/tauri-runner.ts";

const syntheticTarget = path.resolve("synthetic-cargo-target");
assert.equal(lanAppBinary({}), path.resolve("packages/tauri-shell/src-tauri/target/debug/tauri-shell"));
assert.equal(lanAppBinary({ CARGO_TARGET_DIR: syntheticTarget }), path.join(syntheticTarget, "debug/tauri-shell"));
assert.equal(lanAppBinary({ CARGO_TARGET_DIR: syntheticTarget, SYNCPEER_LAN_RELEASE: "1" }),
  path.join(syntheticTarget, "release/tauri-shell"));
assert.equal(lanAppBinary({ CARGO_TARGET_DIR: "synthetic-cargo-target" }),
  path.resolve("packages/tauri-shell/src-tauri/synthetic-cargo-target/debug/tauri-shell"));

assert.equal(isUiE2eBuildMode("lan-e2e"), true);
assert.equal(isUiE2eBuildMode("android-e2e"), true);
assert.equal(isUiE2eBuildMode("production"), false);

assert.deepEqual(syncthingListenAddresses(22000, "relay"), [
  "tcp4://0.0.0.0:22000",
  "dynamic+https://relays.syncthing.net/endpoint",
]);
assert.deepEqual(syncthingListenAddresses(22000, "tcp"), [
  "tcp4://0.0.0.0:22000",
]);
assert.deepEqual(syncthingListenAddresses(22000, "quic"), [
  "quic4://0.0.0.0:22000",
]);
assert.deepEqual(syncthingListenAddresses(22000, "tcp-quic"), [
  "tcp4://0.0.0.0:22000",
  "quic4://0.0.0.0:22000",
]);
assert.equal(
  syncthingListenAddresses(22000, "relay").some((address) =>
    address.startsWith("relay://")
  ),
  false,
);
assert.deepEqual(syncthingListenAddresses(22000, "tcp", "127.0.0.1"),
  ["tcp4://127.0.0.1:22000"]);

const optionsXml = "<configuration><options>\n" +
  "<globalAnnounceEnabled>true</globalAnnounceEnabled>\n" +
  "<localAnnounceEnabled>true</localAnnounceEnabled>\n" +
  "<relaysEnabled>true</relaysEnabled>\n" +
  "<natEnabled>true</natEnabled>\n" +
  "</options></configuration>";
const isolated = configureSyncthingNetwork(optionsXml, false, false);
for (const tag of ["globalAnnounceEnabled", "localAnnounceEnabled", "relaysEnabled", "natEnabled"]) {
  assert.match(isolated, new RegExp(`<${tag}>false</${tag}>`));
}

let attempts = 0;
const ready = await waitForSyncthingGui(async () => {
  if (attempts++ < 2) throw new Error("Synthetic connection refusal.");
  return { myID: "SYNTHETIC" };
}, () => false, 2000);
assert.equal(ready.myID, "SYNTHETIC");
assert.equal(attempts, 4, "GUI readiness must tolerate a short restart window and confirm stability");
await assert.rejects(waitForSyncthingGui(async () => {
  throw new Error("Synthetic connection refusal.");
}, () => true, 1000), /fixture exited/i);

console.log("Test harness diagnostics passed.");
