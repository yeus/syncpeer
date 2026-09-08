import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { createFolderReplica } from "../packages/core/dist/sync/replicaStorage.js";
import { receiveReplicaFiles } from "../packages/core/dist/sync/replicaReceive.js";
import type { ReplicaIndex } from "../packages/core/src/sync/replicaIndex.js";
import { randomBytes } from "node:crypto";
import { createEncryptedDownloadSink, deriveUntrustedFolderCrypto, loadEncryptedDiskMetadata, readEncryptedDiskRange } from "@syncpeer/core/filesystem";

test("replica receive passes full metadata to the shared streaming encrypted sink", async () => {
  const folder = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const bytes = new Uint8Array(131075).map((_, i) => i % 251);
  const info = { name: "file", type: 0, size: bytes.length, permissions: 0o600, no_permissions: true,
    modified_by: "42", block_size: 131072, modified_s: 1, modified_ns: 0,
    version: { counters: [{ id: "2", value: "1" }] },
    blocks: [0, 131072].map(offset => ({ offset, size: Math.min(131072, bytes.length - offset), hash: sha256(bytes.slice(offset, offset + 131072)) })) };
  let stored = new Uint8Array();
  let storedName = "";
  let published = false;
  let index: ReplicaIndex = { format: 1, sequence: 0, files: {} };
  await receiveReplicaFiles("fixture-folder", index, [info], {
    listEntries: async () => published ? [{ path: info.name, type: "file", size: bytes.length, modifiedMs: 1000, revision: "one" }] : [],
    readRange: async () => assert.fail("No old file"),
    saveIndex: async value => { index = structuredClone(value); },
    archive: async () => assert.fail("No old file"), remove: async () => assert.fail("No removal"),
    makeDirectory: async () => assert.fail("No directory"), flushChanges: async () => {},
    createSink: async metadata => {
      assert.equal(metadata.block_size, info.block_size);
      assert.equal(metadata.permissions, info.permissions);
      assert.equal(metadata.no_permissions, true);
      assert.equal(String(metadata.modified_by), "42");
      const result = await createEncryptedDownloadSink({ fileInfo: metadata, folderKey: folder.folderKey, randomBytes,
        createSink: async (encrypted, size) => {
          storedName = encrypted.name; stored = new Uint8Array(size);
          return { write: async (offset, chunk) => { stored.set(chunk, offset); },
            commit: async () => { assert.equal(index.pending?.name, info.name); published = true; }, abort: async () => assert.fail("No interruption") };
        } });
      return result.sink;
    },
  }, async (_path, offset, size) => bytes.slice(offset, offset + size), sha256);
  const source = { size: stored.length, readRange: async (offset: number, size: number) => stored.slice(offset, offset + size) };
  const metadata = await loadEncryptedDiskMetadata(source, storedName, folder.folderKey);
  try {
    assert.deepEqual(await readEncryptedDiskRange(source, metadata, 0, bytes.length), bytes);
    assert.equal(index.pending, undefined);
    assert.equal(index.files.file.info.permissions, info.permissions);
  } finally { metadata.fileKey.fill(0); folder.folderKey.fill(0); }
});

test("shared replica owner locks mutations, publishes durable indexes and verifies served bytes", async () => {
  let index: ReplicaIndex | null = null;
  let locked = false;
  let bytes = new Uint8Array([1, 2, 3]);
  const replica = createFolderReplica({
    withLock: async operation => {
      assert.equal(locked, false);
      locked = true;
      try { return await operation(); } finally { locked = false; }
    },
    listEntries: async () => [{ path: "file", type: "file", size: 3, modifiedMs: 1000, revision: "one" }],
    readRange: async (_path, offset, size) => bytes.slice(offset, offset + size),
    loadIndex: async () => index,
    saveIndex: async value => { assert.equal(locked, true); index = value; },
    flushChanges: async () => {},
    archive: async () => assert.fail("No replacement expected"),
    makeDirectory: async () => assert.fail("No directory creation expected"),
    remove: async () => assert.fail("No deletion expected"),
    createSink: async () => assert.fail("No download expected"),
  }, "1", sha256);
  const files = await replica.scan();
  assert.deepEqual(files, Object.values(index!.files).map(entry => entry.info));
  assert.deepEqual(await replica.readBlock("file", 0, 3), bytes);
  assert.equal(await replica.receive("fixture-folder", files, async () => assert.fail("Duplicate download")), false);
  bytes = new Uint8Array([4, 5, 6]);
  await assert.rejects(replica.readBlock("file", 0, 3), /changed/);
  assert.equal(locked, false);
});

test("failed storage flush retains pending metadata instead of acknowledging completion", async () => {
  let saved: ReplicaIndex = { format: 1, sequence: 0, files: {} };
  let created = false;
  const events: string[] = [];
  await assert.rejects(receiveReplicaFiles("fixture-folder", saved, [{
    name: "directory", type: 1, size: 0, version: { counters: [{ id: "2", value: "1" }] },
  }], {
    listEntries: async () => created ? [{ path: "directory", type: "directory", size: 0, modifiedMs: 0, revision: "one" }] : [],
    readRange: async () => assert.fail("No bytes needed"),
    saveIndex: async index => { events.push(index.pending ? "pending" : "completed"); saved = structuredClone(index); },
    makeDirectory: async () => { events.push("create"); created = true; },
    flushChanges: async paths => { assert.deepEqual(paths, ["directory"]); events.push("flush"); throw new Error("synthetic flush failure"); },
    remove: async () => assert.fail("No deletion needed"),
    archive: async () => assert.fail("No archive needed"),
    createSink: async () => assert.fail("No download needed"),
  }, async () => assert.fail("No request needed"), sha256), /flush failure/);
  assert.deepEqual(events, ["pending", "create", "flush"]);
  assert.equal(saved.pending?.name, "directory");
  assert.deepEqual(saved.files, {});
});

test("recovering a pending deletion flushes storage before clearing the journal", async () => {
  const pending = { name: "file", type: 0, size: 0, deleted: true, version: { counters: [{ id: "2", value: "1" }] } };
  let saved: ReplicaIndex = { format: 1, sequence: 0, files: {}, pending };
  let fail = true;
  const events: string[] = [];
  const replica = createFolderReplica({
    withLock: async operation => operation(),
    listEntries: async () => [], readRange: async () => assert.fail("No bytes needed"),
    loadIndex: async () => saved,
    saveIndex: async value => { events.push("save"); saved = value; },
    flushChanges: async paths => {
      assert.deepEqual(paths, ["file"]);
      events.push("flush");
      if (fail) throw new Error("synthetic flush failure");
    },
    archive: async () => assert.fail("No archive needed"),
    makeDirectory: async () => assert.fail("No directory needed"),
    remove: async () => assert.fail("Already deleted"),
    createSink: async () => assert.fail("No download needed"),
  }, "1", sha256);
  await assert.rejects(replica.scan(), /flush failure/);
  assert.deepEqual(events, ["flush"]);
  assert.equal(saved.pending, pending);
  fail = false;
  await replica.scan();
  assert.deepEqual(events, ["flush", "flush", "save"]);
  assert.equal(saved.pending, undefined);
});
