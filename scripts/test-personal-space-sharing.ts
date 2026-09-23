import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnedDeviceIdentity, openOwnedDeviceSigningKey, resolveApprovedPeerDeviceIds, resolveFolderShareDevices,
  settingsFolderDevices, signOwnedRosterUpdate, verifyOwnedRoster } from
  "../packages/core/dist/sync/personalSpaceSharing.js";

const subtle = globalThis.crypto.subtle;
const signingKeyPair = () => subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = async (key: CryptoKey) =>
  Buffer.from(await subtle.exportKey("spki", key)).toString("base64");

const roster = [
  { id: "phone", syncthingId: "PHONE", state: "active" as const,
    retiredSyncthingIds: ["OLD"], signingKey: "cGhvbmU=" },
  { id: "laptop", syncthingId: "LAPTOP", state: "active" as const, signingKey: "bGFwdG9w" },
];

test("each device generates its own persistent signing identity", async () => {
  const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
  const first = await createOwnedDeviceIdentity(subtle, randomBytes, "PHONE");
  const second = await createOwnedDeviceIdentity(subtle, randomBytes, "LAPTOP");
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.signingKey, second.signingKey);
  assert.equal((await openOwnedDeviceSigningKey(subtle, first)).type, "private");
  await assert.rejects(openOwnedDeviceSigningKey(subtle, { ...first, privateKey: second.privateKey }), /identity/i);
});

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

test("incoming authorization excludes revoked identities but permits a selected external peer", () => {
  const devices = roster.map(device => device.id === "laptop" ? { ...device, state: "revoked" as const } : device);
  assert.deepEqual(resolveApprovedPeerDeviceIds("LAPTOP", devices), ["PHONE"]);
  assert.deepEqual(resolveApprovedPeerDeviceIds("EXTERNAL", devices), ["EXTERNAL", "PHONE"]);
});

test("owned roster updates require an active signer and reject rollback", async () => {
  const first = await signingKeyPair();
  const second = await signingKeyPair();
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
  const first = await signingKeyPair();
  const recovery = await signingKeyPair();
  const replacement = await signingKeyPair();
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

test("each roster slot requires one unique permanent device key", async () => {
  const first = await signingKeyPair();
  const replacement = await signingKeyPair();
  const firstPublic = await publicKey(first.publicKey);
  await assert.rejects(signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active" }],
  }), /device roster/i);
  await assert.rejects(signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic },
      { id: "laptop", syncthingId: "LAPTOP", state: "active", signingKey: firstPublic }],
  }), /device roster/i);
  const genesis = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic }],
  });
  const changedKey = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [{ ...genesis.devices[0], signingKey: await publicKey(replacement.publicKey) }],
  });
  await assert.rejects(verifyOwnedRoster(subtle, [genesis, changedKey], firstPublic), /device key changed/i);
});

test("roster history cannot forget or resurrect a revoked device", async () => {
  const first = await signingKeyPair();
  const second = await signingKeyPair();
  const firstPublic = await publicKey(first.publicKey);
  const genesis = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic },
      { id: "laptop", syncthingId: "LAPTOP", state: "active", signingKey: await publicKey(second.publicKey) }],
  });
  const revoked = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [genesis.devices[0], { ...genesis.devices[1], state: "revoked" }],
  });
  const forgotten = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 3, previous: revoked.hash, signer: "phone", devices: [genesis.devices[0]],
  });
  await assert.rejects(verifyOwnedRoster(subtle, [genesis, revoked, forgotten], firstPublic), /device disappeared/i);
  const resurrected = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 3, previous: revoked.hash, signer: "phone",
    devices: [genesis.devices[0], { ...genesis.devices[1], state: "active" }],
  });
  await assert.rejects(verifyOwnedRoster(subtle, [genesis, revoked, resurrected], firstPublic), /revoked device/i);
});

test("certificate replacement retains the stable slot and records the retired ID", async () => {
  const first = await signingKeyPair();
  const firstPublic = await publicKey(first.publicKey);
  const genesis = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic }],
  });
  const invalidReplacement = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [{ ...genesis.devices[0], syncthingId: "PHONE-NEW" }],
  });
  await assert.rejects(verifyOwnedRoster(subtle, [genesis, invalidReplacement], firstPublic), /retired identity/i);
  const validReplacement = await signOwnedRosterUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [{ ...genesis.devices[0], syncthingId: "PHONE-NEW", retiredSyncthingIds: ["PHONE"] }],
  });
  assert.equal((await verifyOwnedRoster(subtle, [genesis, validReplacement], firstPublic)).devices[0].syncthingId,
    "PHONE-NEW");
});
