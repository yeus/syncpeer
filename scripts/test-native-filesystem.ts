import assert from "node:assert/strict";
import test from "node:test";
import { createNativeFilesystem, type NativeFilesystemRequest } from "@syncpeer/core/filesystem";

test("native stat returns absent when a parent directory does not exist", async () => {
  const fs = await createNativeFilesystem(async request => {
    if (request.operation === "register") return 1;
    if (request.operation === "list") {
      assert.equal(request.path, "", "Do not list inside an absent parent");
      return [];
    }
    return null;
  }, "/synthetic-root");
  assert.equal(await fs.stat("missing/child"), null);
  await fs.close();
});

test("native replica transactions serialize and release the OS lock after failure", async () => {
  const events: string[] = [];
  const fs = await createNativeFilesystem(async request => {
    events.push(request.operation);
    return request.operation === "register" ? 1 : null;
  }, "/synthetic-root");
  await fs.initializeReplica();
  const first = fs.withLock(async () => { events.push("first"); throw new Error("synthetic failure"); });
  const second = fs.withLock(async () => { events.push("second"); await fs.checkHealth(); return 42; });
  await assert.rejects(first, /synthetic failure/);
  assert.equal(await second, 42);
  await fs.close();
  assert.deepEqual(events, ["register", "initializeReplica", "acquire", "first", "unlock", "acquire", "second", "checkHealth", "unlock", "release"]);
});

test("closing native storage drains transactions before releasing its root", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const events: string[] = [];
  const fs = await createNativeFilesystem(async request => {
    events.push(request.operation);
    return request.operation === "register" ? 1 : null;
  }, "/synthetic-root");
  const transaction = fs.withLock(async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  const closing = fs.close();
  await assert.rejects(fs.withLock(async () => {}), /closed/i);
  assert.equal(events.includes("release"), false);
  finish.resolve();
  await Promise.all([transaction, closing]);
  assert.deepEqual(events, ["register", "acquire", "unlock", "release"]);
});

test("native filesystem adapter maps directory entries and bounded reads without crypto", async () => {
  const requests: NativeFilesystemRequest[] = [];
  const fs = await createNativeFilesystem(async request => {
    requests.push(request);
    if (request.operation === "register") return 7;
    if (request.operation === "list") return request.path === ""
      ? [{ name: "nested", kind: "directory", size: 0, modifiedMs: 1, revision: "dir" }]
      : [{ name: "file", kind: "file", size: 3, modifiedMs: 2, revision: "file" }];
    if (request.operation === "read") return [1, 2, 3];
    return null;
  }, "/synthetic-root");
  const entries = await fs.listEntries();
  assert.deepEqual(entries.map(entry => entry.path), ["nested", "nested/file"]);
  assert.deepEqual(await fs.stat("nested/file"), entries[1]);
  assert.equal(await fs.stat("missing"), null);
  assert.deepEqual(await fs.readRange("nested/file", 0, 3), new Uint8Array([1, 2, 3]));
  const count = requests.length;
  await assert.rejects(fs.readRange("../escape", 0, 1));
  await assert.rejects(fs.readRange("nested/file", 0, 131073));
  assert.equal(requests.length, count);
  await fs.close();
  await fs.close();
  await assert.rejects(fs.listEntries(), /closed/i);
  assert.equal(requests.filter(request => request.operation === "release").length, 1);
});

test("native root closure waits for accepted I/O and rejects new work", async () => {
  const events: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const fs = await createNativeFilesystem(async request => {
    events.push(request.operation);
    if (request.operation === "register") return 1;
    if (request.operation === "read") { await pending; return [4]; }
    return null;
  }, "/synthetic-root");
  const reading = fs.readRange("file", 0, 1);
  const closing = fs.close();
  await assert.rejects(fs.readRange("file", 0, 1), /closed/i);
  assert.equal(events.includes("release"), false);
  finish();
  await reading;
  await closing;
  assert.deepEqual(events, ["register", "read", "release"]);
});

test("native staged sinks stop accepting writes after commit or cancellation", async () => {
  const events: string[] = [];
  const fs = await createNativeFilesystem(async request => {
    events.push(request.operation);
    return request.operation === "register" ? 1 : request.operation === "begin" ? 2 : null;
  }, "/synthetic-root");
  const sink = await fs.createSink("file", 3);
  await sink.write(0, new Uint8Array([1, 2, 3]));
  await sink.commit();
  await sink.abort(new Error("late cancellation"));
  await assert.rejects(Promise.resolve().then(() => sink.write(0, new Uint8Array([4]))), /closed/i);
  assert.deepEqual(events, ["register", "begin", "write", "commit"]);
  const cancelled = await fs.createSink("cancelled", 3);
  await cancelled.abort(new Error("cancelled"));
  await assert.rejects(Promise.resolve().then(() => cancelled.commit()), /closed/i);
  await fs.close();
});

test("native adapter rejects malformed byte responses and unsafe directory entries", async () => {
  const fs = await createNativeFilesystem(async request => {
    if (request.operation === "register") return 1;
    if (request.operation === "read") return [256];
    if (request.operation === "list") return [{ name: "../escape", kind: "file", size: 1, modifiedMs: 0, revision: "fixture" }];
    return null;
  }, "/synthetic-root");
  try {
    await assert.rejects(fs.readRange("file", 0, 1), /bytes/i);
    await assert.rejects(fs.listEntries(), /entry|path/i);
  } finally { await fs.close(); }
});
