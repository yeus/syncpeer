import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { readReplicaBlock, scanReplicaIndex } from "../packages/core/dist/sync/replicaIndex.js";
import { planReplicaMerge } from "../packages/core/dist/sync/replicaMerge.js";
import { advanceVersionVector, mergeVersionVectors } from "../packages/core/dist/core/protocol/versionVector.js";
import { receiveReplicaFiles } from "../packages/core/dist/sync/replicaReceive.js";
import { createNodeFolderReplica, saveReplicaIndex } from "../packages/core/dist/sync/nodeReplica.js";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

for (const size of [256 * 1024, 16 * 1024 * 1024]) test(`replica serves published ${size}-byte blocks but rejects oversized or changed data`, async () => {
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  const digest = sha256(bytes);
  const index = { format: 1 as const, sequence: 1, files: {
    file: { revision: "fixture", info: { name: "file", size: bytes.length,
      blocks: [{ offset: 0, size: bytes.length, hash: digest }] } },
  } };
  const request = { path: "file", offset: 0, size: bytes.length, hash: digest };
  assert.deepEqual(await readReplicaBlock(index, async () => bytes.slice(), request, sha256), bytes);
  await assert.rejects(readReplicaBlock(index, async () => bytes.slice(1), request, sha256), /changed|unavailable/);
  await assert.rejects(readReplicaBlock(index, async () => new Uint8Array(bytes.length), request, sha256), /changed|unavailable/);
  await assert.rejects(readReplicaBlock(index, async () => assert.fail("Unpublished read"),
    { ...request, size: 128 * 1024 }, sha256), /unavailable/);
  const oversized = 16 * 1024 * 1024 + 1;
  index.files.file.info.blocks[0].size = oversized;
  await assert.rejects(readReplicaBlock(index, async () => assert.fail("Oversized read"),
    { ...request, size: oversized }, sha256), /published/);
});

test("replica scans preserve causal history across restarts and retain deletions", async () => {
  let bytes = new Uint8Array(300000).fill(7);
  let revision = "one";
  let exists = true;
  let reads = 0;
  const storage = {
    listEntries: async () => exists ? [
      { path: "nested", type: "directory" as const, size: 0, modifiedMs: 1000, revision: "dir" },
      { path: "nested/file.bin", type: "file" as const, size: bytes.length, modifiedMs: 1000, revision },
    ] : [],
    readRange: async (_path: string, offset: number, size: number) => {
      reads += 1;
      assert.ok(size <= 131072, "Hashing must use bounded reads");
      return bytes.slice(offset, offset + size);
    },
  };
  const first = await scanReplicaIndex(storage, "1", null, sha256);
  assert.equal(reads, 3);
  assert.equal(first.files["nested"].info.type, 1);
  assert.equal(first.files["nested/file.bin"].info.version.counters[0].value, "1");
  const restored = structuredClone(first);
  const unchanged = await scanReplicaIndex(storage, "1", restored, sha256);
  assert.equal(reads, 3, "An unchanged restart should not rehash file contents");
  assert.deepEqual(unchanged, first);
  bytes = bytes.slice(); bytes[0] = 8; revision = "two";
  const changed = await scanReplicaIndex(storage, "1", unchanged, sha256);
  assert.equal(changed.files["nested/file.bin"].info.version.counters[0].value, "2");
  assert.notDeepEqual(changed.files["nested/file.bin"].info.blocks[0].hash, first.files["nested/file.bin"].info.blocks[0].hash);
  exists = false;
  const deleted = await scanReplicaIndex(storage, "1", changed, sha256);
  assert.equal(deleted.files["nested/file.bin"].info.deleted, true);
  assert.equal(deleted.files["nested/file.bin"].info.version.counters[0].value, "3");
  assert.deepEqual(await scanReplicaIndex(storage, "1", deleted, sha256), deleted);
});

test("replica scans reject a file changing while it is hashed", async () => {
  let revision = "before";
  const storage = {
    listEntries: async () => [{ path: "file", type: "file" as const, size: 1, modifiedMs: 0, revision }],
    readRange: async () => { revision = "after"; return new Uint8Array([1]); },
  };
  await assert.rejects(scanReplicaIndex(storage, "1", null, sha256), /changed during/);
});

test("internal root files are never hashed, advertised, or served from stale indexes", async () => {
  const names = [".stignore", ".stfolder/marker", ".stversions/old", ".syncpeer-replica.json", "nested/.stignore", "file"];
  const bytes = new Uint8Array([1]);
  const old = { name: ".stignore", size: 1, blocks: [{ offset: 0, size: 1, hash: sha256(bytes) }],
    version: { counters: [{ id: "1", value: "1" }] } };
  const stale = { format: 1 as const, sequence: 1, files: { ".stignore": { revision: "old", info: old } } };
  const index = await scanReplicaIndex({
    listEntries: async () => names.map(path => ({ path, type: "file" as const, size: 1, modifiedMs: 1000, revision: "one" })),
    readRange: async name => {
      assert.ok(name === "file" || name === "nested/.stignore", "Internal files must not reach the byte reader");
      return bytes;
    },
  }, "1", stale, sha256);
  assert.deepEqual(Object.keys(index.files).sort(), ["file", "nested/.stignore"]);
  await assert.rejects(readReplicaBlock(stale, async () => assert.fail("Internal file read"),
    { path: ".stignore", offset: 0, size: 1 }, sha256), /internal|path/i);
});

test("disk replicas exclude root control files and reject remote attempts to overwrite them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-internal-"));
  try {
    await writeFile(path.join(root, ".stignore"), "synthetic ignore rule");
    await mkdir(path.join(root, ".stfolder"));
    await writeFile(path.join(root, ".stfolder", "marker"), "synthetic marker");
    const replica = await createNodeFolderReplica(root, "1");
    assert.deepEqual(await replica.scan(), []);
    for (const name of [".stignore", ".stfolder/marker", ".stversions/old", ".syncpeer-folder-marker"]) {
      await assert.rejects(replica.receive!("fixture-folder", [{ name, size: 1,
        blocks: [{ offset: 0, size: 1, hash: sha256(new Uint8Array([1])) }],
        version: { counters: [{ id: "2", value: "1" }] },
      }], async () => assert.fail("Internal file requested")), /internal|path/i);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("disk replica reopens its index and refuses changed bytes for a published block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-replica-"));
  try {
    await mkdir(path.join(root, "empty"));
    await writeFile(path.join(root, "file"), new Uint8Array([1, 2, 3]));
    const first = await createNodeFolderReplica(root, "1");
    const initial = await first.scan();
    const reopened = await createNodeFolderReplica(root, "1");
    assert.deepEqual(await reopened.scan(), initial);
    assert.deepEqual(await reopened.readBlock("file", 0, 3), new Uint8Array([1, 2, 3]));
    await writeFile(path.join(root, "file"), new Uint8Array([4, 5, 6]));
    await assert.rejects(reopened.readBlock("file", 0, 3), /changed/);
    await assert.rejects(reopened.readBlock("../outside", 0, 3), /root|path/i);
    await rm(path.join(root, "file"));
    const deleted = await reopened.scan();
    assert.equal(deleted.find(file => file.name === "file")?.deleted, true);
    assert.equal(deleted.find(file => file.name === "empty")?.type, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("disk replica pause survives reopening and resume is durable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-pause-"));
  try {
    await writeFile(path.join(root, "file"), new Uint8Array([1]));
    const replica = await createNodeFolderReplica(root, "1");
    await replica.scan();
    await replica.pause();
    const reopened = await createNodeFolderReplica(root, "1");
    assert.equal(reopened.getState().phase, "paused");
    await assert.rejects(reopened.scan(), /paused/i);
    await reopened.resume();
    const resumed = await createNodeFolderReplica(root, "1");
    assert.equal(resumed.isPaused(), false);
    assert.equal((await resumed.scan()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid saved replica settings do not silently enable synchronization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-settings-"));
  try {
    await writeFile(path.join(root, ".syncpeer-replica-settings.json"), JSON.stringify({ format: 1, paused: "true" }));
    await assert.rejects(createNodeFolderReplica(root, "1"), /Invalid replica settings/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replica refuses a replaced root instead of treating unavailable storage as empty", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "syncpeer-root-health-"));
  const root = path.join(parent, "selected");
  try {
    await mkdir(root);
    await writeFile(path.join(root, "file"), new Uint8Array([1]));
    const replica = await createNodeFolderReplica(root, "1");
    await replica.scan();
    await rename(root, path.join(parent, "original"));
    await mkdir(root);
    await assert.rejects(replica.scan(), /root.*changed|marker/i);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("missing replica marker blocks scans and reopening without silently recreating it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-marker-"));
  try {
    const replica = await createNodeFolderReplica(root, "1");
    await replica.scan();
    await rm(path.join(root, ".syncpeer-folder-marker"), { force: true });
    await assert.rejects(replica.scan(), /marker/i);
    await assert.rejects(createNodeFolderReplica(root, "1"), /marker/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replica conflict decisions converge when peers reverse local and remote", () => {
  const a = { name: "file", size: 1, modified_s: 1, blocks: [{ offset: 0, size: 1, hash: sha256(new Uint8Array([1])) }],
    version: { counters: [{ id: "1", value: "1" }] } };
  const b = { ...a, blocks: [{ offset: 0, size: 1, hash: sha256(new Uint8Array([2])) }],
    version: { counters: [{ id: "2", value: "1" }] } };
  const ab = planReplicaMerge(a, b);
  const ba = planReplicaMerge(b, a);
  assert.deepEqual(ab.winner, ba.winner);
  assert.deepEqual(ab.conflict, ba.conflict);
  assert.equal(ab.conflict?.name.includes(".sync-conflict-"), true);
  assert.deepEqual(ab.winner.version, { counters: [{ id: "1", value: "1" }, { id: "2", value: "1" }] });
  assert.equal(planReplicaMerge(ab.winner, b).action, "keep");
});

test("equal-time conflicts use Syncthing numeric vector ordering, not content hashes", () => {
  const local = { name: "file", size: 1, modified_s: 42,
    blocks: [{ offset: 0, size: 1, hash: new Uint8Array(32) }],
    version: { counters: [{ id: "2", value: "2" }, { id: "10", value: "1" }] } };
  const remote = { ...local, blocks: [{ offset: 0, size: 1, hash: new Uint8Array(32).fill(255) }],
    version: { counters: [{ id: "10", value: "2" }, { id: "2", value: "1" }] } };
  assert.equal(planReplicaMerge(local, remote).source, "local");
  assert.equal(planReplicaMerge(remote, local).source, "remote");
  assert.deepEqual(planReplicaMerge(local, remote).winner.version.counters.map(counter => counter.id), ["2", "10"]);
});

test("published vectors are numerically ordered and reject unsigned counter overflow", () => {
  const previous = { counters: [{ id: "10", value: "1" }] };
  assert.deepEqual(advanceVersionVector(previous, "2").counters.map(counter => counter.id), ["2", "10"]);
  assert.deepEqual(mergeVersionVectors(previous, { counters: [{ id: "2", value: "1" }] }).counters.map(counter => counter.id), ["2", "10"]);
  assert.throws(() => advanceVersionVector({ counters: [{ id: "2", value: "18446744073709551615" }] }, "2"), /counter|range/i);
});

test("replica merge refuses inconsistent equal versions and preserves a concurrent live edit", () => {
  const live = { name: "file", size: 1, blocks: [{ offset: 0, size: 1, hash: sha256(new Uint8Array([1])) }],
    version: { counters: [{ id: "1", value: "1" }] } };
  assert.throws(() => planReplicaMerge(live, { ...live, size: 2 }), /same version/);
  const deleted = { ...live, size: 0, blocks: [], deleted: true, version: { counters: [{ id: "2", value: "1" }] } };
  assert.equal(planReplicaMerge(deleted, live).winner.deleted ?? false, false);
  assert.equal(planReplicaMerge(live, deleted).winner.deleted ?? false, false);
});

test("receiving a replica commits verified bytes before recording the remote version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-receive-"));
  try {
    const old = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6]);
    await writeFile(path.join(root, "file"), old);
    const replica = await createNodeFolderReplica(root, "1");
    const [local] = await replica.scan();
    const remote = { ...local, blocks: [{ offset: 0, size: 3, hash: sha256(next) }],
      version: { counters: [{ id: "1", value: "1" }, { id: "2", value: "1" }] } };
    await assert.rejects(replica.receive("fixture-folder", [remote], async () => old), /digest/);
    assert.deepEqual(await replica.readBlock("file", 0, 3), old);
    assert.equal(await replica.receive("fixture-folder", [remote], async () => next), true);
    assert.deepEqual(await replica.readBlock("file", 0, 3), next);
    assert.deepEqual((await replica.scan())[0].version, remote.version);
    assert.equal(await replica.receive("fixture-folder", [remote], async () => assert.fail("Duplicate download")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("disk replicas preserve concurrent edits and converge even when an old block is requested late", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-conflict-"));
  try {
    const aRoot = path.join(root, "a"); const bRoot = path.join(root, "b");
    await mkdir(aRoot); await mkdir(bRoot);
    await writeFile(path.join(aRoot, "file"), new Uint8Array([1]));
    await writeFile(path.join(bRoot, "file"), new Uint8Array([2]));
    const a = await createNodeFolderReplica(aRoot, "1");
    const b = await createNodeFolderReplica(bRoot, "2");
    const aIndex = await a.scan(); const bIndex = await b.scan();
    // Let the losing peer replace its original first; the winner must still fetch the loser.
    if (planReplicaMerge(aIndex[0], bIndex[0]).source === "remote") {
      await a.receive("fixture-folder", bIndex, b.readBlock);
      await b.receive("fixture-folder", aIndex, a.readBlock);
    } else {
      await b.receive("fixture-folder", aIndex, a.readBlock);
      await a.receive("fixture-folder", bIndex, b.readBlock);
    }
    const finalA = await a.scan(); const finalB = await b.scan();
    assert.deepEqual(finalA.map(file => [file.name, file.version]), finalB.map(file => [file.name, file.version]));
    assert.equal(finalA.length, 2);
    for (const file of finalA) {
      assert.deepEqual(await a.readBlock(file.name, 0, 1), await b.readBlock(file.name, 0, 1));
    }
    assert.equal(await a.receive("fixture-folder", finalB, b.readBlock), false);
    assert.equal(await b.receive("fixture-folder", finalA, a.readBlock), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const boundary of ["before-file", "after-file", "later-local-edit"] as const) {
test(`restart verifies a pending replica commit at ${boundary}`, async () => {
  let bytes = new Uint8Array([1]);
  let revision = "old";
  const source = {
    listEntries: async () => [{ path: "file", type: "file" as const, size: 1, modifiedMs: 1000, revision }],
    readRange: async () => bytes,
  };
  const initial = await scanReplicaIndex(source, "1", null, sha256);
  let saved = structuredClone(initial);
  const remote = { ...initial.files.file.info, blocks: [{ offset: 0, size: 1, hash: sha256(new Uint8Array([2])) }],
    version: { counters: [{ id: "1", value: "1" }, { id: "2", value: "1" }] } };
  await assert.rejects(receiveReplicaFiles("fixture-folder", initial, [remote], {
    ...source,
    archive: async () => {}, makeDirectory: async () => {}, remove: async () => {}, flushChanges: async () => {},
    createSink: async () => {
      const partial = new Uint8Array(1);
      return { begin: () => {}, abort: () => {},
        write: (offset, chunk) => { partial.set(chunk, offset); },
        commit: () => {
          if (boundary === "before-file") throw new Error("simulated crash before file commit");
          bytes = partial; revision = "new";
        },
      };
    },
    saveIndex: async index => {
      if (revision === "new") throw new Error("simulated crash after file commit");
      saved = structuredClone(index);
    },
  }, async () => new Uint8Array([2]), sha256), /simulated crash/);
  if (boundary === "later-local-edit") { bytes = new Uint8Array([3]); revision = "third"; }
  const recovered = await scanReplicaIndex(source, "1", saved, sha256);
  assert.deepEqual(recovered.files.file.info.version, boundary === "after-file" ? remote.version :
    { counters: [{ id: "1", value: boundary === "before-file" ? "1" : "2" }] });
  assert.equal(recovered.pending, undefined);
  assert.deepEqual(await scanReplicaIndex(source, "1", recovered, sha256), recovered);
});
}

test("pending replica metadata survives a real disk reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-journal-"));
  try {
    await writeFile(path.join(root, "file"), new Uint8Array([1]));
    const replica = await createNodeFolderReplica(root, "1");
    const [initial] = await replica.scan();
    const pending = { ...initial, blocks: [{ offset: 0, size: 1, hash: sha256(new Uint8Array([2])) }],
      version: { counters: [{ id: "1", value: "1" }, { id: "2", value: "1" }] } };
    await saveReplicaIndex(path.join(root, ".syncpeer-replica.json"), {
      format: 1, sequence: 1, files: { file: { revision: "old", info: initial } }, pending,
    });
    await writeFile(path.join(root, "file"), new Uint8Array([2]));
    const [recovered] = await (await createNodeFolderReplica(root, "1")).scan();
    assert.deepEqual(recovered.version, pending.version);
    assert.deepEqual(recovered.blocks, pending.blocks);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pending Syncthing empty-file publication recovers its version without byte reads", async () => {
  const pending = { name: "empty", type: 0, size: 0, blocks: [{ offset: 0, size: 0, hash: sha256(new Uint8Array()) }],
    version: { counters: [{ id: "2", value: "1" }] } };
  const source = { listEntries: async () => [{ path: "empty", type: "file" as const, size: 0, modifiedMs: 0, revision: "new" }],
    readRange: async () => assert.fail("Empty-file recovery needs no storage byte reads") };
  const recovered = await scanReplicaIndex(source, "1", { format: 1, sequence: 0, files: {}, pending }, sha256);
  assert.deepEqual(recovered.files.empty.info.version, pending.version);
  assert.equal(recovered.pending, undefined);
});
