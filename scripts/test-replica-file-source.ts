import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { createReplicaFileSource } from "@syncpeer/core/filesystem";
import { readReplicaBlock } from "../packages/core/dist/sync/replicaIndex.js";

test("replica file source reads only covering verified blocks and keeps its captured metadata", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const info = { name: "file", type: 0, size: bytes.length,
    blocks: [0, 3, 6].map(offset => ({ offset, size: Math.min(3, bytes.length - offset), hash: sha256(bytes.slice(offset, offset + 3)) })),
    version: { counters: [{ id: "1", value: "1" }] } };
  const index = { format: 1 as const, sequence: 1, files: { file: { revision: "one", info: structuredClone(info) } } };
  const requests: number[] = [];
  let changed = false;
  const source = await createReplicaFileSource({ scan: async () => [info],
    readBlock: (path, offset, size, hash) => readReplicaBlock(index, async (_path, start, length) => {
      requests.push(start);
      return changed ? new Uint8Array(length) : bytes.slice(start, start + length);
    }, { path, offset, size, hash }, sha256) }, "file");
  info.blocks[0].hash.fill(0);
  source.fileInfo.blocks![0].hash.fill(0);
  assert.deepEqual(await source.readRange(2, 3), bytes.slice(2, 5));
  assert.deepEqual(requests, [0, 3]);
  assert.deepEqual(await source.readRange(6, 20), bytes.slice(6));
  assert.equal((await source.readRange(100, 1)).length, 0);
  await assert.rejects(source.readRange(-1, 1), /range/);
  await assert.rejects(source.readRange(0, 16 * 1024 * 1024 + 1), /range/);
  const aborted = new AbortController();
  aborted.abort(new Error("synthetic cancellation"));
  const previousRequests = requests.length;
  await assert.rejects(source.readRange(0, 1, aborted.signal), /cancellation/);
  assert.equal(requests.length, previousRequests);
  changed = true;
  await assert.rejects(source.readRange(0, 1), /changed|unavailable/);
});

test("replica file source refuses missing, unreadable, and malformed entries", async () => {
  for (const file of [undefined, { name: "file", type: 1 }, { name: "file", deleted: true },
    { name: "file", invalid: true }, { name: "file", size: 1, blocks: [] }]) {
    await assert.rejects(createReplicaFileSource({ scan: async () => file ? [file] : [],
      readBlock: async () => assert.fail("Invalid metadata must not reach storage") }, "file"));
  }
});
