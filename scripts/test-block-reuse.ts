import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { prepareCachedBlocks, verifyBlockDigests } from "../packages/core/dist/transfer/blockReuse.js";
import { RemoteFs } from "../packages/core/dist/core/model/remoteFs.js";
import { createCheckpointedDownloadSink, createSha256DownloadSink } from "../packages/core/dist/transfer/stream.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createNodeFileDownloadSink } from "../packages/core/dist/transfer/nodeStorage.js";
import { encryptUntrustedBytes } from "../packages/core/dist/core/model/untrusted.js";

const blocks = [0, 4, 8].map((offset) => ({
  offset, size: 4, hash: sha256(new Uint8Array(4).fill(offset)),
}));

test("copies only exact cached block matches", async () => {
  const copied: number[] = [];
  const ranges = await prepareCachedBlocks(blocks, 12, {
    digestCachedRanges: async (ranges) => ranges.map((range) => ({
      ...range, hash: range.offset === 4 ? sha256(new Uint8Array(4)) : blocks[range.offset / 4].hash,
    })),
    copyCachedRanges: async (ranges) => { copied.push(...ranges.map((range) => range.offset)); },
  });
  assert.deepEqual(copied, [0, 8]);
  assert.deepEqual(ranges, [{ offset: 0, size: 4 }, { offset: 8, size: 4 }]);
});

test("unavailable reuse falls back without copying", async () => {
  assert.deepEqual(await prepareCachedBlocks(blocks, 12, {}), []);
});

test("rejects unrequested and duplicate adapter digests before copying", async () => {
  for (const digests of [[{ ...blocks[0], offset: 99 }], [blocks[0], blocks[0]]]) {
    await assert.rejects(prepareCachedBlocks(blocks, 12, {
      digestCachedRanges: async () => digests,
      copyCachedRanges: async () => { assert.fail("must validate before copying"); },
    }), /digest/i);
  }
});

test("rejects invalid block coverage before touching storage", async () => {
  for (const plan of [[blocks[1]], [{ ...blocks[0], size: -1 }], [blocks[0], blocks[0]]]) {
    await assert.rejects(prepareCachedBlocks(plan, 12, {}), /block/i);
  }
});

test("final verification requires every digest to match", () => {
  verifyBlockDigests(blocks, blocks);
  assert.throws(() => verifyBlockDigests(blocks, blocks.slice(1)), /digest/i);
  assert.throws(() => verifyBlockDigests(blocks, blocks.map((block) => ({ ...block, hash: sha256(new Uint8Array(4)) }))), /digest/i);
});

test("cancellation prevents copying", async () => {
  const controller = new AbortController();
  await assert.rejects(prepareCachedBlocks(blocks, 12, {
    digestCachedRanges: async () => { controller.abort(); return blocks; },
    copyCachedRanges: async () => assert.fail("cancelled copy"),
  }, controller.signal), { name: "AbortError" });
});

for (const mode of ['plaintext', 'encrypted', 'unhashed', 'corrupted-copy']) {
test(`real ${mode} download verifies data through checkpoint and hashing wrappers`, async () => {
  const encrypted = mode === 'encrypted';
  const unhashed = mode === 'unhashed';
  const expected = new Uint8Array([0, 0, 0, 0, 4, 4, 4, 4, 8, 8, 8, 8]);
  const fileKey = new Uint8Array(32).fill(7);
  const payloads = blocks.map((block, index) => encryptUntrustedBytes(fileKey,
    expected.slice(block.offset, block.offset + block.size), new Uint8Array(24).fill(index)));
  const encryptedBlocks = payloads.map((bytes, index) => ({ offset: index * bytes.length, size: bytes.length, hash: sha256(bytes) }));
  const cached = new Uint8Array(expected);
  cached.fill(99, 4, 8);
  const partial = new Uint8Array(12);
  const requested: number[] = [];
  let committed = false;
  const remote = new RemoteFs(new Map([['test', {
    id: 'test', label: 'Test', readOnly: false, advertisedDevices: [], encrypted,
    needsPassword: false, indexReceived: true,
    files: new Map([['file.bin', { indexFile: {
      name: 'file.bin', type: 0, size: 12, blocks: unhashed ? [] : blocks,
    }, request: encrypted ? { encryptedName: 'encrypted.bin', fileKey, encryptedBlocks } : undefined }]]),
  }]]), async (_folder, _path, offset, size) => {
    requested.push(offset);
    if (encrypted) return payloads[encryptedBlocks.findIndex((block) => block.offset === offset)];
    return expected.slice(offset, offset + size);
  }, async () => {}, () => {}, undefined, undefined, undefined, undefined, sha256);
  const hashing = createSha256DownloadSink({
    begin: () => {},
    write: (offset, bytes) => { partial.set(bytes, offset); },
    commit: () => { committed = true; },
    abort: () => {},
    digestCachedRanges: async (ranges) => ranges.map((range) => ({ ...range, hash: sha256(cached.slice(range.offset, range.offset + range.size)) })),
    copyCachedRanges: async (ranges) => {
      for (const range of ranges) partial.set(cached.slice(range.offset, range.offset + range.size), range.offset);
      if (mode === 'corrupted-copy') partial[0] = 99;
    },
    digestPartialRanges: async (ranges) => ranges.map((range) => ({ ...range, hash: sha256(partial.slice(range.offset, range.offset + range.size)) })),
    digestFile: async () => Buffer.from(sha256(partial)).toString('hex'),
  });
  const checkpoint = createCheckpointedDownloadSink(hashing.sink);
  if (mode === 'corrupted-copy') {
    await assert.rejects(remote.readFileToSink('test', 'file.bin', checkpoint.sink), /digest verification failed/);
    assert.equal(committed, false);
    return;
  }
  const result = await remote.readFileToSink('test', 'file.bin', checkpoint.sink);
  assert.equal(committed, true);
  assert.deepEqual(requested, [unhashed ? 0 : encrypted ? 44 : 4]);
  assert.deepEqual(partial, expected);
  assert.equal(result.networkBytes, unhashed ? 12 : encrypted ? 44 : 4);
  assert.equal(result.reusedBytes, unhashed ? 0 : 8);
  assert.equal(hashing.digestHex(), Buffer.from(sha256(expected)).toString('hex'));
});
}

test("node storage preserves the committed file until commit and cleans aborted replacements", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syncpeer-reuse-'));
  const target = path.join(root, 'file.bin');
  try {
    await writeFile(target, new Uint8Array(12));
    const sink = await createNodeFileDownloadSink(target);
    await sink.begin({ folderId: 'test', path: 'file.bin', sizeBytes: 12, encrypted: false });
    const reused = await prepareCachedBlocks(blocks, 12, sink);
    assert.deepEqual(reused, [{ offset: 0, size: 4 }]);
    assert.deepEqual(await readFile(target), Buffer.alloc(12));
    await sink.write(4, new Uint8Array(4).fill(4));
    await sink.write(8, new Uint8Array(4).fill(8));
    verifyBlockDigests(blocks, await sink.digestPartialRanges!(blocks));
    await sink.commit();
    assert.deepEqual(await readFile(target), Buffer.from([0, 0, 0, 0, 4, 4, 4, 4, 8, 8, 8, 8]));
    const next = await createNodeFileDownloadSink(target);
    await next.begin({ folderId: 'test', path: 'file.bin', sizeBytes: 4, encrypted: false });
    await next.write(0, new Uint8Array(4).fill(99));
    await next.abort(new Error('cancelled'));
    assert.equal((await readFile(target)).length, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an indexed empty file commits without probing the peer", async () => {
  const remote = new RemoteFs(new Map([['test', {
    id: 'test', label: 'Test', readOnly: false, advertisedDevices: [], encrypted: false,
    needsPassword: false, indexReceived: true,
    files: new Map([['empty.bin', { indexFile: { name: 'empty.bin', type: 0, size: 0, blocks: [] } }]]),
  }]]), async () => { assert.fail('empty files need no block request'); }, async () => {}, () => {});
  let committed = false;
  const result = await remote.readFileToSink('test', 'empty.bin', {
    begin: (metadata) => { assert.equal(metadata.sizeBytes, 0); },
    write: () => assert.fail('empty write'),
    commit: () => { committed = true; },
    abort: () => {},
  });
  assert.equal(committed, true);
  assert.equal(result.totalBytes, 0);
});

test("node partials survive suspension and only restore the same remote version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syncpeer-resume-'));
  const target = path.join(root, 'file.bin');
  const metadata = { folderId: 'test', path: 'file.bin', sizeBytes: 12, encrypted: false, contentId: 'version-1' };
  try {
    const first = await createNodeFileDownloadSink(target);
    await first.begin(metadata);
    await first.write(0, new Uint8Array(4));
    await first.suspend!();
    const changed = await createNodeFileDownloadSink(target);
    await changed.begin({ ...metadata, contentId: 'version-2' });
    assert.deepEqual(await prepareCachedBlocks(blocks, 12, changed.resumeStorage!), []);
    await changed.abort(new Error('cancelled'));
    const second = await createNodeFileDownloadSink(target);
    await second.begin(metadata);
    assert.ok(second.resumeStorage);
    const resumed = await prepareCachedBlocks(blocks, 12, second.resumeStorage);
    assert.deepEqual(resumed, [{ offset: 0, size: 4 }]);
    await second.abort(new Error('cancelled'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new process recovers verified ranges after an ungraceful exit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'syncpeer-crash-'));
  const target = path.join(root, 'file.bin');
  const metadata = { folderId: 'test', path: 'file.bin', sizeBytes: 12, encrypted: false, contentId: 'version-1' };
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      const { createNodeFileDownloadSink } = await import(process.argv[1]);
      const sink = await createNodeFileDownloadSink(process.argv[2]);
      await sink.begin(JSON.parse(process.argv[3]));
      await sink.write(0, new Uint8Array(4));
      process.exit(0);
    `, new URL('../packages/core/dist/transfer/nodeStorage.js', import.meta.url).href, target, JSON.stringify(metadata)], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const sink = await createNodeFileDownloadSink(target);
    await sink.begin(metadata);
    assert.deepEqual(await prepareCachedBlocks(blocks, 12, sink.resumeStorage!), [{ offset: 0, size: 4 }]);
    await sink.abort(new Error('cancelled'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
