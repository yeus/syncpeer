import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  assessFolderRetention,
  authorizeReplicaRelease,
  createDangerousLocalRelease,
  defaultFolderRetentionPolicy,
  folderManifestDigest,
  signReplicaCompletion,
  signRetentionReleaseProposal,
  signRetentionVote,
} from "../packages/core/dist/sync/folderRetention.js";

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

const manifest = folderManifestDigest([
  { path: "notes/today.txt", type: "file", size: 4, deleted: false,
    version: [{ id: "9", value: "2" }], blocks: ["aabb"] },
  { path: "notes", type: "directory", size: 0, deleted: false, version: [], blocks: [] },
]);

test("the default policy requires two explicitly selected complete copies", () => {
  assert.deepEqual(defaultFolderRetentionPolicy("folder", "roster-1"), {
    format: 1,
    folderId: "folder",
    minimumCopies: 2,
    revision: 1,
    rosterHead: "roster-1",
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

test("only signed current completions count and Syncthing evidence must still be live", async () => {
  const phone = await identity();
  const observer = await identity();
  const policy = { ...defaultFolderRetentionPolicy("folder", "roster-1"), holders: [
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

test("release requires a majority and enough current copies after the release", async () => {
  const phone = await identity();
  const laptop = await identity();
  const tablet = await identity();
  const keys = { phone: phone.publicKey, laptop: laptop.publicKey, tablet: tablet.publicKey };
  const policy = { ...defaultFolderRetentionPolicy("folder", "roster-1"), holders: [
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
    rosterHead: "roster-1", manifestDigest: manifest,
  });
  const phoneVote = await signRetentionVote(subtle, phone.privateKey, {
    proposalId: proposal.id, folderId: "folder", policyRevision: 1,
    rosterHead: "roster-1", voterId: "phone", approve: true,
  });
  await assert.rejects(authorizeReplicaRelease(subtle, {
    policy, currentManifestDigest: manifest, proposal, votes: [phoneVote], completions: receipts,
    activeDeviceIds: ["phone", "laptop", "tablet"], publicKeys: keys, nowMs: 200,
  }), /majority/i);
  const laptopVote = await signRetentionVote(subtle, laptop.privateKey, {
    proposalId: proposal.id, folderId: "folder", policyRevision: 1,
    rosterHead: "roster-1", voterId: "laptop", approve: true,
  });
  await assert.rejects(authorizeReplicaRelease(subtle, {
    policy, currentManifestDigest: "new-manifest", proposal, votes: [phoneVote, laptopVote],
    completions: receipts, activeDeviceIds: ["phone", "laptop", "tablet"],
    publicKeys: keys, nowMs: 200,
  }), /stale/i);
  const result = await authorizeReplicaRelease(subtle, {
    policy, currentManifestDigest: manifest, proposal, votes: [phoneVote, laptopVote], completions: receipts,
    activeDeviceIds: ["phone", "laptop", "tablet"], publicKeys: keys, nowMs: 200,
  });
  assert.deepEqual(result.remainingCompleteHolderIds, ["laptop", "tablet"]);
});

test("a device cannot cast competing votes in one policy revision", async () => {
  const phone = await identity();
  const laptop = await identity();
  const keys = { phone: phone.publicKey, laptop: laptop.publicKey };
  const policy = { ...defaultFolderRetentionPolicy("folder", "roster-1"), minimumCopies: 1, holders: [
    { id: "phone", kind: "syncpeer" as const }, { id: "laptop", kind: "syncpeer" as const },
  ] };
  const completions = await Promise.all([
    ["phone", phone], ["laptop", laptop],
  ].map(([holderId, key]) => signReplicaCompletion(subtle, key.privateKey, {
    folderId: "folder", holderId: String(holderId), holderKind: "syncpeer",
    signerId: String(holderId), manifestDigest: manifest, policyRevision: 1, completedAtMs: 100,
  })));
  const proposal = await signRetentionReleaseProposal(subtle, phone.privateKey, {
    folderId: "folder", releaseHolderId: "phone", proposerId: "phone", policyRevision: 1,
    rosterHead: "roster-1", manifestDigest: manifest,
  });
  const approve = await signRetentionVote(subtle, phone.privateKey, {
    proposalId: proposal.id, folderId: "folder", policyRevision: 1,
    rosterHead: "roster-1", voterId: "phone", approve: true,
  });
  const reject = await signRetentionVote(subtle, phone.privateKey, { ...approve, approve: false });
  await assert.rejects(authorizeReplicaRelease(subtle, {
    policy, currentManifestDigest: manifest, proposal, votes: [approve, reject], completions,
    activeDeviceIds: ["phone", "laptop"], publicKeys: keys, nowMs: 200,
  }), /one vote/i);
});

test("dangerous release is local-only, explicit, and signed", async () => {
  const phone = await identity();
  await assert.rejects(createDangerousLocalRelease(subtle, phone.privateKey, {
    folderId: "folder", localHolderId: "phone", policyRevision: 1, rosterHead: "roster-1",
    manifestDigest: manifest, confirmedText: "release", createdAtMs: 100,
  }), /type RELEASE LOCAL COPY/i);
  const override = await createDangerousLocalRelease(subtle, phone.privateKey, {
    folderId: "folder", localHolderId: "phone", policyRevision: 1, rosterHead: "roster-1",
    manifestDigest: manifest, confirmedText: "RELEASE LOCAL COPY", createdAtMs: 100,
  });
  assert.equal(override.scope, "local-copy-only");
  assert.equal(override.guaranteeBroken, true);
  assert.ok(override.signature.length > 20);
});
