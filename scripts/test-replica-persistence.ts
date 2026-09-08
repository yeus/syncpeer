import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeReplicaIndex, decodeReplicaIndex } from "../packages/core/dist/sync/replicaPersistence.js";
import { randomBytes } from "node:crypto";
import { deriveUntrustedFolderCrypto, saveEncryptedReplicaIndex, loadEncryptedReplicaIndex } from "@syncpeer/core/filesystem";
import { createCiphertextIndex, prepareCiphertextUpdate, completeCiphertextUpdate,
  encodeCiphertextIndex, decodeCiphertextIndex } from "../packages/core/dist/sync/ciphertextIndex.js";
import { encryptUntrustedFileInfo } from "../packages/core/dist/core/model/untrustedMetadata.js";

test("locked index pins folder identity and journals opaque history across restart", async () => {
  const crypto = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const original = { name: "private-synthetic-file", type: 0, size: 0, blocks: [],
    version: { counters: [{ id: "42", value: "2" }] } };
  const encrypted = await encryptUntrustedFileInfo(crypto.folderKey, original, randomBytes(24));
  const identity = { folderId: crypto.folderId, passwordToken: crypto.passwordToken };
  crypto.folderKey.fill(0); // Every index operation below is keyless.
  const initial = createCiphertextIndex(identity);
  const pending = prepareCiphertextUpdate(initial, identity, encrypted);
  assert.equal(initial.pending, undefined);
  assert.equal(pending.sequence, 0);
  assert.equal(Object.keys(pending.versions).length, 0, "uncommitted data is not advertised");
  const encoded = encodeCiphertextIndex(pending);
  assert.equal(new TextDecoder().decode(encoded).includes(original.name), false);
  const reopened = decodeCiphertextIndex(encoded, identity);
  const committed = completeCiphertextUpdate(reopened, reopened.pending!.id, "revision-one");
  assert.equal(committed.sequence, 1);
  assert.equal(committed.pending, undefined);
  assert.equal(Object.values(committed.versions)[0].verification, "pending-unlock");
  assert.deepEqual(prepareCiphertextUpdate(committed, identity, encrypted), committed);
  assert.throws(() => decodeCiphertextIndex(encoded, { ...identity, folderId: "other-fixture" }), /identity/);
  assert.throws(() => prepareCiphertextUpdate(initial, { ...identity, passwordToken: new Uint8Array(32) }, encrypted), /identity/);
  assert.throws(() => completeCiphertextUpdate(reopened, "wrong-transaction", "revision"), /transaction/);
});

test("locked index retains colliding outer versions, tombstones and directory metadata", async () => {
  const crypto = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const identity = { folderId: crypto.folderId, passwordToken: crypto.passwordToken };
  let index = createCiphertextIndex(identity);
  for (const file of [
    { name: "synthetic-file", type: 0, size: 0, version: { counters: [{ id: "42", value: "2" }] } },
    { name: "synthetic-file", type: 0, size: 0, version: { counters: [{ id: "43", value: "2" }] } },
    { name: "synthetic-file", type: 0, deleted: true, version: { counters: [{ id: "42", value: "3" }] } },
    { name: "synthetic-directory", type: 1, version: { counters: [{ id: "42", value: "1" }] } },
  ]) {
    const encrypted = await encryptUntrustedFileInfo(crypto.folderKey, file, randomBytes(24));
    const pending = prepareCiphertextUpdate(index, identity, encrypted);
    assert.throws(() => prepareCiphertextUpdate(pending, identity, encrypted), /pending/);
    index = completeCiphertextUpdate(pending, pending.pending!.id, `revision-${index.sequence}`);
  }
  const reopened = decodeCiphertextIndex(encodeCiphertextIndex(index), identity);
  assert.equal(reopened.sequence, 4);
  assert.equal(Object.keys(reopened.versions).length, 4, "opaque version sums cannot resolve hidden conflicts");
  assert.equal(Object.values(reopened.versions).filter(v => v.info.deleted).length, 1);
  assert.equal(Object.values(reopened.versions).filter(v => v.info.type === 1).length, 1);
  crypto.folderKey.fill(0);
});

test("locked index rejects corrupt transactions and does not confuse remote sequences with versions", async () => {
  const crypto = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const identity = { folderId: crypto.folderId, passwordToken: crypto.passwordToken };
  const encrypted = await encryptUntrustedFileInfo(crypto.folderKey, { name: "synthetic-file", type: 0, size: 0,
    version: { counters: [{ id: "42", value: "1" }] } }, randomBytes(24));
  const pending = prepareCiphertextUpdate(createCiphertextIndex(identity), identity, encrypted);
  const committed = completeCiphertextUpdate(pending, pending.pending!.id, "revision-one");
  assert.deepEqual(prepareCiphertextUpdate(committed, identity, { ...encrypted, sequence: 9000 }), committed);
  const corrupt = decodeCiphertextIndex(encodeCiphertextIndex(pending), identity);
  corrupt.pending!.info.encrypted![0] ^= 1;
  assert.throws(() => completeCiphertextUpdate(corrupt, corrupt.pending!.id, "revision-one"), /identity/);
  const stored = JSON.parse(new TextDecoder().decode(encodeCiphertextIndex(committed)));
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  for (const invalid of [
    { ...stored, versions: [stored.versions[0], stored.versions[0]] },
    { ...stored, sequence: 0 },
    { ...stored, versions: [{ ...stored.versions[0], sequence: -1 }] },
    { ...stored, versions: [{ ...stored.versions[0], info: [256] }] },
    { ...stored, pending: stored.versions[0] },
  ]) assert.throws(() => decodeCiphertextIndex(encode(invalid), identity));
  assert.throws(() => prepareCiphertextUpdate(createCiphertextIndex(identity), identity,
    { ...encrypted, version: { counters: [{ id: "2", value: "1" }] } }), /version/);
  crypto.folderKey.fill(0);
});

test("encrypted replica persistence hides filenames and restores the recovery journal", async () => {
  const folder = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const info = { name: "private-synthetic-file", size: 0, deleted: true,
    version: { counters: [{ id: "42", value: "9007199254740993" }] } };
  const index = { format: 1 as const, sequence: 1, files: { [info.name]: { revision: "deleted", info } }, pending: info };
  let disk = new Uint8Array();
  let committed = false;
  await saveEncryptedReplicaIndex({ index, folderKey: folder.folderKey, randomBytes,
    createSink: async (_encrypted, size) => {
      disk = new Uint8Array(size);
      return { write: async (offset, chunk) => { disk.set(chunk, offset); }, commit: async () => { committed = true; }, abort: async () => assert.fail("No failure") };
    } });
  assert.equal(committed, true);
  assert.equal(new TextDecoder().decode(disk).includes(info.name), false);
  const source = { size: disk.length, readRange: async (offset: number, size: number) => disk.slice(offset, offset + size) };
  const reopened = await loadEncryptedReplicaIndex(source, folder.folderKey);
  assert.deepEqual(reopened.pending, info);
  assert.deepEqual(reopened.files[info.name], index.files[info.name]);
  await assert.rejects(loadEncryptedReplicaIndex(source, new Uint8Array(32)));
  disk[30] ^= 1;
  await assert.rejects(loadEncryptedReplicaIndex(source, folder.folderKey));
  folder.folderKey.fill(0);
});

test("shared replica codec preserves hashes, uint64 versions, and the pending transaction", () => {
  const info = { name: "synthetic-file", type: 0, size: 3, blocks: [{ offset: 0, size: 3, hash: sha256(new Uint8Array([1, 2, 3])) }],
    version: { counters: [{ id: "18446744073709551615", value: "9007199254740993" }] } };
  const index = { format: 1 as const, sequence: 2, files: { [info.name]: { revision: "fixture-revision", info } }, pending: info };
  const reopened = decodeReplicaIndex(encodeReplicaIndex(index));
  assert.deepEqual(reopened.files[info.name], index.files[info.name]);
  assert.deepEqual(reopened.pending, info);
  assert.equal(Object.getPrototypeOf(reopened.files), null);
});

test("shared replica codec rejects unsafe paths and malformed recovery metadata", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const base = { format: 1, sequence: 0, files: {} };
  for (const pending of [{ name: "../escape" }, { name: ".syncpeer-private/index" },
    { name: "file", size: -1 }, { name: "file", blocks: [{ offset: 0, size: 1, hash: [-1] }] }]) {
    assert.throws(() => decodeReplicaIndex(encode({ ...base, pending })));
  }
  assert.throws(() => decodeReplicaIndex(encode({ ...base, files: { file: { revision: "one", info: { name: "different" } } } })));
  assert.throws(() => decodeReplicaIndex(encode({ ...base, files: [] })));
});
