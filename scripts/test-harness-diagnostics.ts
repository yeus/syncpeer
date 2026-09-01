import assert from "node:assert/strict";
import { syncthingListenAddresses } from "./lan-test/syncthing.ts";

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
