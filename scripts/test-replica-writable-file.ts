import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { createFolderReplica, openReplicaWritableFile } from "@syncpeer/core/filesystem";
import type { ReplicaIndex } from "../packages/core/src/sync/replicaIndex.js";

test("writable replica file commits sparse writes and truncates through the existing edit path", async () => {
  let bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  let revision = "initial";
  let index: ReplicaIndex | null = null;
  const sourceReads: Array<[number, number]> = [];
  const commits: Array<{ path: string; version: unknown; content: number[] }> = [];
  const replica = createFolderReplica({
    withLock: async operation => operation(),
    loadIndex: async () => index,
    saveIndex: async value => { index = structuredClone(value); },
    listEntries: async () => [{ path: "note.bin", type: "file", size: bytes.length, modifiedMs: 1000, revision }],
    readRange: async (_path, offset, size) => {
      sourceReads.push([offset, size]);
      return bytes.slice(offset, offset + size);
    },
    flushChanges: async () => {},
    archive: async () => {},
    makeDirectory: async () => assert.fail("No directory edits expected"),
    remove: async () => assert.fail("No deletion expected"),
    createSink: async info => {
      const next = new Uint8Array(Number(info.size));
      return {
        begin: async () => {},
        write: async (offset, chunk) => { next.set(chunk, offset); },
        commit: async () => {
          bytes = next;
          revision = `commit-${commits.length}`;
          commits.push({ path: info.name, version: structuredClone(info.version), content: [...next] });
        },
        abort: async () => {},
      };
    },
  }, "1", sha256);
  await replica.scan();
  sourceReads.length = 0;
  const scratch = memoryScratch();
  const handle = await openReplicaWritableFile(replica, {
    folderId: "fixture-folder", path: "note.bin", open: "existing", scratch, modifiedMs: 2000,
  });
  await handle.write(2, new Uint8Array([9, 9]));
  await handle.truncate(5);
  assert.deepEqual(await handle.readRange(0, 10), new Uint8Array([1, 2, 9, 9, 5]));
  const published = await handle.commit();
  assert.deepEqual(bytes, new Uint8Array([1, 2, 9, 9, 5]));
  assert.deepEqual(published.version, { counters: [{ id: "1", value: "2" }] });
  assert.deepEqual(commits, [{ path: "note.bin", version: published.version, content: [1, 2, 9, 9, 5] }]);
  assert.deepEqual(sourceReads, [[0, 6]]);
  assert.ok(scratch.events.filter(event => event[0] === "read").every(([, , size]) => size! <= 131072));
});

test("writable replica file rejects stale commits and prevents further use after close", async () => {
  let bytes = new Uint8Array([1, 2, 3]);
  let revision = "one";
  let index: ReplicaIndex | null = null;
  const replica = createFolderReplica({
    withLock: async operation => operation(),
    loadIndex: async () => index,
    saveIndex: async value => { index = structuredClone(value); },
    listEntries: async () => [{ path: "file", type: "file", size: bytes.length, modifiedMs: 1000, revision }],
    readRange: async (_path, offset, size) => bytes.slice(offset, offset + size),
    flushChanges: async () => {},
    archive: async () => {},
    makeDirectory: async () => assert.fail("No directory edits expected"),
    remove: async () => assert.fail("No deletion expected"),
    createSink: async info => ({
      begin: async () => {},
      write: async () => {},
      commit: async () => { bytes = new Uint8Array(Number(info.size)); revision = "written"; },
      abort: async () => {},
    }),
  }, "1", sha256);
  const [initial] = await replica.scan();
  const handle = await openReplicaWritableFile(replica, {
    folderId: "fixture-folder", path: "file", open: "existing", scratch: memoryScratch(), modifiedMs: 2000,
  });
  await replica.edit!({ method: "write", folderId: "fixture-folder", path: "file", expectedVersion: initial.version!,
    modifiedMs: 1500, source: { size: 1, readRange: async () => new Uint8Array([8]) } });
  await handle.write(0, new Uint8Array([9]));
  await assert.rejects(handle.commit(), /changed/);
  await assert.rejects(handle.write(0, new Uint8Array([1])), /closed/);

  const created = await openReplicaWritableFile(replica, {
    folderId: "fixture-folder", path: "new-file", open: "create", scratch: memoryScratch(), modifiedMs: 3000,
  });
  await created.write(2, new Uint8Array([7]));
  assert.deepEqual(await created.readRange(0, 3), new Uint8Array([0, 0, 7]));
  assert.equal((await created.commit()).name, "new-file");
  await assert.rejects(openReplicaWritableFile(replica, {
    folderId: "fixture-folder", path: "file", open: "create", scratch: memoryScratch(), modifiedMs: 3000,
  }), /exists/);
});

test("writable replica file closes scratch storage when opening fails", async () => {
  const scratch = memoryScratch();
  await assert.rejects(openReplicaWritableFile({
    scan: async () => [{ name: "missing", type: 0, size: 1, blocks: [] }],
    readBlock: async () => assert.fail("Malformed metadata must not read storage"),
    edit: async () => assert.fail("Open failure must not publish"),
  }, { folderId: "fixture-folder", path: "missing", open: "existing", scratch }), /block|plan|cover/i);
  assert.equal(scratch.isClosed(), true);
});

function memoryScratch() {
  let bytes = new Uint8Array();
  let closed = false;
  const events: Array<[string, number?, number?]> = [];
  return {
    events,
    size: async () => bytes.length,
    readRange: async (offset: number, size: number) => {
      events.push(["read", offset, size]);
      return bytes.slice(offset, Math.min(bytes.length, offset + size));
    },
    write: async (offset: number, chunk: Uint8Array) => {
      events.push(["write", offset, chunk.length]);
      const next = new Uint8Array(Math.max(bytes.length, offset + chunk.length));
      next.set(bytes);
      next.set(chunk, offset);
      bytes = next;
    },
    truncate: async (size: number) => {
      events.push(["truncate", size]);
      const next = new Uint8Array(size);
      next.set(bytes.subarray(0, size));
      bytes = next;
    },
    close: async () => { closed = true; events.push(["close"]); },
    isClosed: () => closed,
  };
}
