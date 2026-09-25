import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPersonalSpaceSettings,
  folderRetentionPolicyFromSettings,
  materializePersonalSpaceSettings,
  normalizePersonalSpaceSettings,
  setDeviceFolderSelection,
  updateFolderRetention,
} from "../packages/core/dist/sync/personalSpaceSettings.js";
import { createOwnedDeviceIdentity, signSpaceMembershipUpdate } from
  "../packages/core/dist/sync/personalSpaceSharing.js";
import { signPersonalSpaceChange } from "../packages/core/dist/sync/personalSpaceChanges.js";

const trustedOwner = async () => {
  const identity = await createOwnedDeviceIdentity(crypto.subtle,
    size => crypto.getRandomValues(new Uint8Array(size)), "OWNER");
  const genesis = await signSpaceMembershipUpdate(crypto.subtle,
    await crypto.subtle.importKey("pkcs8", Buffer.from(identity.privateKey, "base64"),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    { sequence: 1, previous: null, signer: identity.id,
      devices: [{ id: identity.id, syncthingId: identity.syncthingId,
        state: "active", signingKey: identity.signingKey }] });
  return { deviceId: identity.id,
    privateKey: await crypto.subtle.importKey("pkcs8", Buffer.from(identity.privateKey, "base64"),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    trust: { genesisKey: identity.signingKey, knownHead: genesis.hash, updates: [genesis] } };
};

test("a verified journal applies shared policy and only this device's favorites", async () => {
  const { deviceId, trust, privateKey } = await trustedOwner();
  const changes = await Promise.all([
    { id: "retention", deviceId, path: ["folders", "photos", "retention"], parents: [],
      value: { minimumCopies: 3, retentionRevision: 2,
        holders: [{ id: "OWNER", kind: "syncpeer" }, { id: "NAS", kind: "syncthing" }] } },
    { id: "selection", deviceId, path: ["folders", "photos", "devices", deviceId], parents: [],
      value: { favorites: [{ key: "file:photos:a", folderId: "photos", path: "a", name: "A", kind: "file" }],
        exclusions: [] } },
  ].map(change => signPersonalSpaceChange(crypto.subtle, privateKey, change)));
  const result = await materializePersonalSpaceSettings(crypto.subtle, trust, changes);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.settings?.folders.photos.minimumCopies, 3);
  assert.equal(result.settings?.folders.photos.devices[deviceId].favorites[0]?.path, "a");
  assert.equal(result.settings?.rosterHead, trust.knownHead);
  await assert.rejects(materializePersonalSpaceSettings(crypto.subtle, trust,
    [{ ...changes[0], value: { minimumCopies: 1, retentionRevision: 2, holders: [] } }]), /signature/i);
  await assert.rejects(materializePersonalSpaceSettings(crypto.subtle, trust,
    [{ ...changes[1], deviceId: "forged-other-device" }]), /trusted device/i);
  await assert.rejects(materializePersonalSpaceSettings(crypto.subtle, trust,
    [await signPersonalSpaceChange(crypto.subtle, privateKey,
      { ...changes[1], signature: undefined, path: ["folders", "photos", "devices", "another-device"] })]),
  /device selection/i);
});

test("conflicting settings remain unresolved until an explicit descendant chooses a value", async () => {
  const { deviceId, trust, privateKey } = await trustedOwner();
  const first = { id: "first", deviceId, path: ["folders", "photos", "retention"], parents: [],
    value: { minimumCopies: 2, retentionRevision: 2, holders: [] } };
  const second = { ...first, id: "second",
    value: { minimumCopies: 3, retentionRevision: 2, holders: [] } };
  const signedFirst = await signPersonalSpaceChange(crypto.subtle, privateKey, first);
  const signedSecond = await signPersonalSpaceChange(crypto.subtle, privateKey, second);
  const conflicted = await materializePersonalSpaceSettings(crypto.subtle, trust, [signedFirst, signedSecond]);
  assert.equal(conflicted.settings, null);
  assert.deepEqual(conflicted.conflicts[0]?.heads, ["first", "second"]);
  const resolved = await materializePersonalSpaceSettings(crypto.subtle, trust,
    [signedFirst, signedSecond, await signPersonalSpaceChange(crypto.subtle, privateKey,
      { ...first, id: "resolution", parents: ["first", "second"] })]);
  assert.equal(resolved.settings?.folders.photos.minimumCopies, 2);
});

test("a space device cannot spoof another member's settings event", async () => {
  const { deviceId, trust } = await trustedOwner();
  await assert.rejects(materializePersonalSpaceSettings(crypto.subtle, trust, [{
    id: "forged", deviceId, path: ["folders", "photos", "retention"], parents: [],
    value: { minimumCopies: 1, retentionRevision: 2, holders: [] }, signature: "not-a-signature",
  }]), /signature/i);
});

test("shared settings start versioned with a two-copy folder default", () => {
  const settings = defaultPersonalSpaceSettings("membership-1");
  assert.deepEqual(settings, { format: 1, rosterHead: "membership-1", folders: {} });
  assert.deepEqual(folderRetentionPolicyFromSettings(settings, "photos"), {
    format: 1, folderId: "photos", minimumCopies: 2, revision: 1,
    rosterHead: "membership-1", holders: [],
  });
});

test("favorite and exclusion selections are isolated per owned device", () => {
  const original = defaultPersonalSpaceSettings("membership-1");
  const phone = setDeviceFolderSelection(original, "photos", "phone", {
    favorites: [{ key: "folder:photos:", folderId: "photos", path: "", name: "Photos", kind: "folder" }],
    exclusions: [],
  });
  const laptop = setDeviceFolderSelection(phone, "photos", "laptop", {
    favorites: [], exclusions: [{ folderId: "photos", path: "private", kind: "folder" }],
  });
  assert.deepEqual(original.folders, {});
  assert.equal(laptop.folders.photos.devices.phone.favorites[0]?.path, "");
  assert.equal(laptop.folders.photos.devices.laptop.exclusions[0]?.path, "private");
  assert.equal(laptop.folders.photos.retentionRevision, 1,
    "favorite changes must not invalidate complete-copy evidence");
});

test("retention changes advance only that folder policy revision", () => {
  const initial = setDeviceFolderSelection(defaultPersonalSpaceSettings("membership-1"), "photos", "phone", {
    favorites: [], exclusions: [],
  });
  const updated = updateFolderRetention(initial, "photos", {
    minimumCopies: 3,
    holders: [{ id: "phone", kind: "syncpeer" }, { id: "nas", kind: "syncthing" }],
  });
  assert.deepEqual(folderRetentionPolicyFromSettings(updated, "photos"), {
    format: 1, folderId: "photos", minimumCopies: 3, revision: 2,
    rosterHead: "membership-1", holders: [
      { id: "phone", kind: "syncpeer" }, { id: "nas", kind: "syncthing" },
    ],
  });
  assert.equal(updated.folders.photos.devices.phone.favorites.length, 0);
});

test("unknown or incomplete shared settings fail closed", () => {
  assert.throws(() => normalizePersonalSpaceSettings({ format: 2, rosterHead: "membership", folders: {} }),
    /unsupported/i);
  assert.throws(() => normalizePersonalSpaceSettings({ format: 1, rosterHead: "membership", folders: {
    photos: { minimumCopies: 2 },
  } }), /invalid/i);
});

test("signed folder credentials materialize only for valid encrypted personal-space settings", async () => {
  const { deviceId, trust, privateKey } = await trustedOwner();
  const credential = { label: "Photos", password: "synthetic-shared-folder-password" };
  const change = await signPersonalSpaceChange(crypto.subtle, privateKey,
    { id: "credential", deviceId, path: ["folders", "photos", "credential"], parents: [], value: credential });
  const result = await materializePersonalSpaceSettings(crypto.subtle, trust, [change]);
  assert.deepEqual(result.settings?.folders.photos.credential, credential);
  await assert.rejects(materializePersonalSpaceSettings(crypto.subtle, trust,
    [{ ...change, value: { ...credential, password: "tampered" } }]), /signature/i);
  assert.throws(() => normalizePersonalSpaceSettings({ format: 1, rosterHead: trust.knownHead, folders: {
    photos: { ...result.settings?.folders.photos, credential: { label: "Photos", password: "" } },
  } }), /credential/i);
});
