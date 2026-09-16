import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFolderShareDevices, settingsFolderDevices } from
  "../packages/core/dist/sync/personalSpaceSharing.js";

const roster = [
  { id: "phone", syncthingId: "PHONE", state: "active" as const, retiredSyncthingIds: ["OLD"] },
  { id: "laptop", syncthingId: "LAPTOP", state: "active" as const },
];

test("personal-space shares expand to active owned Syncthing IDs", () => {
  assert.deepEqual(resolveFolderShareDevices([{ kind: "personal-space" }], roster), ["LAPTOP", "PHONE"]);
  assert.deepEqual(settingsFolderDevices(roster), ["LAPTOP", "PHONE"]);
});

test("individual external shares do not receive personal settings", () => {
  assert.deepEqual(resolveFolderShareDevices([{ kind: "device", syncthingId: "EXTERNAL" }], roster), ["EXTERNAL"]);
  assert.deepEqual(settingsFolderDevices(roster), ["LAPTOP", "PHONE"]);
});

test("revoked owned identities cannot re-enter through an individual target", () => {
  assert.deepEqual(resolveFolderShareDevices([{ kind: "personal-space" },
    { kind: "device", syncthingId: "OLD" }, { kind: "device", syncthingId: "EXTERNAL" }], roster),
  ["EXTERNAL", "LAPTOP", "PHONE"]);
});

test("retired IDs cannot impersonate external devices after a replacement", () => {
  assert.deepEqual(resolveFolderShareDevices([{ kind: "device", syncthingId: "OLD" }], roster), []);
});
