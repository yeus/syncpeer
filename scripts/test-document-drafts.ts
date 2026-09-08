import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { memoryReplicaStorage } from "./lan-test/replica-storage.ts";
import { createEncryptedReplicaStorage, createFolderReplica, deriveUntrustedFolderCrypto } from "../packages/core/dist/filesystem.js";
import { openDocumentDraft, recoverDocumentDrafts } from "../packages/core/dist/sync/documentDraft.js";

test("large document writes are linear, durable before publication, and recover after interruption", async () => {
  const fixture = memoryReplicaStorage();
  let bytesWritten = 0;
  const bytes = { ...fixture.storage, copy: async (source: string, target: string) => {
    const data = fixture.files.get(source)!.bytes.slice();
    const sink = await fixture.storage.createSink(target, data.length); await sink.write(0, data); await sink.commit();
  }, createSink: async (path: string, size: number) => {
    const sink = await fixture.storage.createSink(path, size);
    return { ...sink, write: async (offset: number, data: Uint8Array) => { bytesWritten += data.length; await sink.write(offset, data); } };
  } };
  const { folderKey } = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const replica = createFolderReplica(createEncryptedReplicaStorage(bytes, { folderKey, randomBytes,
    withLock: async fn => fn(), checkHealth: async () => {}, archive: async () => {} }), "42", sha256);
  await replica.edit!({ method: "write", folderId: "fixture-folder", path: "large.bin", expectedVersion: null, modifiedMs: 0,
    source: { size: 0, readRange: async () => new Uint8Array() } });
  const options = { folderId: "fixture-folder", path: "large.bin", folderKey, randomBytes, replica };
  const draft = await openDocumentDraft(bytes, { ...options, truncate: true });
  bytesWritten = 0;
  const block = new Uint8Array(131072).fill(71), size = block.length * 32;
  for (let offset = 0; offset < size; offset += block.length) await draft.write(offset, block);
  assert.ok(bytesWritten < size * 2, "Writing must not repeatedly rewrite the whole file");
  assert.equal((await replica.scan()).find(file => file.name === "large.bin")!.size, 0, "Publication is batched");
  await draft.close(); // Drop runtime state without losing acknowledged edits.
  assert.equal((await recoverDocumentDrafts(bytes, options)).length, 0);
  assert.equal((await replica.scan()).find(file => file.name === "large.bin")!.size, size);
  assert.deepEqual(await replica.readBlock("large.bin", size - block.length, block.length, sha256(block)), block);
  const update = await openDocumentDraft(bytes, { ...options, truncate: false });
  await update.write(1, Uint8Array.of(5));
  await update.flush();
  await update.write(2, Uint8Array.of(6));
  await update.flush(); await update.close();
  assert.equal([...fixture.files.keys()].some(path => path.startsWith(".syncpeer-draft-")), false);
  const damaged = await openDocumentDraft(bytes, { ...options, truncate: false });
  await damaged.write(0, Uint8Array.of(99)); await damaged.close();
  const encryptedChunk = [...fixture.files].find(([path]) => path.startsWith(".syncpeer-draft-") && path.endsWith("/chunk-0"))!;
  encryptedChunk[1].bytes[0] ^= 1;
  assert.equal((await recoverDocumentDrafts(bytes, options)).length, 1, "Corrupt edits are reported, not published or discarded");
  assert.ok(fixture.files.has(encryptedChunk[0]), "Failed recovery retains the encrypted journal");
  const unchanged = await openDocumentDraft(bytes, { ...options, truncate: false });
  assert.deepEqual(await unchanged.readRange(0, 3), Uint8Array.of(71, 5, 6));
  await unchanged.close();
  folderKey.fill(0);
});
