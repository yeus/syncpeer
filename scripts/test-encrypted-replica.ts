import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { createEncryptedReplicaStorage, createFolderReplica, deriveUntrustedFolderCrypto } from "@syncpeer/core/filesystem";
import { createCiphertextReplica } from "../packages/core/dist/sync/ciphertextReplica.js";
import { encryptUntrustedFileInfo } from "../packages/core/dist/core/model/untrustedMetadata.js";
import { encryptUntrustedBytes, deriveUntrustedFileKey } from "../packages/core/dist/core/model/untrusted.js";

import { memoryReplicaStorage } from "./lan-test/replica-storage.ts";
import { openCiphertextView } from "../packages/core/dist/sync/ciphertextView.js";

test("unlock reconciles authenticated histories without rewriting ciphertext and close revokes reads", async () => {
  const { storage, files } = memoryReplicaStorage();
  const crypto = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const identity = { folderId: crypto.folderId, passwordToken: crypto.passwordToken };
  const replica = createCiphertextReplica(storage, { identity,
    withLock: async operation => operation(), checkHealth: async () => {} });
  for (const [id, value] of [["41", 3], ["42", 7]] as const) {
    const content = new Uint8Array(1024).fill(value);
    const info = await encryptUntrustedFileInfo(crypto.folderKey, { name: "synthetic-directory/file", type: 0, size: content.length,
      blocks: [{ offset: 0, size: content.length, hash: sha256(content) }], version: { counters: [{ id, value: "1" }] } }, randomBytes(24));
    const key = deriveUntrustedFileKey(crypto.folderKey, "synthetic-directory/file");
    const encrypted = encryptUntrustedBytes(key, content, randomBytes(24));
    key.fill(0);
    await replica.receive(identity, info, async () => encrypted);
  }
  const before = [...files].map(([path, value]) => [path, value.revision]);
  await assert.rejects(openCiphertextView(replica, new Uint8Array(32)), /identity/);
  const view = await openCiphertextView(replica, crypto.folderKey);
  const entries = view.list();
  assert.equal(entries.get("synthetic-directory")?.fileInfo.type, 1);
  const paths = [...entries].filter(([, entry]) => entry.fileInfo.type === 0).map(([path]) => path);
  assert.equal(paths.length, 2, "Concurrent authenticated edits must remain available");
  assert.ok(paths.some(path => path.includes(".sync-conflict-")));
  const contents = await Promise.all(paths.map(path => view.readRange(path, 0, 1024)));
  assert.deepEqual(contents.map(bytes => bytes[0]).sort(), [3, 7]);
  assert.deepEqual([...files].map(([path, value]) => [path, value.revision]), before, "Unlock must not rewrite ciphertext");
  const firstGeneration = [...files].find(([path]) => path.startsWith(".syncpeer-ciphertext-generations/"))![1];
  firstGeneration.bytes[0] ^= 1;
  await assert.rejects(view.readRange(paths[contents.findIndex(content => content[0] === 3)], 0, 1));
  firstGeneration.bytes[0] ^= 1;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const gated = await openCiphertextView({ snapshot: replica.snapshot, openGeneration: async id => {
    const source = await replica.openGeneration(id);
    return { ...source, readRange: async (offset, size) => {
      if (offset === 0) { entered.resolve(); await release.promise; }
      return source.readRange(offset, size);
    } };
  } }, crypto.folderKey);
  const reading = gated.readRange(paths[0], 0, 1);
  await entered.promise;
  gated.close(); release.resolve();
  await assert.rejects(reading, /closed/);
  view.close();
  assert.throws(() => view.list(), /closed/);
  await assert.rejects(view.readRange(paths[0], 0, 1), /closed/);
  crypto.folderKey.fill(0);
});

test("locked replica persists raw generations and recovers interruption without destroying history", async () => {
  const { files, storage } = memoryReplicaStorage();
  const crypto = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const identity = { folderId: crypto.folderId, passwordToken: crypto.passwordToken };
  const plain = new Uint8Array(1024).fill(7);
  const info = await encryptUntrustedFileInfo(crypto.folderKey, { name: "synthetic-file", type: 0, size: 1024,
    blocks: [{ offset: 0, size: 1024, hash: sha256(plain) }],
    version: { counters: [{ id: "42", value: "1" }] } }, randomBytes(24));
  const key = deriveUntrustedFileKey(crypto.folderKey, "synthetic-file");
  const ciphertext = encryptUntrustedBytes(key, plain, randomBytes(24));
  const metadataOnly = await Promise.all([
    { name: "synthetic-file", type: 0, size: 0, deleted: true, version: { counters: [{ id: "42", value: "2" }] } },
    { name: "synthetic-directory", type: 1, version: { counters: [{ id: "42", value: "1" }] } },
  ].map(file => encryptUntrustedFileInfo(crypto.folderKey, file, randomBytes(24))));
  key.fill(0); crypto.folderKey.fill(0);
  const options = { identity, withLock: async <T>(operation: () => Promise<T>) => operation(), checkHealth: async () => {} };
  const replica = createCiphertextReplica(storage, options);
  await assert.rejects(replica.receive(identity, info, async () => { throw new Error("interrupted"); }), /interrupted/);
  const pending = await replica.snapshot();
  assert.ok(pending.pending);
  assert.equal(Object.keys(pending.versions).length, 0);
  let indexCommits = 0;
  const interruptedPublication = createCiphertextReplica({ ...storage,
    createSink: async (path, size) => {
      const sink = await storage.createSink(path, size);
      return { ...sink, commit: async () => {
        if (path === ".syncpeer-ciphertext-index" && ++indexCommits === 2) throw new Error("index publication interrupted");
        await sink.commit();
      } };
    } }, options);
  await assert.rejects(interruptedPublication.receive(identity, info, async () => ciphertext), /publication interrupted/);
  const reopened = createCiphertextReplica(storage, options);
  const completed = await reopened.receive(identity, info, async () => assert.fail("Recover durable ciphertext without requesting it again"));
  assert.equal(completed.sequence, 1);
  const id = Object.keys(completed.versions)[0];
  assert.deepEqual(await reopened.readBlock(id, 0, ciphertext.length, info.blocks![0].hash), ciphertext);
  await reopened.receive(identity, { ...info, sequence: 123 }, async () => assert.fail("Committed generation must not be downloaded again"));
  for (const metadata of metadataOnly) {
    await reopened.receive(identity, metadata, async () => assert.fail("Directories and tombstones do not request content"));
  }
  assert.equal(Object.keys((await reopened.snapshot()).versions).length, 3);
  assert.deepEqual(await reopened.readBlock(id, 0, ciphertext.length, info.blocks![0].hash), ciphertext,
    "Receiving a tombstone while locked must retain the old ciphertext for authenticated reconciliation");
  await assert.rejects(reopened.receive({ ...identity, folderId: "other-fixture" }, info, async () => assert.fail()), /identity/);
  assert.equal([...files.values()].some(file => new TextDecoder().decode(file.bytes).includes("synthetic-file")), false);
  const generation = [...files.keys()].find(path => path.endsWith(id))!;
  const saved = files.get(generation)!;
  files.set(generation, { ...saved, revision: "externally-modified" });
  await assert.rejects(reopened.readBlock(id, 0, ciphertext.length, info.blocks![0].hash), /changed/);
  files.delete(".syncpeer-ciphertext-index");
  await assert.rejects(reopened.snapshot(), /missing/);
});

for (const size of [3, 256 * 1024]) test(`encrypted replica receives, reopens, serves, archives and deletes ${size} bytes through the shared engine`, async () => {
  const { files, storage } = memoryReplicaStorage();
  const folder = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  let healthy = true;
  const versions: Uint8Array[] = [];
  const options = { folderKey: folder.folderKey, randomBytes,
    withLock: async <T>(operation: () => Promise<T>) => operation(),
    checkHealth: async () => { if (!healthy) throw new Error("synthetic missing root"); },
    archive: async (path: string) => { versions.push(files.get(path)!.bytes.slice()); },
  };
  const replica = createFolderReplica(createEncryptedReplicaStorage(storage, options), "1", sha256);
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  const directory = { name: "private-directory", type: 1, size: 0, version: { counters: [{ id: "2", value: "1" }] } };
  const info = { name: "private-directory/private-file", type: 0, size: bytes.length,
    blocks: [{ offset: 0, size: bytes.length, hash: sha256(bytes) }], version: { counters: [{ id: "2", value: "1" }] } };
  assert.equal(await replica.receive("fixture-folder", [directory, info], async () => bytes), true);
  const reopened = createFolderReplica(createEncryptedReplicaStorage(storage, options), "1", sha256);
  const localSource = { size: bytes.length, readRange: async (offset: number, size: number) => bytes.slice(offset, offset + size) };
  const created = await reopened.edit({ method: "write", folderId: "fixture-folder", path: "local-file", source: localSource,
    expectedVersion: null, modifiedMs: 1000 });
  assert.deepEqual(created.version, { counters: [{ id: "1", value: "1" }] });
  const edited = await reopened.edit({ method: "write", folderId: "fixture-folder", path: "local-file", source: localSource,
    expectedVersion: created.version!, modifiedMs: 2000 });
  assert.deepEqual(edited.version, { counters: [{ id: "1", value: "2" }] });
  await assert.rejects(reopened.edit({ method: "write", folderId: "fixture-folder", path: "local-file",
    source: { size: 1, readRange: async () => assert.fail("Stale save must not read or publish") },
    expectedVersion: created.version!, modifiedMs: 3000 }), /changed/);
  let sourceReads = 0;
  await assert.rejects(reopened.edit({ method: "write", folderId: "fixture-folder", path: "local-file",
    source: { size: 3, readRange: async () => ++sourceReads === 1 ? bytes.slice(0, 3) : new Uint8Array([9, 9, 9]) },
    expectedVersion: edited.version!, modifiedMs: 3000 }), /hash|digest|checksum/i);
  assert.deepEqual((await reopened.scan()).find(file => file.name === "local-file")?.version, edited.version);
  assert.deepEqual(await reopened.readBlock("local-file", 0, Math.min(bytes.length, 131072)), bytes.slice(0, 131072));
  assert.deepEqual(await reopened.readBlock(info.name, 0, bytes.length), bytes);
  assert.deepEqual((await reopened.scan()).find(file => file.name === info.name)?.version, info.version);
  assert.equal([...files.keys()].some(path => path.includes(info.name)), false);
  assert.equal([...files.values()].some(file => new TextDecoder().decode(file.bytes).includes(info.name)), false);
  const savedIndex = files.get(".syncpeer-replica-index")!;
  files.delete(".syncpeer-replica-index");
  await assert.rejects(reopened.scan(), /index.*missing/i);
  assert.equal(files.has(".syncpeer-replica-index"), false, "Missing history must not be silently replaced");
  files.set(".syncpeer-replica-index", savedIndex);
  const replacement = new Uint8Array([4, 5, 6]);
  await reopened.receive("fixture-folder", [{ ...info, size: replacement.length, blocks: [{ offset: 0, size: 3, hash: sha256(replacement) }],
    version: { counters: [{ id: "2", value: "2" }] } }], async () => replacement);
  assert.deepEqual(await reopened.readBlock(info.name, 0, replacement.length), replacement);
  const empty = await reopened.edit({ method: "mkdir", folderId: "fixture-folder", path: "local-directory",
    expectedVersion: null, modifiedMs: 4000 });
  assert.equal(empty.type, 1);
  await assert.rejects(reopened.edit({ method: "mkdir", folderId: "fixture-folder", path: empty.name,
    expectedVersion: empty.version!, modifiedMs: 4000 }), /exists/);
  const removed = await reopened.edit({ method: "delete", folderId: "fixture-folder", path: empty.name,
    expectedVersion: empty.version!, modifiedMs: 5000 });
  assert.equal(removed.deleted, true);
  assert.deepEqual(removed.version, { counters: [{ id: "1", value: "2" }] });
  await assert.rejects(reopened.edit({ method: "mkdir", folderId: "fixture-folder", path: empty.name,
    expectedVersion: null, modifiedMs: 6000 }), /changed/);
  const recreated = await reopened.edit({ method: "mkdir", folderId: "fixture-folder", path: empty.name,
    expectedVersion: removed.version!, modifiedMs: 6000 });
  assert.deepEqual(recreated.version, { counters: [{ id: "1", value: "3" }] });
  await assert.rejects(reopened.edit({ method: "delete", folderId: "fixture-folder", path: directory.name,
    expectedVersion: directory.version, modifiedMs: 7000 }), /not empty/);
  await reopened.receive("fixture-folder", [{ ...info, deleted: true, size: 0, blocks: [],
    version: { counters: [{ id: "2", value: "3" }] } }, { ...directory, deleted: true,
    version: { counters: [{ id: "2", value: "2" }] } }], async () => assert.fail("Deletion must not download"));
  assert.equal(versions.length, 3);
  assert.equal((await reopened.scan()).find(file => file.name === info.name)?.deleted, true);
  await assert.rejects(reopened.readBlock(info.name, 0, bytes.length));
  healthy = false;
  await assert.rejects(reopened.scan(), /missing root/);
  folder.folderKey.fill(0);
});
