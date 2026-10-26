import assert from "node:assert/strict";
import test from "node:test";
import { createServiceDownloadBridge } from "../packages/core/src/sync/serviceDownloadBridge.ts";
import { decodeBase64 } from "../packages/core/src/transfer/base64.ts";

test("service streams bounded chunks and completion from one shared peer", async () => {
  let runs = 0;
  const bridge = createServiceDownloadBridge(async (_folderId, _path, sink) => {
    runs++;
    await sink.begin({ folderId: "folder", path: "a.txt", sizeBytes: 7, encrypted: false });
    await sink.write(0, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    await sink.commit();
  }, { chunkSize: 3, bufferedFrames: 2 });
  const id = bridge.start("folder", "a.txt");
  const frames = [];
  for (;;) {
    const frame = await bridge.pull(id);
    if (frame.type === "pending") continue;
    frames.push(frame);
    if (frame.type === "commit" || frame.type === "error") break;
  }
  assert.equal(runs, 1);
  assert.deepEqual(frames.map(frame => frame.type), ["begin", "metadataEnd", "chunk", "chunk", "chunk", "commit"]);
  assert.deepEqual(frames.filter(frame => frame.type === "chunk").flatMap(frame => [...decodeBase64(frame.bytes)]), [1,2,3,4,5,6,7]);
  await assert.rejects(bridge.pull(id), /unknown/i);
});

test("service download cancellation releases blocked producers", async () => {
  let stopped = false;
  const bridge = createServiceDownloadBridge(async (_folderId, _path, sink, signal) => {
    try {
      await sink.begin({ folderId: "folder", path: "b.txt", sizeBytes: 16, encrypted: false });
      await sink.write(0, new Uint8Array(16));
    } finally { stopped = signal.aborted; }
  }, { chunkSize: 1, bufferedFrames: 1 });
  const id = bridge.start("folder", "b.txt");
  for (let attempt = 0; attempt < 10; attempt++) {
    await Promise.resolve();
  }
  bridge.cancel(id);
  for (let attempt = 0; attempt < 10 && !stopped; attempt++) await new Promise(r => setTimeout(r, 1));
  assert.equal(stopped, true);
});

test("slow consumers bound the service's transfer queue without blocking other tasks", async () => {
  let writeFinished = false;
  const bridge = createServiceDownloadBridge(async (_folderId, _path, sink) => {
    await sink.begin({ folderId: "folder", path: "large.txt", sizeBytes: 128, encrypted: false });
    await sink.write(0, new Uint8Array(128));
    writeFinished = true;
    await sink.commit();
  }, { chunkSize: 16, bufferedFrames: 2 });
  const transferId = bridge.start("folder", "large.txt");
  for (let i = 0; i < 25; i++) await Promise.resolve();
  assert.equal(writeFinished, false, "Producer cannot run ahead of a full queue.");

  let transferred = 0;
  for (;;) {
    const frame = await bridge.pull(transferId);
    if (frame.type === "pending") continue;
    if (frame.type === "chunk") {
      const bytes = decodeBase64(frame.bytes);
      assert.ok(bytes.length <= 16);
      transferred += bytes.length;
    }
    if (frame.type === "error") throw new Error(frame.message);
    if (frame.type === "commit") break;
  }
  assert.equal(transferred, 128);
  assert.equal(writeFinished, true);
});
test("large authenticated block plans use bounded IPC metadata frames", async () => {
  const blocks = Array.from({ length: 2000 }, (_, i) => ({
    offset: i * 1024, size: 1024, hash: new Uint8Array(32).fill(i % 256),
  }));
  const bridge = createServiceDownloadBridge(async (_folder, _path, sink) => {
    await sink.begin({ folderId: "folder", path: "large", sizeBytes: blocks.length * 1024,
      encrypted: false, blocks });
    await sink.commit();
  }, { bufferedFrames: 2 });
  const id = bridge.start("folder", "large");
  const types: string[] = [];
  let received = 0;
  for (;;) {
    const frame = await bridge.pull(id);
    if (frame.type === "pending") continue;
    types.push(frame.type);
    assert.ok(JSON.stringify(frame).length < 64 * 1024);
    if (frame.type === "metadataBlocks") received += frame.blocks.length;
    if (frame.type === "commit") break;
    if (frame.type === "error") throw Error(frame.message);
  }
  assert.deepEqual(types[0], "begin");
  assert.deepEqual(types.at(-2), "metadataEnd");
  assert.equal(received, blocks.length);
});
test("zero-length downloads still close an empty metadata stream before commit", async () => {
  const bridge = createServiceDownloadBridge(async (_folder, _path, sink) => {
    await sink.begin({ folderId: "folder", path: "empty", sizeBytes: 0, encrypted: false });
    await sink.commit();
  });
  const id = bridge.start("folder", "empty");
  const types: string[] = [];
  for (;;) {
    const frame = await bridge.pull(id);
    if (frame.type === "pending") continue;
    types.push(frame.type);
    if (frame.type === "metadataEnd") assert.deepEqual(frame, { type: "metadataEnd", blockCount: 0, hasBlockPlan: false });
    if (frame.type === "commit") break;
    if (frame.type === "error") throw Error(frame.message);
  }
  assert.deepEqual(types, ["begin", "metadataEnd", "commit"]);
});
test("large block plans respect a smaller configured metadata frame budget", async () => {
  const blocks = Array.from({ length: 512 }, (_, i) => ({
    offset: i * 256, size: 256, hash: new Uint8Array(32).fill((i * 7) % 256),
  }));
  const bridge = createServiceDownloadBridge(async (_folder, _path, sink) => {
    await sink.begin({ folderId: "folder", path: "large", sizeBytes: 512 * 256,
      encrypted: false, blocks });
    await sink.commit();
  }, { metadataFrameBytes: 1024 });
  const id = bridge.start("folder", "large");
  let received = 0;
  let metadataFrames = 0;
  for (;;) {
    const frame = await bridge.pull(id);
    if (frame.type === "pending") continue;
    assert.ok(JSON.stringify(frame).length <= 1024, "Metadata frames must honor the configured budget.");
    if (frame.type === "metadataBlocks") { metadataFrames++; received += frame.blocks.length; }
    if (frame.type === "metadataEnd") assert.equal(frame.blockCount, blocks.length);
    if (frame.type === "commit") break;
    if (frame.type === "error") throw Error(frame.message);
  }
  assert.ok(metadataFrames > 1);
  assert.equal(received, blocks.length);
});
test("invalid block plans are rejected before an oversized metadata frame is emitted", async () => {
  const bridge = createServiceDownloadBridge(async (_folder, _path, sink) => {
    await sink.begin({ folderId: "folder", path: "bad", sizeBytes: 2048, encrypted: false,
      blocks: [{ offset: 0, size: 1024, hash: new Uint8Array(32) }] });
    await sink.commit();
  });
  const id = bridge.start("folder", "bad");
  const types: string[] = [];
  for (;;) {
    const frame = await bridge.pull(id);
    if (frame.type === "pending") continue;
    types.push(frame.type);
    if (frame.type === "error") { assert.match(frame.message, /block plan/i); break; }
    if (frame.type === "commit") throw Error("An incomplete block plan must not commit.");
  }
  assert.deepEqual(types, ["begin", "error"]);
});

test("download polling never blocks the shared service worker while data is pending", async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bridge = createServiceDownloadBridge(async (_folder, _path, sink) => {
    await sink.begin({ folderId: "folder", path: "slow", sizeBytes: 4, encrypted: false });
    await gate;
    await sink.write(0, new Uint8Array([1, 2, 3, 4]));
    await sink.commit();
  });
  const id = bridge.start("folder", "slow");
  for (;;) {
    const frame = await bridge.pull(id);
    if (frame.type === "pending") continue;
    if (frame.type === "metadataEnd") break;
    if (frame.type === "error") throw Error(frame.message);
  }
  const started = Date.now();
  const pending = await bridge.pull(id);
  assert.equal(pending.type, "pending");
  assert.ok(Date.now() - started < 100, "Service download pull must not block on the worker.");
  release();
  const types: string[] = [];
  for (;;) {
    const frame = await bridge.pull(id);
    if (frame.type === "pending") continue;
    if (frame.type === "error") throw Error(frame.message);
    types.push(frame.type);
    if (frame.type === "commit") break;
  }
  assert.equal(types.at(-1), "commit");
});
