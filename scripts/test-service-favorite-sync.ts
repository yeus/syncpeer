import assert from "node:assert/strict";
import test from "node:test";
import { reconcileServiceFavorite } from "../packages/core/src/sync/serviceFavoriteSync.ts";

const encoder = new TextEncoder();
const digest = async (value: Uint8Array) => {
  const { sha256 } = await import("@noble/hashes/sha2.js");
  return [...sha256(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

test("downloads a selected file into the document owner and persists its baseline", async () => {
  let local: Uint8Array | undefined;
  let baseline: { hash: string; sizeBytes: number; modifiedMs: number } | undefined;
  const remote = encoder.encode("from peer");
  const result = await reconcileServiceFavorite({
    folderId: "fixture", path: "notes.txt", remote: { size: remote.length, modifiedMs: 12 },
    local: undefined,
    hashLocal: async () => { throw new Error("No local file"); },
    readLocal: async () => { throw new Error("No local file"); },
    download: async expectedHash => { assert.equal(expectedHash, null); local = remote; baseline = {
      hash: await digest(remote), sizeBytes: remote.length, modifiedMs: 12,
    }; },
    upload: async () => { throw new Error("Unexpected upload"); },
    acknowledge: async () => { throw new Error("Unexpected acknowledgement"); },
  });
  assert.equal(result, "downloaded");
  assert.deepEqual(local, remote);
  assert.equal(baseline?.modifiedMs, 12);
});

test("uploads an offline edit and advances the baseline", async () => {
  const previous = encoder.encode("old"), edited = encoder.encode("offline edit");
  const baseline = { hash: await digest(previous), sizeBytes: previous.length, modifiedMs: 10 };
  let sent: Uint8Array | undefined, acknowledged: typeof baseline | undefined;
  const result = await reconcileServiceFavorite({
    folderId: "fixture", path: "notes.txt", remote: { size: previous.length, modifiedMs: 10 },
    local: { syncBaseline: baseline, sizeBytes: edited.length },
    hashLocal: async () => await digest(edited),
    readLocal: async () => edited.slice(),
    download: async () => { throw new Error("Unexpected download"); },
    upload: async bytes => { sent = bytes.slice(); },
    acknowledge: async next => { acknowledged = next; },
  });
  assert.equal(result, "uploaded");
  assert.deepEqual(sent, edited);
  assert.equal(acknowledged?.hash, await digest(edited));
});

test("keeps both sides intact when local and remote changed", async () => {
  const baseline = { hash: await digest(encoder.encode("old")), sizeBytes: 3, modifiedMs: 10 };
  await assert.rejects(reconcileServiceFavorite({
    folderId: "fixture", path: "notes.txt", remote: { size: 9, modifiedMs: 20 },
    local: { syncBaseline: baseline, sizeBytes: 8 },
    hashLocal: async () => await digest(encoder.encode("changed")),
    readLocal: async () => { throw new Error("Must not read changed file"); },
    download: async () => { throw new Error("Must not replace changed file"); },
    upload: async () => { throw new Error("Must not publish changed file"); },
    acknowledge: async () => { throw new Error("Must not advance baseline"); },
  }), /conflict/i);
});
