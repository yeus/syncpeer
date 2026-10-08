import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { memoryReplicaStorage } from "./lan-test/replica-storage.ts";
import { createEncryptedReplicaStorage, createFolderReplica, deriveUntrustedFolderCrypto } from "../packages/core/dist/filesystem.js";
import { openDocumentDownloadDraft, openDocumentDraft, recoverDocumentDrafts } from "../packages/core/dist/sync/documentDraft.js";

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

test("native draft record reads split large ranges into bounded batches", async () => {
  const fixture = memoryReplicaStorage();
  const readBatchSizes: number[] = [];
  const bytes = { ...fixture.storage, readFiles: async (paths: readonly string[], maxTotalSize: number) => {
    assert.ok(paths.length <= 8, "Native read batches contain at most eight records");
    const records = paths.map(path => {
      const record = fixture.files.get(path);
      if (!record || record.type !== "file") throw new Error("Synthetic draft record is missing.");
      return record.bytes.slice();
    });
    assert.ok(records.reduce((total, record) => total + record.length, 0) <= maxTotalSize,
      "Native read batches stay within their byte limit");
    readBatchSizes.push(paths.length);
    return records;
  } };
  const { folderKey } = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const draft = await openDocumentDraft(bytes, { folderId: "fixture-folder", path: "large-read.bin", folderKey,
    randomBytes, replica: { scan: async () => [] } as never, truncate: true });
  const chunkSize = 128 * 1024, expected = new Uint8Array(chunkSize * 10);
  for (let index = 0; index < 10; index++) {
    const chunk = new Uint8Array(chunkSize).fill(index + 1);
    expected.set(chunk, index * chunkSize);
    await draft.write(index * chunkSize, chunk);
  }
  assert.deepEqual(await draft.readRange(0, expected.length), expected);
  assert.deepEqual(readBatchSizes, [8, 2]);
  await draft.discard();
  folderKey.fill(0);
});

test("native draft record writes split on the encoded byte limit", async () => {
  const fixture = memoryReplicaStorage();
  const writeBatchSizes: number[] = [];
  const bytes = { ...fixture.storage, writeFiles: async (files: readonly { path: string; bytes: Uint8Array }[]) => {
    const totalSize = files.reduce((total, file) => total + file.bytes.length, 0);
    assert.ok(files.length <= 8, "Native write batches contain at most eight records");
    assert.ok(totalSize <= 2 * 1024 * 1024, "Native write batches stay within their byte limit");
    writeBatchSizes.push(totalSize);
    for (const file of files) {
      const sink = await fixture.storage.createSink(file.path, file.bytes.length);
      await sink.write(0, file.bytes);
      await sink.commit();
    }
  } };
  const { folderKey } = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const chunkSize = 1024 * 1024, path = "wide-download.bin";
  const draft = await openDocumentDownloadDraft(bytes, { folderId: "fixture-folder", path, folderKey,
    randomBytes, replica: { scan: async () => [] } as never,
    download: { folderId: "fixture-folder", path, sizeBytes: chunkSize * 3, modifiedMs: 1, encrypted: true } });
  const part = new Uint8Array(128 * 1024).fill(7);
  await draft.writeBatch([0, chunkSize, chunkSize * 2].map(offset => ({ offset, bytes: part })));
  assert.equal(writeBatchSizes.length, 3);
  assert.ok(writeBatchSizes.every(size => size <= 2 * 1024 * 1024));
  await draft.discard();
  folderKey.fill(0);
});

test("a resumed download replaces a damaged full journal block", async () => {
  const fixture = memoryReplicaStorage();
  const bytes = { ...fixture.storage, copy: async (source: string, target: string) => {
    const data = fixture.files.get(source)!.bytes.slice();
    const sink = await fixture.storage.createSink(target, data.length);
    await sink.write(0, data); await sink.commit();
  } };
  const { folderKey } = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const replica = createFolderReplica(createEncryptedReplicaStorage(bytes, { folderKey, randomBytes,
    withLock: async fn => fn(), checkHealth: async () => {}, archive: async () => {} }), "42", sha256);
  const options = { folderId: "fixture-folder", path: "download.bin", folderKey, randomBytes, replica,
    download: { folderId: "fixture-folder", path: "download.bin", sizeBytes: 131072,
      modifiedMs: 1, encrypted: true } };
  const interrupted = await openDocumentDownloadDraft(bytes, options);
  await interrupted.write(0, new Uint8Array(131072).fill(1));
  await interrupted.close();
  const encryptedChunk = [...fixture.files].find(([path]) =>
    path.startsWith(".syncpeer-draft-") && path.endsWith("/chunk-0"))!;
  encryptedChunk[1].bytes[0] ^= 1;
  const resumed = await openDocumentDownloadDraft(bytes, options);
  const replacement = new Uint8Array(131072).fill(2);
  await resumed.write(0, replacement);
  assert.deepEqual(await resumed.readRange(0, replacement.length), replacement);
  await resumed.close();
  folderKey.fill(0);
});
