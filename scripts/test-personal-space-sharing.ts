import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnedDeviceIdentity, createOwnedRecoveryKit, openOwnedRecoveryKit, openOwnedDeviceSigningKey,
  resolveApprovedPeerDeviceIds, resolveFolderShareDevices,
  settingsFolderDevices, signSpaceMembershipUpdate, verifySpaceDeviceMembership } from
  "../packages/core/dist/sync/personalSpaceSharing.js";

const subtle = globalThis.crypto.subtle;
const signingKeyPair = () => subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = async (key: CryptoKey) =>
  Buffer.from(await subtle.exportKey("spki", key)).toString("base64");

const membership = [
  { id: "phone", syncthingId: "PHONE", state: "active" as const,
    retiredSyncthingIds: ["OLD"], signingKey: "cGhvbmU=" },
  { id: "laptop", syncthingId: "LAPTOP", state: "active" as const, signingKey: "bGFwdG9w" },
];

test("offline recovery signing kit protects its key and rejects tampering", async () => {
  const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
  const kit = await createOwnedRecoveryKit(subtle, randomBytes, "synthetic-offline-kit-password");
  assert.equal(JSON.stringify(kit).includes("PRIVATE KEY"), false);
  await assert.rejects(openOwnedRecoveryKit(subtle, kit, "wrong-password"), /recovery kit/i);
  const privateKey = await openOwnedRecoveryKit(subtle, kit, "synthetic-offline-kit-password");
  const challenge = new TextEncoder().encode("synthetic recovery proof");
  const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
  const publicKey = await subtle.importKey("spki", Buffer.from(kit.publicKey, "base64"),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge), true);
  await assert.rejects(openOwnedRecoveryKit(subtle, { ...kit, publicKey: "invalid" },
    "synthetic-offline-kit-password"), /recovery kit/i);
});

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
  assert.deepEqual(resolveFolderShareDevices([{ kind: "personal-space" }], membership), ["LAPTOP", "PHONE"]);
  assert.deepEqual(settingsFolderDevices(membership), ["LAPTOP", "PHONE"]);
});

test("individual external shares do not receive personal settings", () => {
  assert.deepEqual(resolveFolderShareDevices([{ kind: "device", syncthingId: "EXTERNAL" }], membership), ["EXTERNAL"]);
  assert.deepEqual(settingsFolderDevices(membership), ["LAPTOP", "PHONE"]);
});

test("revoked owned identities cannot re-enter through an individual target", () => {
  assert.deepEqual(resolveFolderShareDevices([{ kind: "personal-space" },
    { kind: "device", syncthingId: "OLD" }, { kind: "device", syncthingId: "EXTERNAL" }], membership),
  ["EXTERNAL", "LAPTOP", "PHONE"]);
});

test("retired IDs cannot impersonate external devices after a replacement", () => {
  assert.deepEqual(resolveFolderShareDevices([{ kind: "device", syncthingId: "OLD" }], membership), []);
  assert.deepEqual(resolveFolderShareDevices([{ kind: "device", syncthingId: "O-L-D" }], membership), []);
});

test("incoming authorization excludes revoked identities but permits a selected external peer", () => {
  const devices = membership.map(device => device.id === "laptop" ? { ...device, state: "revoked" as const } : device);
  assert.deepEqual(resolveApprovedPeerDeviceIds("LAPTOP", devices), ["PHONE"]);
  assert.deepEqual(resolveApprovedPeerDeviceIds("L-A-P-T-O-P", devices), ["PHONE"]);
  assert.deepEqual(resolveApprovedPeerDeviceIds("EXTERNAL", devices), ["EXTERNAL", "PHONE"]);
});

test("space device membership updates require an active signer and reject rollback", async () => {
  const first = await signingKeyPair();
  const second = await signingKeyPair();
  const genesis = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: await publicKey(first.publicKey) }],
  });
  const next = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [genesis.devices[0], { id: "laptop", syncthingId: "LAPTOP", state: "active",
      signingKey: await publicKey(second.publicKey) }],
  });
  assert.deepEqual((await verifySpaceDeviceMembership(subtle, [genesis, next], await publicKey(first.publicKey))).devices,
    next.devices);
  await assert.rejects(verifySpaceDeviceMembership(subtle, [genesis], await publicKey(first.publicKey), next.hash), /rollback/i);
  const forged = await signSpaceMembershipUpdate(subtle, second.privateKey, {
    sequence: 3, previous: next.hash, signer: "phone", devices: next.devices,
  });
  await assert.rejects(verifySpaceDeviceMembership(subtle, [genesis, next, forged], await publicKey(first.publicKey)), /signature/i);
});

test("a recovery key can authorize a replacement after every device is lost", async () => {
  const first = await signingKeyPair();
  const recovery = await signingKeyPair();
  const replacement = await signingKeyPair();
  const genesis = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone", recoveryKey: await publicKey(recovery.publicKey),
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: await publicKey(first.publicKey) }],
  });
  const restored = await signSpaceMembershipUpdate(subtle, recovery.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "recovery", recoveryKey: genesis.recoveryKey,
    devices: [{ ...genesis.devices[0], state: "revoked" },
      { id: "replacement", syncthingId: "NEW", state: "active", signingKey: await publicKey(replacement.publicKey) }],
  });
  assert.deepEqual((await verifySpaceDeviceMembership(subtle, [genesis, restored], await publicKey(first.publicKey))).devices,
    restored.devices);
});

test("each space device slot requires one unique permanent device key", async () => {
  const first = await signingKeyPair();
  const replacement = await signingKeyPair();
  const firstPublic = await publicKey(first.publicKey);
  await assert.rejects(signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active" }],
  }), /device membership/i);
  await assert.rejects(signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic },
      { id: "laptop", syncthingId: "LAPTOP", state: "active", signingKey: firstPublic }],
  }), /device membership/i);
  await assert.rejects(signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic },
      { id: "alias", syncthingId: "P-H-O-N-E", state: "active",
        signingKey: await publicKey(replacement.publicKey) }],
  }), /device membership/i);
  const genesis = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic }],
  });
  const changedKey = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [{ ...genesis.devices[0], signingKey: await publicKey(replacement.publicKey) }],
  });
  await assert.rejects(verifySpaceDeviceMembership(subtle, [genesis, changedKey], firstPublic), /device key changed/i);
});

test("membership history cannot forget or resurrect a revoked device", async () => {
  const first = await signingKeyPair();
  const second = await signingKeyPair();
  const firstPublic = await publicKey(first.publicKey);
  const genesis = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic },
      { id: "laptop", syncthingId: "LAPTOP", state: "active", signingKey: await publicKey(second.publicKey) }],
  });
  const revoked = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [genesis.devices[0], { ...genesis.devices[1], state: "revoked" }],
  });
  const forgotten = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 3, previous: revoked.hash, signer: "phone", devices: [genesis.devices[0]],
  });
  await assert.rejects(verifySpaceDeviceMembership(subtle, [genesis, revoked, forgotten], firstPublic), /device disappeared/i);
  const resurrected = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 3, previous: revoked.hash, signer: "phone",
    devices: [genesis.devices[0], { ...genesis.devices[1], state: "active" }],
  });
  await assert.rejects(verifySpaceDeviceMembership(subtle, [genesis, revoked, resurrected], firstPublic), /revoked device/i);
});

test("certificate replacement retains the stable slot and records the retired ID", async () => {
  const first = await signingKeyPair();
  const firstPublic = await publicKey(first.publicKey);
  const genesis = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: [{ id: "phone", syncthingId: "PHONE", state: "active", signingKey: firstPublic }],
  });
  const invalidReplacement = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [{ ...genesis.devices[0], syncthingId: "PHONE-NEW" }],
  });
  await assert.rejects(verifySpaceDeviceMembership(subtle, [genesis, invalidReplacement], firstPublic), /retired identity/i);
  const validReplacement = await signSpaceMembershipUpdate(subtle, first.privateKey, {
    sequence: 2, previous: genesis.hash, signer: "phone",
    devices: [{ ...genesis.devices[0], syncthingId: "PHONE-NEW", retiredSyncthingIds: ["PHONE"] }],
  });
  assert.equal((await verifySpaceDeviceMembership(subtle, [genesis, validReplacement], firstPublic)).devices[0].syncthingId,
    "PHONE-NEW");
});
