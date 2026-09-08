import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { aessiv } from "@noble/ciphers/aes.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { binaryPath, ensureSyncthingTools, createLanFixture } from "./lan-test/syncthing.ts";
import { createNodeFileDownloadSink } from "../packages/core/dist/transfer/nodeStorage.js";
import { FileInfo } from "../packages/core/dist/core/protocol/bep.js";
import { deriveUntrustedFolderCrypto, deriveUntrustedFileKey, encryptUntrustedFilename, encryptUntrustedBytes, encryptUntrustedBlockHash } from "../packages/core/dist/core/model/untrusted.js";
import { loadEncryptedDiskMetadata, readEncryptedDiskRange, writeEncryptedDiskFile, readEncryptedNamespace, createEncryptedDownloadSink } from "@syncpeer/core/filesystem";
import { encryptUntrustedFileInfo, decryptUntrustedFileInfo } from "../packages/core/dist/core/model/untrustedMetadata.js";
import { RemoteFs } from "../packages/core/dist/core/model/remoteFs.js";
import { listNodeReplicaEntries } from "../packages/core/dist/sync/nodeFolderStorage.js";
import { loadCiphertextDiskMetadata, readCiphertextBlock, receiveCiphertextFile } from "@syncpeer/core/filesystem";

test("keyless reception preserves ciphertext and its trailer without cryptographic access", async () => {
  const original = await fixture([new Uint8Array(131072).fill(7), new Uint8Array([1, 2, 3])]);
  const source = { size: original.bytes.length, readRange: async (offset: number, size: number) => original.bytes.slice(offset, offset + size) };
  const descriptor = await loadCiphertextDiskMetadata(source, original.encryptedName);
  let output = new Uint8Array();
  let committed = false;
  await receiveCiphertextFile({ encrypted: descriptor.encrypted,
    requestBlock: (offset, size, token) => readCiphertextBlock(source, descriptor, offset, size, token),
    createSink: async (_info, size) => {
      output = new Uint8Array(size);
      return { write: async (offset, bytes) => { assert.ok(bytes.length <= 131072); output.set(bytes, offset); },
        commit: async () => { committed = true; }, abort: async () => {} };
    } });
  assert.equal(committed, true);
  assert.deepEqual(output, original.bytes);
  await assert.rejects(readCiphertextBlock(source, descriptor, 0, 1, new Uint8Array(48)), /advertised/);
  const reopened = { size: output.length, readRange: async (offset: number, size: number) => output.slice(offset, offset + size) };
  const metadata = await loadEncryptedDiskMetadata(reopened, original.encryptedName, original.crypto.folderKey);
  try { assert.deepEqual(await readEncryptedDiskRange(reopened, metadata, 131071, 4), new Uint8Array([7, 1, 2, 3])); }
  finally { metadata.fileKey.fill(0); original.crypto.folderKey.fill(0); }
});

test("keyless reception cancellation aborts staging without publishing", async () => {
  const original = await fixture();
  const source = { size: original.bytes.length, readRange: async (offset: number, size: number) => original.bytes.slice(offset, offset + size) };
  const metadata = await loadCiphertextDiskMetadata(source, original.encryptedName);
  const controller = new AbortController();
  let aborted = false;
  await assert.rejects(receiveCiphertextFile({ encrypted: metadata.encrypted, signal: controller.signal,
    requestBlock: async (offset, size) => { controller.abort(new Error("synthetic cancellation")); return original.bytes.slice(offset, offset + size); },
    createSink: async () => ({ write: async () => assert.fail("Cancelled bytes must not be written"),
      commit: async () => assert.fail("Cancelled file must not commit"), abort: async () => { aborted = true; } }),
  }), /cancellation/);
  assert.equal(aborted, true);
});

test("keyless reception rejects truncated responses and malformed layout without publishing", async () => {
  const original = await fixture();
  const descriptor = await loadCiphertextDiskMetadata({ size: original.bytes.length,
    readRange: async (offset, size) => original.bytes.slice(offset, offset + size) }, original.encryptedName);
  let aborted = false;
  const createSink = async () => ({ write: async () => {}, commit: async () => assert.fail("Must not publish"),
    abort: async () => { aborted = true; } });
  await assert.rejects(receiveCiphertextFile({ encrypted: descriptor.encrypted, createSink,
    requestBlock: async () => new Uint8Array(1) }), /truncated|length/);
  assert.equal(aborted, true);
  await assert.rejects(receiveCiphertextFile({ encrypted: { ...descriptor.encrypted, size: 1 },
    createSink: async () => assert.fail("Malformed metadata must not open storage"),
    requestBlock: async () => assert.fail("Malformed metadata must not request bytes") }), /layout|cover/);
});

test("remote encrypted range reads translate plaintext offsets and authenticate whole blocks", async () => {
  const data = await fixture([new Uint8Array(131072).fill(7), new Uint8Array([1, 2, 3])]);
  const metadata = await loadEncryptedDiskMetadata({ size: data.bytes.length,
    readRange: async (offset, size) => data.bytes.slice(offset, offset + size) }, data.encryptedName, data.crypto.folderKey);
  const requests: Array<{ offset: number; size: number }> = [];
  const remote = new RemoteFs(new Map([["fixture-folder", { id: "fixture-folder", label: "fixture", readOnly: false,
    encrypted: true, needsPassword: false, indexReceived: true, advertisedDevices: [],
    files: new Map([[metadata.fileInfo.name, { indexFile: metadata.fileInfo, request: {
      encryptedName: data.encryptedName, encryptedBlocks: metadata.encryptedBlocks, fileKey: metadata.fileKey,
    } }]]) }]]), async (_folder, name, offset, size) => {
    assert.equal(name, data.encryptedName); requests.push({ offset, size }); return data.bytes.slice(offset, offset + size);
  }, async () => {}, () => {}, undefined, undefined, undefined, undefined, sha256);
  try {
    assert.deepEqual(await remote.readFileRange("fixture-folder", metadata.fileInfo.name, 131071, 4), new Uint8Array([7, 1, 2, 3]));
    assert.deepEqual(requests, metadata.encryptedBlocks.map(({ offset, size }) => ({ offset, size })));
    const blocks = metadata.fileInfo.blocks;
    metadata.fileInfo.blocks = [];
    await assert.rejects(remote.readFileRange("fixture-folder", metadata.fileInfo.name, 0, 1), /block|plan|cover/i);
    metadata.fileInfo.blocks = blocks;
    const size = metadata.fileInfo.size;
    metadata.fileInfo.size = -1;
    await assert.rejects(remote.readFileRange("fixture-folder", metadata.fileInfo.name, 0, 1), /size|metadata/i);
    metadata.fileInfo.size = size;
    data.bytes[30] ^= 1;
    await assert.rejects(remote.readFileRange("fixture-folder", metadata.fileInfo.name, 0, 1));
  } finally { metadata.fileKey.fill(0); data.crypto.folderKey.fill(0); }
});

test("encrypted download sink accepts split/coalesced plaintext chunks without persisting plaintext", async () => {
  const folder = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const bytes = new Uint8Array(262147).map((_, i) => i % 251);
  const fileInfo = { name: "streamed-file", size: bytes.length, block_size: 131072,
    blocks: [0, 131072, 262144].map(offset => ({ offset, size: Math.min(131072, bytes.length - offset), hash: sha256(bytes.slice(offset, offset + 131072)) })) };
  let stored = new Uint8Array();
  let committed = false;
  const { sink, encrypted } = await createEncryptedDownloadSink({ fileInfo, folderKey: folder.folderKey, randomBytes,
    createSink: async (info, size) => {
      assert.notEqual(info.name, fileInfo.name);
      stored = new Uint8Array(size);
      return { write: async (offset, chunk) => { assert.ok(chunk.length <= 131072); stored.set(chunk, offset); },
        commit: async () => { committed = true; }, abort: async () => assert.fail("Unexpected abort") };
    } });
  await sink.begin({ folderId: "fixture-folder", path: fileInfo.name, sizeBytes: bytes.length, encrypted: false });
  await sink.write(0, bytes.subarray(0, 7));
  await sink.write(7, bytes.subarray(7));
  assert.equal(committed, false);
  await sink.commit();
  assert.equal(committed, true);
  const source = { size: stored.length, readRange: async (offset: number, size: number) => stored.slice(offset, offset + size) };
  const metadata = await loadEncryptedDiskMetadata(source, encrypted.name, folder.folderKey);
  try { assert.deepEqual(await readEncryptedDiskRange(source, metadata, 0, bytes.length), bytes); }
  finally { metadata.fileKey.fill(0); folder.folderKey.fill(0); }
});

test("encrypted download sink refuses incomplete publication and drains cancellation", async () => {
  const folder = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const bytes = new Uint8Array([1, 2, 3]);
  let aborted = 0;
  const { sink } = await createEncryptedDownloadSink({ folderKey: folder.folderKey, randomBytes,
    fileInfo: { name: "file", size: 3, blocks: [{ offset: 0, size: 3, hash: sha256(bytes) }] },
    createSink: async () => ({ write: async () => {}, commit: async () => assert.fail("Incomplete publication"), abort: async () => { aborted++; } }) });
  await sink.begin({ folderId: "fixture-folder", path: "file", sizeBytes: 3, encrypted: false });
  await sink.write(0, bytes.subarray(0, 1));
  await assert.rejects(async () => sink.commit(), /incomplete/i);
  await sink.abort(new Error("cancelled"));
  await sink.abort(new Error("repeated cancellation"));
  assert.equal(aborted, 1);
  await assert.rejects(async () => sink.write(1, bytes.subarray(1)), /closed/i);
  folder.folderKey.fill(0);
});

test("encrypted download cancellation waits for native writes and prevents queued commit", async () => {
  const folder = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const bytes = new Uint8Array([1, 2, 3]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const { sink } = await createEncryptedDownloadSink({ folderKey: folder.folderKey, randomBytes,
    fileInfo: { name: "file", size: 3, blocks: [{ offset: 0, size: 3, hash: sha256(bytes) }] },
    createSink: async () => ({
      write: async () => { events.push("write"); entered.resolve(); await release.promise; events.push("written"); },
      commit: async () => assert.fail("Cancelled publication"), abort: async () => { events.push("abort"); },
    }) });
  const writing = sink.write(0, bytes);
  await entered.promise;
  const committing = assert.rejects(async () => sink.commit(), /closed/i);
  const aborting = sink.abort(new Error("cancelled"));
  assert.deepEqual(events, ["write"]);
  release.resolve();
  await Promise.all([writing, committing, aborting]);
  assert.deepEqual(events, ["write", "written", "abort"]);
  folder.folderKey.fill(0);
});

test("encrypted namespace reconstructs directories from metadata without reading contents", async () => {
  const { crypto, encryptedName, bytes, dataSize } = await fixture();
  const empty = await encryptUntrustedFilename(crypto.folderKey, "empty");
  const longName = "long-" + "x".repeat(220);
  const longDirectory = await encryptUntrustedFilename(crypto.folderKey, longName);
  const entries = new Map<string, { path: string; type: "file" | "directory"; size: number; modifiedMs: number; revision: string }>();
  for (const storedPath of [encryptedName, empty, longDirectory]) {
    const parts = storedPath.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const path = parts.slice(0, count).join("/");
      entries.set(path, { path, type: path === encryptedName ? "file" : "directory",
        size: path === encryptedName ? bytes.length : 0, modifiedMs: 0, revision: "fixture-revision" });
    }
  }
  const unusedShard = encryptedName.split("/").slice(0, 2).join("/") + "/" + "A".repeat(200);
  entries.set(unusedShard, { path: unusedShard, type: "directory", size: 0, modifiedMs: 0, revision: "fixture" });
  const source = { listEntries: async () => [...entries.values()], readRange: async (path: string, offset: number, size: number) => {
    assert.equal(path, encryptedName);
    assert.ok(offset >= dataSize, "Namespace listing must not read content blocks");
    return bytes.slice(offset, offset + size);
  } };
  const namespace = await readEncryptedNamespace(source, crypto.folderKey);
  assert.deepEqual([...namespace.keys()].sort(), ["", "empty", "nested", "nested/file", longName].sort());
  assert.equal(namespace.get("nested/file")?.fileInfo.size, 3);
  assert.equal(namespace.get("nested/file")?.metadata, "authenticated");
  assert.equal(namespace.get("nested")?.metadata, "inferred");
  assert.equal(namespace.get("empty")?.metadata, "name-only");
  await assert.rejects(readEncryptedNamespace(source, new Uint8Array(32)));
  await assert.rejects(readEncryptedNamespace(source, crypto.folderKey, AbortSignal.abort()), { name: "AbortError" });
});

test("encrypted namespace refuses unsupported storage entries without following them", async () => {
  await assert.rejects(readEncryptedNamespace({
    listEntries: async () => [{ path: "fixture-link", type: "symlink" as "file", size: 0, modifiedMs: 0, revision: "fixture" }],
    readRange: async () => assert.fail("A symlink must never be read"),
  }, new Uint8Array(32)), /symlink/i);
});

test("encrypted namespace rejects a file that collides with a parent directory", async () => {
  const child = await fixture();
  const parent = await fixture(undefined, "nested");
  const fixtures = new Map([child, parent].map(file => [file.encryptedName, file]));
  await assert.rejects(readEncryptedNamespace({
    listEntries: async () => [...fixtures.values()].map(file => ({ path: file.encryptedName, type: "file", size: file.bytes.length, modifiedMs: 0, revision: "fixture" })),
    readRange: async (path, offset, size) => fixtures.get(path)!.bytes.slice(offset, offset + size),
  }, child.crypto.folderKey), /conflict/i);
});

test("core reads actual Syncthing receiveencrypted files", { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-upstream-encrypted-"));
  const peers: Awaited<ReturnType<typeof createLanFixture>>[] = [];
  try {
    const sender = await createLanFixture({ root: path.join(root, "sender"), serverHost: "127.0.0.1", mode: "direct" });
    peers.push(sender);
    const contents = [new Uint8Array(), new Uint8Array([1, 2, 3]), new Uint8Array(131075).map((_, i) => i % 251)];
    await mkdir(path.join(sender.encryptedSharePath, "nested"));
    for (const bytes of contents) await writeFile(path.join(sender.encryptedSharePath, `nested/file-${bytes.length}`), bytes);
    const receiver = await createLanFixture({ root: path.join(root, "receiver"), serverHost: "127.0.0.1", mode: "direct" });
    peers.push(receiver);
    const received = await receiver.receiveEncryptedFrom(sender);
    const crypto = await deriveUntrustedFolderCrypto(sender.fixture.encryptedFolderId, sender.fixture.encryptedPassword);
    try {
      const namespace = await readEncryptedNamespace({
        listEntries: () => listNodeReplicaEntries(received, "", ".syncpeer-replica-index"),
        readRange: async (name, offset, size) => (await readFile(path.join(received, name))).slice(offset, offset + size),
      }, crypto.folderKey);
      assert.equal(namespace.get("nested")?.fileInfo.type, 1);
      for (const bytes of contents) {
        const name = `nested/file-${bytes.length}`;
        assert.equal(namespace.get(name)?.metadata, "authenticated");
        const encryptedName = await encryptUntrustedFilename(crypto.folderKey, name);
        const stored = await readFile(path.join(received, encryptedName));
        const source = { size: stored.length, readRange: async (offset: number, size: number) => stored.slice(offset, offset + size) };
        const metadata = await loadEncryptedDiskMetadata(source, encryptedName, crypto.folderKey);
        try {
          assert.equal(metadata.fileInfo.name, name);
          assert.equal(Number(metadata.fileInfo.size), bytes.length);
          assert.deepEqual(await readEncryptedDiskRange(source, metadata, 0, bytes.length), bytes);
          if (bytes.length > 131072) {
            assert.deepEqual(await readEncryptedDiskRange(source, metadata, 131070, 5), bytes.slice(131070, 131075));
          }
        } finally { metadata.fileKey.fill(0); }
      }
    } finally { crypto.folderKey.fill(0); }
  } finally {
    await Promise.all(peers.map(peer => peer.stop()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Syncthing decrypts files written by core, including an empty file", async () => {
  ensureSyncthingTools();
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-encrypted-format-"));
  try {
    const folderId = "fixture-folder";
    const password = "synthetic-password";
    const crypto = await deriveUntrustedFolderCrypto(folderId, password);
    const input = path.join(root, "encrypted");
    const output = path.join(root, "decrypted");
    const contents = [new Uint8Array(), new Uint8Array([1, 2, 3]), new Uint8Array(131075).map((_, i) => i % 251)];
    for (const bytes of contents) {
      await writeEncryptedDiskFile({
        source: { size: bytes.length, readRange: async (offset, size) => bytes.slice(offset, offset + size) },
        fileInfo: { name: `file-${bytes.length}`, type: 0, size: bytes.length, block_size: 131072,
          blocks: Array.from({ length: Math.max(1, Math.ceil(bytes.length / 131072)) }, (_, i) => {
            const offset = i * 131072;
            const chunk = bytes.slice(offset, offset + 131072);
            return { offset, size: chunk.length, hash: sha256(chunk) };
          }), permissions: 0o600 },
        folderKey: crypto.folderKey, randomBytes,
        createSink: async (encrypted, storedSize) => {
          const sink = await createNodeFileDownloadSink(path.join(input, encrypted.name));
          await sink.begin({ folderId, path: encrypted.name, sizeBytes: storedSize, encrypted: true });
          return sink;
        },
      });
    }
    execFileSync(binaryPath("syncthing"), ["decrypt", input, "--to", output, "--folder-id", folderId], {
      env: { ...process.env, FOLDER_PASSWORD: password }, stdio: "pipe",
    });
    for (const bytes of contents) {
      assert.deepEqual(new Uint8Array(await readFile(path.join(output, `file-${bytes.length}`))), bytes);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("encrypted writes are bounded, authenticated, and committed only after the trailer", async () => {
  const { crypto } = await fixture();
  const bytes = new Uint8Array(131075).map((_, index) => index % 251);
  const file = { name: "written-file", type: 0, size: bytes.length, block_size: 131072,
    blocks: [0, 131072].map(offset => ({ offset, size: Math.min(131072, bytes.length - offset), hash: sha256(bytes.slice(offset, offset + 131072)) })),
  };
  for (const failure of ["none", "corrupt", "cancel"]) {
    const controller = new AbortController();
    let stored = new Uint8Array();
    let committed = false;
    let aborted = false;
    const writing = writeEncryptedDiskFile({
      source: { size: bytes.length, readRange: async (offset, size) => {
        assert.ok(size <= 131072);
        return failure === "corrupt" ? new Uint8Array(size) : bytes.slice(offset, offset + size);
      } }, fileInfo: file, folderKey: crypto.folderKey, signal: controller.signal,
      randomBytes: size => new Uint8Array(size).fill(7),
      createSink: async (encrypted, storedSize) => {
        assert.notEqual(encrypted.name, file.name);
        stored = new Uint8Array(storedSize);
        return {
          write: async (offset, chunk) => {
            assert.ok(chunk.length <= 131072);
            stored.set(chunk, offset);
            if (failure === "cancel") controller.abort();
          },
          commit: async () => { committed = true; },
          abort: async () => { aborted = true; },
        };
      },
    });
    if (failure !== "none") {
      await assert.rejects(writing, failure === "corrupt" ? /digest/i : { name: "AbortError" });
      assert.equal(committed, false);
      assert.equal(aborted, true);
    } else {
      const encrypted = await writing;
      assert.equal(committed, true);
      assert.equal(aborted, false);
      const source = { size: stored.length, readRange: async (offset: number, size: number) => stored.slice(offset, offset + size) };
      const metadata = await loadEncryptedDiskMetadata(source, encrypted.name, crypto.folderKey);
      assert.deepEqual(await readEncryptedDiskRange(source, metadata, 0, bytes.length), bytes);
    }
  }
});

test("encrypted metadata uses Syncthing's wrapper without leaking original counters", async () => {
  const { crypto } = await fixture();
  const original = { name: "fixture-file", type: 0, size: 3, block_size: 131072, sequence: 9,
    blocks: [{ offset: 0, size: 3, hash: sha256(new Uint8Array([1, 2, 3])) }],
    version: { counters: [{ id: "2", value: "9007199254740993" }, { id: "3", value: "4" }] },
  };
  const encrypted = await encryptUntrustedFileInfo(crypto.folderKey, original, new Uint8Array(24).fill(8));
  assert.equal(encrypted.size, 1064);
  assert.equal(encrypted.block_size, 131112);
  assert.deepEqual(encrypted.version, { counters: [{ id: "1", value: "9007199254740997" }] });
  assert.equal(encrypted.modified_s, 1234567890);
  const decoded = await decryptUntrustedFileInfo(crypto.folderKey, encrypted);
  assert.equal(decoded.fileInfo.name, original.name);
  assert.equal(String(decoded.fileInfo.version.counters[0].value), "9007199254740993");
  assert.equal(Number(decoded.fileInfo.sequence), 9);
  const deleted = await encryptUntrustedFileInfo(crypto.folderKey, { ...original, deleted: true, blocks: [], size: 0 }, new Uint8Array(24).fill(9));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.size, 0);
});

test("encrypted block tokens bind the plaintext offset as Syncthing's eight-byte big-endian AAD", () => {
  const key = new Uint8Array(32).fill(7);
  const hash = sha256(new Uint8Array([1, 2, 3]));
  for (const offset of [0, 131072, 4294967296, Number.MAX_SAFE_INTEGER]) {
    const additional = new Uint8Array(8);
    new DataView(additional.buffer).setBigUint64(0, BigInt(offset), false);
    const token = encryptUntrustedBlockHash(key, hash, offset);
    assert.deepEqual(aessiv(key, additional).decrypt(token), hash);
    assert.deepEqual(encryptUntrustedBlockHash(key, hash, offset), token);
  }
  assert.notDeepEqual(encryptUntrustedBlockHash(key, hash, 0), encryptUntrustedBlockHash(key, hash, 131072));
  for (const offset of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encryptUntrustedBlockHash(key, hash, offset), /offset/i);
  }
});

const fixture = async (chunks = [new Uint8Array([1, 2, 3])], name = "nested/file") => {
  const crypto = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-password");
  const encryptedName = await encryptUntrustedFilename(crypto.folderKey, name);
  const fileKey = deriveUntrustedFileKey(crypto.folderKey, name);
  let plainOffset = 0;
  const blocks = chunks.map(chunk => {
    const block = { offset: plainOffset, size: chunk.length, hash: sha256(chunk) };
    plainOffset += chunk.length;
    return block;
  });
  const plain = { name, size: plainOffset, type: 0, blocks };
  const metadata = encryptUntrustedBytes(fileKey, FileInfo.encode(plain).finish(), new Uint8Array(24).fill(1));
  const bodies = chunks.map((chunk, index) => {
    const padded = new Uint8Array(Math.max(1024, chunk.length));
    padded.set(chunk);
    return encryptUntrustedBytes(fileKey, padded, new Uint8Array(24).fill(index + 2));
  });
  const body = new Uint8Array(bodies.reduce((sum, part) => sum + part.length, 0));
  let encryptedOffset = 0;
  const encryptedBlocks = bodies.map(part => {
    body.set(part, encryptedOffset);
    const block = { offset: encryptedOffset, size: part.length, hash: new Uint8Array(48) };
    encryptedOffset += part.length;
    return block;
  });
  const trailer = FileInfo.encode({ name: encryptedName, type: 0, size: body.length, encrypted: metadata,
    blocks: encryptedBlocks, sequence: 7,
  }).finish();
  const bytes = new Uint8Array(body.length + trailer.length + 4);
  bytes.set(body); bytes.set(trailer, body.length);
  new DataView(bytes.buffer).setUint32(bytes.length - 4, trailer.length, false);
  return { crypto, encryptedName, bytes, dataSize: body.length };
};

test("loads and authenticates a Syncthing-shaped trailer without reading file contents", async () => {
  const { crypto, encryptedName, bytes, dataSize } = await fixture();
  const metadata = await loadEncryptedDiskMetadata({ size: bytes.length, readRange: async (offset, size) => {
    assert.ok(offset >= dataSize, "Loading metadata must not read the content body");
    assert.ok(size <= 131072);
    return bytes.slice(offset, offset + size);
  } }, encryptedName, crypto.folderKey);
  assert.equal(metadata.fileInfo.name, "nested/file");
  assert.equal(Number(metadata.fileInfo.size), 3);
  assert.equal(Number(metadata.fileInfo.sequence), 7);
});

test("random reads skip unrelated blocks and bound each storage request", async () => {
  const chunks = [new Uint8Array(131072).fill(4), new Uint8Array(131072).fill(5), new Uint8Array([6, 7])];
  const { crypto, encryptedName, bytes } = await fixture(chunks);
  const reads: { offset: number; size: number }[] = [];
  const source = { size: bytes.length, readRange: async (offset: number, size: number) => {
    reads.push({ offset, size });
    assert.ok(size <= 131072);
    return bytes.slice(offset, offset + size);
  } };
  const metadata = await loadEncryptedDiskMetadata(source, encryptedName, crypto.folderKey);
  reads.length = 0;
  assert.deepEqual(await readEncryptedDiskRange(source, metadata, 262143, 3), new Uint8Array([5, 6, 7]));
  assert.ok(reads.every(read => read.offset >= metadata.encryptedBlocks[1].offset));
  assert.equal(reads.reduce((sum, read) => sum + read.size, 0), 131112 + 1064);
});

test("empty files have no plaintext and interrupted storage reads do not return partial bytes", async () => {
  const empty = await fixture([new Uint8Array()]);
  const source = { size: empty.bytes.length, readRange: async (offset: number, size: number) => empty.bytes.slice(offset, offset + size) };
  const metadata = await loadEncryptedDiskMetadata(source, empty.encryptedName, empty.crypto.folderKey);
  assert.deepEqual(await readEncryptedDiskRange(source, metadata, 0, 100), new Uint8Array());
  const full = await fixture();
  const fullSource = { size: full.bytes.length, readRange: async (offset: number, size: number) => full.bytes.slice(offset, offset + size) };
  const fullMetadata = await loadEncryptedDiskMetadata(fullSource, full.encryptedName, full.crypto.folderKey);
  await assert.rejects(readEncryptedDiskRange({ ...fullSource, readRange: async () => new Uint8Array() }, fullMetadata, 0, 3), /truncated/i);
  const controller = new AbortController();
  await assert.rejects(readEncryptedDiskRange({ ...fullSource, readRange: async (offset, size) => {
    controller.abort();
    return fullSource.readRange(offset, size);
  } }, fullMetadata, 0, 3, controller.signal), { name: "AbortError" });
});

test("partial reads authenticate the full block, discard padding, and respect EOF", async () => {
  const { crypto, encryptedName, bytes } = await fixture();
  const source = { size: bytes.length, readRange: async (offset: number, size: number) => bytes.slice(offset, offset + size) };
  const metadata = await loadEncryptedDiskMetadata(source, encryptedName, crypto.folderKey);
  assert.deepEqual(await readEncryptedDiskRange(source, metadata, 1, 100), new Uint8Array([2, 3]));
  assert.deepEqual(await readEncryptedDiskRange(source, metadata, 3, 100), new Uint8Array());
  await assert.rejects(readEncryptedDiskRange(source, metadata, -1, 1), /range/i);
  await assert.rejects(readEncryptedDiskRange(source, metadata, 0, 16777217), /range/i);
  bytes[30] ^= 1;
  await assert.rejects(readEncryptedDiskRange(source, metadata, 0, 1));
});

test("partial reads reject authenticated content that disagrees with the metadata hash", async () => {
  const { crypto, encryptedName, bytes, dataSize } = await fixture();
  const source = { size: bytes.length, readRange: async (offset: number, size: number) => bytes.slice(offset, offset + size) };
  const metadata = await loadEncryptedDiskMetadata(source, encryptedName, crypto.folderKey);
  const changed = encryptUntrustedBytes(metadata.fileKey, new Uint8Array(1024), new Uint8Array(24).fill(3));
  assert.equal(changed.length, dataSize);
  bytes.set(changed);
  await assert.rejects(readEncryptedDiskRange(source, metadata, 0, 1), /digest/i);
  const cancelled = AbortSignal.abort();
  await assert.rejects(readEncryptedDiskRange(source, metadata, 0, 0, cancelled), { name: "AbortError" });
});

test("rejects oversized trailers, wrong keys, and mismatched stored names", async () => {
  const { crypto, encryptedName, bytes } = await fixture();
  const source = { size: bytes.length, readRange: async (offset: number, size: number) => bytes.slice(offset, offset + size) };
  await assert.rejects(loadEncryptedDiskMetadata(source, encryptedName, new Uint8Array(32)));
  await assert.rejects(loadEncryptedDiskMetadata(source, `${encryptedName}0`, crypto.folderKey), /name/i);
  new DataView(bytes.buffer).setUint32(bytes.length - 4, 0xffffffff, false);
  await assert.rejects(loadEncryptedDiskMetadata(source, encryptedName, crypto.folderKey), /trailer/i);
});
