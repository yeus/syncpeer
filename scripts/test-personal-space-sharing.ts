import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFolderShareDevices, settingsFolderDevices, signOwnedRosterUpdate, verifyOwnedRoster } from
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

test("owned roster updates require an active signer and reject rollback", async () => {
  const subtle = globalThis.crypto.subtle;
  const first = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const second = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = async (key: CryptoKey) => Buffer.from(await subtle.exportKey("spki", key)).toString("base64");
  const genesis = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: await publicKey(first.publicKey) }],
  });
  const next = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [genesis.devices[0], { id: "laptop", syncthingId: "LAPTOP", state: "active",
      signingKey: await publicKey(second.publicKey) }],
  });
  assert.deepEqual((await verifyOwnedRoster(subtle, [genesis, next], await publicKey(first.publicKey))).devices,
    next.devices);
  await assert.rejects(verifyOwnedRoster(subtle, [genesis], await publicKey(first.publicKey), next.hash), /rollback/i);
  const forged = await signOwnedRosterUpdate(subtle, second.privateKey, {
    sequence: 3, previous: next.hash, signer: "phone", devices: next.devices,
  });
  await assert.rejects(verifyOwnedRoster(subtle, [genesis, next, forged], await publicKey(first.publicKey)), /signature/i);
});

test("a recovery key can authorize a replacement after every device is lost", async () => {
  const subtle = globalThis.crypto.subtle;
  const first = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const recovery = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const replacement = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = async (key: CryptoKey) => Buffer.from(await subtle.exportKey("spki", key)).toString("base64");
  const genesis = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone", recoveryKey: await publicKey(recovery.publicKey),
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: await publicKey(first.publicKey) }],
  });
  const restored = await signOwnedRosterUpdate(subtle, recovery.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "recovery", recoveryKey: genesis.recoveryKey,
    devices: [{ ...genesis.devices[0], state: "revoked" },
      { id: "replacement", syncthingId: "NEW", state: "active", signingKey: await publicKey(replacement.publicKey) }],
  });
  assert.deepEqual((await verifyOwnedRoster(subtle, [genesis, restored], await publicKey(first.publicKey))).devices,
    restored.devices);
});
