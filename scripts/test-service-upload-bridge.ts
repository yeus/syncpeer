import assert from "node:assert/strict";
import test from "node:test";
import { createServiceUploadBridge } from "../packages/core/src/sync/serviceUploadBridge.ts";

test("service requests upload chunks from the UI without buffering entire files", async () => {
  const stored: number[] = [];
  const bridge = createServiceUploadBridge(async (_folder, _path, source) => {
    const bytes = await source.read(0, source.size);
    stored.push(...bytes);
  }, { chunkSize: 3 });
  const id = bridge.start("folder", "a.txt", 7);
  let ended = false;
  while (!ended) {
    const frame = await bridge.poll(id);
    switch (frame.type) {
      case "need":
        bridge.provide(id, frame.requestId, Uint8Array.from({ length: frame.size }, (_, i) => frame.offset + i));
        break;
      case "pending": break;
      case "done": ended = true; break;
      case "error": throw Error(frame.message);
    }
  }
  assert.deepEqual(stored, [0, 1, 2, 3, 4, 5, 6]);
});

test("upload bridge rejects malformed chunks and aborts on cancellation", async () => {
  const bridge = createServiceUploadBridge(async (_folder, _path, source) => {
    await source.read(0, 9);
  }, { chunkSize: 3 });
  const id = bridge.start("folder", "b.txt", 9);
  let frame;
  do { frame = await bridge.poll(id); } while (frame.type === "pending");
  assert.equal(frame.type, "need");
  if (frame.type !== "need") return;
  assert.throws(() => bridge.provide(id, frame.requestId, Uint8Array.of(1)), /size/);
  bridge.cancel(id);
  await assert.rejects(bridge.poll(id), /unknown/i);
});

test("upload polling never blocks the shared service worker while a chunk is outstanding", async () => {
  const bridge = createServiceUploadBridge(async (_folder, _path, source) => {
    await source.read(0, 6);
  }, { chunkSize: 3 });
  const id = bridge.start("folder", "slow.txt", 6);
  // Let the producer enqueue its first request.
  let first = await bridge.poll(id);
  while (first.type === "pending") first = await bridge.poll(id);
  assert.equal(first.type, "need");
  if (first.type !== "need") return;
  // While the UI has not provided the chunk, polling must return immediately so
  // the same service worker can execute uploadProvide.
  const started = Date.now();
  const pending = await bridge.poll(id);
  assert.equal(pending.type, "pending");
  assert.ok(Date.now() - started < 100, "Service upload poll must not block on the worker.");
  bridge.provide(id, first.requestId, Uint8Array.from([1, 2, 3]));
  let frame;
  do { frame = await bridge.poll(id); } while (frame.type === "pending");
  assert.equal(frame.type, "need");
  if (frame.type === "need") bridge.provide(id, frame.requestId, Uint8Array.from([4, 5, 6]));
  for (;;) {
    frame = await bridge.poll(id);
    if (frame.type === "done") break;
    if (frame.type === "error") throw Error(frame.message);
  }
  bridge.cancel(id);
});
