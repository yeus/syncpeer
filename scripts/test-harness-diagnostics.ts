import assert from "node:assert/strict";
import { isUiE2eBuildMode } from "../packages/app/buildMode.ts";
import { syncthingListenAddresses } from "./lan-test/syncthing.ts";

assert.equal(isUiE2eBuildMode("lan-e2e"), true);
assert.equal(isUiE2eBuildMode("android-e2e"), true);
assert.equal(isUiE2eBuildMode("production"), false);

assert.deepEqual(syncthingListenAddresses(22000, false), [
  "tcp4://0.0.0.0:22000",
  "dynamic+https://relays.syncthing.net/endpoint",
]);
assert.deepEqual(syncthingListenAddresses(22000, true), [
  "tcp4://0.0.0.0:22000",
]);
assert.equal(
  syncthingListenAddresses(22000, false).some((address) =>
    address.startsWith("relay://")
  ),
  false,
);

console.log("Test harness diagnostics passed.");
