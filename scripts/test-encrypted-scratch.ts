import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createEncryptedScratch, removeAbandonedEncryptedScratch } from "../packages/core/dist/sync/encryptedScratch.js";
import { memoryReplicaStorage } from "./lan-test/replica-storage.ts";

test("startup reclaims only recognized abandoned encrypted scratch", async () => {
  const { storage, files } = memoryReplicaStorage();
  const abandoned = await createEncryptedScratch(storage, randomBytes);
  await abandoned.write(0, Uint8Array.of(1, 2, 3));
  await storage.makeDirectory("ordinary-folder");
  await storage.makeDirectory(".syncpeer-scratch-unrecognized");
  await removeAbandonedEncryptedScratch(storage);
  assert.deepEqual([...files.keys()].sort(), [".syncpeer-scratch-unrecognized", "ordinary-folder"]);
  await abandoned.close();
});

test("encrypted scratch supports sparse cross-block writes and shrinking without resurrecting data", async () => {
  const { storage, files } = memoryReplicaStorage();
  const scratch = await createEncryptedScratch(storage, randomBytes);
  const bytes = new Uint8Array(131080).fill(91);
  await scratch.write(7, bytes);
  assert.equal(await scratch.size(), 131087);
  assert.deepEqual(await scratch.readRange(0, 10), Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 91, 91, 91));
  for (const file of files.values()) {
    assert.equal(Buffer.from(file.bytes).includes(Buffer.from(bytes.subarray(0, 128))), false);
  }
  await scratch.truncate(9);
  await scratch.truncate(131090);
  assert.deepEqual(await scratch.readRange(7, 6), Uint8Array.of(91, 91, 0, 0, 0, 0));
  assert.deepEqual(await scratch.readRange(131070, 12), new Uint8Array(12));
  await scratch.close();
  assert.equal(files.size, 0);
  await assert.rejects(scratch.readRange(0, 1), /closed/);
});

test("scratch rejects tampered chunks and serializes overlapping writes", async () => {
  const { storage, files } = memoryReplicaStorage();
  const scratch = await createEncryptedScratch(storage, randomBytes);
  await Promise.all([scratch.write(0, Uint8Array.of(1, 2, 3)), scratch.write(1, Uint8Array.of(8, 9))]);
  assert.deepEqual(await scratch.readRange(0, 3), Uint8Array.of(1, 8, 9));
  const stored = [...files.values()].find(file => file.type === "file")!;
  stored.bytes[0] ^= 1;
  await assert.rejects(scratch.readRange(0, 1));
  await scratch.close();
});
