import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  assessFolderRetention,
  authorizeReplicaRelease,
  createDangerousLocalRelease,
  defaultFolderRetentionPolicy,
  folderManifestDigest,
  folderManifestDigestFromBep,
  signReplicaCompletion,
  signRetentionReleaseProposal,
  verifyLocalReplicaManifest,
  verifyRemoteReplicaManifest,
} from "../packages/core/dist/sync/folderRetention.js";
import { RemoteFs } from "../packages/core/dist/core/model/remoteFs.js";
import { signSpaceMembershipUpdate } from "../packages/core/dist/sync/personalSpaceSharing.js";

const subtle = globalThis.crypto.subtle;

test("manifest identity is independent of the operating-system locale", () => {
  const script = `import { folderManifestDigest } from './packages/core/dist/sync/folderRetention.js';
    console.log(folderManifestDigest(['ä', 'z', 'a', 'A'].map(path => ({
      path, type: 'file', size: 0, deleted: false, version: [], blocks: []
    }))));`;
  const hashes = ["en_US.UTF-8", "sv_SE.UTF-8"].map(locale =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", env: { ...process.env, LANG: locale, LC_ALL: locale },
    }).trim());
  assert.equal(hashes[0], hashes[1]);
});

const identity = async () => {
  const pair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: Buffer.from(await subtle.exportKey("spki", pair.publicKey)).toString("base64"),
  };
};

const signedMembership = async (signer: Awaited<ReturnType<typeof identity>>,
  devices: Record<string, Awaited<ReturnType<typeof identity>>>) => {
  const update = await signSpaceMembershipUpdate(subtle, signer.privateKey, {
    sequence: 1, previous: null, signer: "phone",
    devices: Object.entries(devices).map(([id, keys]) => ({ id, syncthingId: id,
      state: "active" as const, signingKey: keys.publicKey })),
  });
  return { genesisKey: signer.publicKey, knownHead: update.hash, updates: [update] };
};

const manifest = folderManifestDigest([
  { path: "notes/today.txt", type: "file", size: 4, deleted: false,
    version: [{ id: "9", value: "2" }], blocks: ["aabb"] },
  { path: "notes", type: "directory", size: 0, deleted: false, version: [], blocks: [] },
]);

test("the default policy requires two explicitly selected complete copies", () => {
  assert.deepEqual(defaultFolderRetentionPolicy("folder", "membership-1"), {
    format: 1,
    folderId: "folder",
    minimumCopies: 2,
    revision: 1,
    rosterHead: "membership-1",
    holders: [],
  });
});

test("manifest identity is stable across entry, counter, and block ordering", () => {
  const reordered = folderManifestDigest([
    { path: "notes", type: "directory", size: 0, deleted: false, blocks: [], version: [] },
    { path: "notes/today.txt", type: "file", size: 4, deleted: false,
      blocks: ["aabb"], version: [{ value: "2", id: "9" }] },
  ]);
  assert.equal(reordered, manifest);
  assert.notEqual(folderManifestDigest([
    { path: "notes/today.txt", type: "file", size: 5, deleted: false,
      version: [{ id: "9", value: "2" }], blocks: ["aabb"] },
  ]), manifest);
});

test("manifest identity includes a symlink target", () => {
  const link = { path: "latest", type: "symlink" as const, size: 0, deleted: false,
    version: [], blocks: [] };
  assert.throws(() => folderManifestDigest([link]), /symlink target/i);
  assert.notEqual(
    folderManifestDigest([{ ...link, symlinkTarget: "6e6f7465732f612e747874" }]),
    folderManifestDigest([{ ...link, symlinkTarget: "6e6f7465732f622e747874" }]),
  );
});

test("BEP manifest conversion preserves hashes, versions, tombstones, and symlink targets", () => {
  const target = new TextEncoder().encode("notes/a.txt");
  const entries = [
    { name: "notes/a.txt", type: 0, size: 4, deleted: false,
      version: { counters: [{ id: "9", value: "2" }] },
      blocks: [{ offset: 0, size: 4, hash: Uint8Array.from({ length: 32 }, () => 7) }] },
    { name: "old.txt", type: 0, size: 0, deleted: true, version: { counters: [] }, blocks: [] },
    { name: "latest", type: 4, size: 0, deleted: false, version: { counters: [] },
      symlink_target: target, blocks: [] },
  ];
  const digest = folderManifestDigestFromBep(entries);
  assert.equal(digest, folderManifestDigest([
    { path: "notes/a.txt", type: "file", size: 4, deleted: false,
      version: [{ id: "9", value: "2" }], blocks: [Buffer.alloc(32, 7).toString("hex")] },
    { path: "old.txt", type: "file", size: 0, deleted: true, version: [], blocks: [] },
    { path: "latest", type: "symlink", size: 0, deleted: false, version: [], blocks: [],
      symlinkTarget: Buffer.from(target).toString("hex") },
  ]));
  assert.notEqual(folderManifestDigestFromBep([
    ...entries.slice(0, 2), { ...entries[2], symlink_target: new TextEncoder().encode("notes/b.txt") },
  ]), digest);
  assert.throws(() => folderManifestDigestFromBep([{ ...entries[0], invalid: true }]), /invalid BEP/i);
});

test("a complete local replica proof reads every block and rejects missing or changing files", async () => {
  const bytes = new TextEncoder().encode("verified bytes");
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
  const file = { name: "note.txt", type: 0, size: bytes.length, deleted: false,
    version: { counters: [{ id: "1", value: "1" }] },
    blocks: [{ offset: 0, size: bytes.length, hash }] };
  const expected = [file];
  const replica = { scan: async () => [file], readBlock: async () => bytes };
  assert.equal(await verifyLocalReplicaManifest(replica, expected), folderManifestDigestFromBep(expected));
  await assert.rejects(verifyLocalReplicaManifest({ ...replica,
    readBlock: async () => new TextEncoder().encode("forged content") }, expected), /block|digest/i);
  await assert.rejects(verifyLocalReplicaManifest({ ...replica, scan: async () => [] }, expected), /complete copy/i);
  let scans = 0;
  await assert.rejects(verifyLocalReplicaManifest({ ...replica,
    scan: async () => ++scans === 1 ? [file] : [] }, expected), /complete copy/i);
});

test("a live remote proof reads every block and rejects a changed index", async () => {
  const first = new TextEncoder().encode("first"), second = new TextEncoder().encode("second");
  const file = { name: "note.txt", type: 0, size: first.length + second.length,
    version: { counters: [{ id: "1", value: "1" }] },
    blocks: [first, second].map((bytes, index) => ({ offset: index ? first.length : 0,
      size: bytes.length, hash: new Uint8Array(createHash("sha256").update(bytes).digest()) })) };
  const folder = { id: "folder", label: "Folder", readOnly: true, advertisedDevices: [],
    encrypted: false, needsPassword: false, indexReceived: true,
    files: new Map([[file.name, { indexFile: file }]]) };
  const requested: number[] = [];
  const remote = new RemoteFs(new Map([[folder.id, folder]]),
    async (_folderId, _path, offset) => { requested.push(offset); return offset ? second : first; },
    async () => {}, () => {});
  const snapshot = await remote.completeFolderIndex("folder");
  snapshot[0].blocks[0].hash.fill(0);
  assert.notDeepEqual(snapshot[0].blocks[0].hash, file.blocks[0].hash,
    "The proof snapshot must not alias a mutable live index");
  assert.equal(await verifyRemoteReplicaManifest(remote, "folder"), folderManifestDigestFromBep([file]));
  assert.deepEqual(requested, [0, first.length]);
  const changing = new RemoteFs(new Map([[folder.id, folder]]),
    async (_folderId, _path, offset) => {
      folder.files.clear();
      return offset ? second : first;
    }, async () => {}, () => {});
  await assert.rejects(verifyRemoteReplicaManifest(changing, "folder"), /complete copy/i);
});

test("only signed current completions count and Syncthing evidence must still be live", async () => {
  const phone = await identity();
  const observer = await identity();
  const policy = { ...defaultFolderRetentionPolicy("folder", "membership-1"), holders: [
    { id: "phone", kind: "syncpeer" as const },
    { id: "nas", kind: "syncthing" as const },
  ] };
  const phoneReceipt = await signReplicaCompletion(subtle, phone.privateKey, {
    folderId: "folder", holderId: "phone", holderKind: "syncpeer", signerId: "phone",
    manifestDigest: manifest, policyRevision: 1, completedAtMs: 100,
  });
  const nasObservation = await signReplicaCompletion(subtle, observer.privateKey, {
    folderId: "folder", holderId: "nas", holderKind: "syncthing", signerId: "observer",
    manifestDigest: manifest, policyRevision: 1, completedAtMs: 100, liveUntilMs: 200,
  });
  const publicKeys = { phone: phone.publicKey, observer: observer.publicKey };
  assert.deepEqual((await assessFolderRetention(subtle, policy, manifest,
    [phoneReceipt, nasObservation], publicKeys, 150)).completeHolderIds, ["nas", "phone"]);
  const stale = await assessFolderRetention(subtle, policy, manifest,
    [phoneReceipt, nasObservation], publicKeys, 201);
  assert.deepEqual(stale.completeHolderIds, ["phone"]);
  assert.equal(stale.missingCopies, 1);
  const oldManifest = { ...phoneReceipt, manifestDigest: "old" };
  assert.equal((await assessFolderRetention(subtle, policy, manifest,
    [oldManifest], publicKeys, 150)).completeHolderIds.length, 0);
});

test("a bounded local full-block observation counts for a Syncpeer holder", async () => {
  const observer = await identity();
  const policy = { ...defaultFolderRetentionPolicy("folder", "membership-1"), minimumCopies: 1,
    holders: [{ id: "stable-phone-slot", kind: "syncpeer" as const }] };
  const observation = await signReplicaCompletion(subtle, observer.privateKey, {
    folderId: "folder", holderId: "stable-phone-slot", holderKind: "syncpeer",
    signerId: "observer", manifestDigest: manifest, policyRevision: 1,
    completedAtMs: 100, liveUntilMs: 200,
  });
  assert.deepEqual((await assessFolderRetention(subtle, policy, manifest,
    [observation], { observer: observer.publicKey }, 150)).completeHolderIds,
  ["stable-phone-slot"]);
  assert.deepEqual((await assessFolderRetention(subtle, policy, manifest,
    [observation], { observer: observer.publicKey }, 201)).completeHolderIds, []);
  await assert.rejects(signReplicaCompletion(subtle, observer.privateKey, {
    folderId: "folder", holderId: "stable-phone-slot", holderKind: "syncpeer",
    signerId: "observer", manifestDigest: manifest, policyRevision: 1,
    completedAtMs: 100,
  }), /bounded|observation/i);
});

test("future-dated receipts and overlong Syncthing observations cannot satisfy retention", async () => {
  const phone = await identity();
  const policy = { ...defaultFolderRetentionPolicy("folder", "membership-1"), minimumCopies: 1,
    holders: [{ id: "phone", kind: "syncpeer" as const }, { id: "nas", kind: "syncthing" as const }] };
  const future = await signReplicaCompletion(subtle, phone.privateKey, {
    folderId: "folder", holderId: "phone", holderKind: "syncpeer", signerId: "phone",
    manifestDigest: manifest, policyRevision: 1, completedAtMs: 201,
  });
  assert.deepEqual((await assessFolderRetention(subtle, policy, manifest, [future],
    { phone: phone.publicKey }, 200)).completeHolderIds, []);
  await assert.rejects(signReplicaCompletion(subtle, phone.privateKey, {
    folderId: "folder", holderId: "nas", holderKind: "syncthing", signerId: "phone",
    manifestDigest: manifest, policyRevision: 1, completedAtMs: 100,
    liveUntilMs: 100 + 24 * 60 * 60_000,
  }), /bounded|deadline|observation/i);
});

test("an offline owned device need not approve a safe release", async () => {
  const phone = await identity(), laptop = await identity(), offlineTablet = await identity();
  const trust = await signedMembership(phone, { phone, laptop, offlineTablet });
  const policy = { ...defaultFolderRetentionPolicy("folder", trust.knownHead), minimumCopies: 1,
    holders: [{ id: "phone", kind: "syncpeer" as const }, { id: "laptop", kind: "syncpeer" as const }] };
  const receipts = [
    await signReplicaCompletion(subtle, phone.privateKey, { folderId: "folder", holderId: "phone",
      holderKind: "syncpeer", signerId: "phone", manifestDigest: manifest,
      policyRevision: 1, completedAtMs: 100 }),
    await signReplicaCompletion(subtle, phone.privateKey, { folderId: "folder", holderId: "laptop",
      holderKind: "syncpeer", signerId: "phone", manifestDigest: manifest,
      policyRevision: 1, completedAtMs: 100, liveUntilMs: 200 }),
  ];
  const proposal = await signRetentionReleaseProposal(subtle, phone.privateKey, {
    folderId: "folder", releaseHolderId: "phone", proposerId: "phone", policyRevision: 1,
    rosterHead: trust.knownHead, manifestDigest: manifest,
  });
  assert.deepEqual((await authorizeReplicaRelease(subtle, {
    policy, trust, currentManifestDigest: manifest, proposal,
    completions: receipts, onlineHolderIds: ["phone", "laptop"], nowMs: 200,
  })).remainingCompleteHolderIds, ["laptop"]);
});

test("release requires enough current online copies after the release", async () => {
  const phone = await identity();
  const laptop = await identity();
  const tablet = await identity();
  const trust = await signedMembership(phone, { phone, laptop, tablet });
  const policy = { ...defaultFolderRetentionPolicy("folder", trust.knownHead), holders: [
    { id: "phone", kind: "syncpeer" as const },
    { id: "laptop", kind: "syncpeer" as const },
    { id: "tablet", kind: "syncpeer" as const },
  ] };
  const receipts = await Promise.all([
    ["phone", phone], ["laptop", laptop], ["tablet", tablet],
  ].map(([holderId, key]) => signReplicaCompletion(subtle, key.privateKey, {
    folderId: "folder", holderId: String(holderId), holderKind: "syncpeer",
    signerId: String(holderId), manifestDigest: manifest, policyRevision: 1, completedAtMs: 100,
  })));
  const proposal = await signRetentionReleaseProposal(subtle, phone.privateKey, {
    folderId: "folder", releaseHolderId: "phone", proposerId: "phone", policyRevision: 1,
    rosterHead: trust.knownHead, manifestDigest: manifest,
  });
  await assert.rejects(authorizeReplicaRelease(subtle, {
    policy, trust, currentManifestDigest: "new-manifest", proposal,
    completions: receipts, onlineHolderIds: ["phone", "laptop", "tablet"], nowMs: 200,
  }), /stale/i);
  const result = await authorizeReplicaRelease(subtle, {
    policy, trust, currentManifestDigest: manifest, proposal,
    completions: receipts, onlineHolderIds: ["phone", "laptop", "tablet"], nowMs: 200,
  });
  assert.deepEqual(result.remainingCompleteHolderIds, ["laptop", "tablet"]);
  await assert.rejects(authorizeReplicaRelease(subtle, {
    policy, trust, currentManifestDigest: manifest, proposal,
    completions: receipts, onlineHolderIds: ["phone", "laptop"], nowMs: 200,
  }), /online complete cop/i, "An offline tablet receipt cannot satisfy the minimum");
  assert.deepEqual((await authorizeReplicaRelease(subtle, {
    policy, trust, currentManifestDigest: manifest, proposal,
    completions: receipts, onlineHolderIds: ["phone", "laptop", "tablet"], nowMs: 100 + 5 * 60_000,
  })).remainingCompleteHolderIds, ["laptop", "tablet"], "Five-minute-old evidence is still fresh");
  await assert.rejects(authorizeReplicaRelease(subtle, {
    policy, trust, currentManifestDigest: manifest, proposal,
    completions: receipts, onlineHolderIds: ["phone", "laptop", "tablet"], nowMs: 100 + 5 * 60_000 + 1,
  }), /current complete|online complete cop/i, "An old receipt cannot prove that an online holder still has the bytes");
});

test("dangerous release is local-only, explicit, and signed", async () => {
  const phone = await identity();
  await assert.rejects(createDangerousLocalRelease(subtle, phone.privateKey, {
    folderId: "folder", localHolderId: "phone", policyRevision: 1, rosterHead: "membership-1",
    manifestDigest: manifest, confirmedText: "release", createdAtMs: 100,
  }), /type RELEASE LOCAL COPY/i);
  const override = await createDangerousLocalRelease(subtle, phone.privateKey, {
    folderId: "folder", localHolderId: "phone", policyRevision: 1, rosterHead: "membership-1",
    manifestDigest: manifest, confirmedText: "RELEASE LOCAL COPY", createdAtMs: 100,
  });
  assert.equal(override.scope, "local-copy-only");
  assert.equal(override.guaranteeBroken, true);
  assert.ok(override.signature.length > 20);
});
