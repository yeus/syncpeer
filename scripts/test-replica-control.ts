import assert from "node:assert/strict";
import test from "node:test";
import { createReplicaController } from "../packages/core/dist/sync/replicaControl.js";

test("shutdown drains local publication and refuses new writes", async () => {
  const release = Promise.withResolvers<void>();
  const controller = createReplicaController({ scan: async () => [], readBlock: async () => new Uint8Array(),
    edit: async edit => { await release.promise; return { name: edit.path, size: 0 }; } });
  const edit = { method: "write" as const, folderId: "fixture-folder", path: "file", modifiedMs: 0, expectedVersion: null,
    source: { size: 0, readRange: async () => new Uint8Array() } };
  const writing = controller.edit!(edit);
  assert.equal(controller.getState().phase, "syncing");
  const closing = controller.close();
  assert.equal(controller.getState().phase, "closing");
  await assert.rejects(controller.edit!(edit), /closed/);
  release.resolve();
  await Promise.all([writing, closing]);
  assert.equal(controller.getState().phase, "closed");
});

test("closing a replica drains work without persisting a user pause", async () => {
  const release = Promise.withResolvers<void>();
  let saved = 0;
  const controller = createReplicaController({ scan: async () => { await release.promise; return []; },
    readBlock: async () => new Uint8Array() }, { paused: false, savePaused: async () => { saved++; } });
  const scanning = controller.scan();
  const closing = controller.close();
  assert.equal(controller.getState().phase, "closing");
  await assert.rejects(controller.scan(), /closed/i);
  assert.throws(() => controller.resume(), /closed/i);
  release.resolve();
  await Promise.all([scanning, closing]);
  assert.equal(controller.getState().phase, "closed");
  assert.equal(controller.isPaused(), true);
  assert.equal(saved, 0);
});

test("pausing drains active work and blocks scans and incoming changes until resume", async () => {
  let release!: () => void;
  let received = 0;
  const controller = createReplicaController({
    scan: async () => [], readBlock: async () => new Uint8Array([1]),
    receive: async () => { await new Promise<void>(resolve => { release = resolve; }); received++; return true; },
  });
  const active = controller.receive!("fixture-folder", [], async () => new Uint8Array());
  const paused = controller.pause();
  assert.equal(controller.getState().phase, "pausing");
  assert.throws(() => controller.resume(), /pausing/i);
  await assert.rejects(controller.readBlock("file", 0, 1), /paused/i);
  await assert.rejects(controller.scan(), /paused/i);
  await assert.rejects(controller.receive!("fixture-folder", [], async () => new Uint8Array()), /paused/i);
  release(); await active; await paused;
  assert.equal(controller.getState().phase, "paused");
  assert.equal(received, 1);
  await controller.resume();
  assert.deepEqual(await controller.scan(), []);
  assert.equal(controller.getState().phase, "idle");
});

test("replica errors are observable and successful retry clears them", async () => {
  let fail = true;
  const controller = createReplicaController({
    scan: async () => { if (fail) throw new Error("synthetic storage error"); return []; },
    readBlock: async () => new Uint8Array(),
  });
  const phases: string[] = [];
  const unsubscribe = controller.subscribe(state => phases.push(state.phase));
  await assert.rejects(controller.scan(), /synthetic storage error/);
  assert.equal(controller.getState().phase, "error");
  fail = false; await controller.scan();
  assert.equal(controller.getState().phase, "idle");
  assert.ok(phases.includes("error"));
  unsubscribe();
});

test("pause is idempotent and finishes even if active storage work fails", async () => {
  let reject!: (error: Error) => void;
  const controller = createReplicaController({
    scan: () => new Promise((_resolve, fail) => { reject = fail; }),
    readBlock: async () => new Uint8Array(),
  });
  const active = controller.scan();
  const failure = assert.rejects(active, /storage unavailable/);
  const paused = controller.pause();
  const alsoPaused = controller.pause();
  reject(new Error("storage unavailable"));
  await Promise.all([paused, alsoPaused, failure]);
  assert.equal(controller.isPaused(), true);
  assert.equal(controller.getState().phase, "paused");
  assert.equal(controller.getState().error, "storage unavailable");
  await controller.resume();
  assert.equal(controller.isPaused(), false);
});

test("failed persistence never silently resumes a paused replica", async () => {
  let fail = true;
  const controller = createReplicaController({
    scan: async () => [], readBlock: async () => new Uint8Array(),
  }, { paused: true, savePaused: async () => { if (fail) throw new Error("settings unavailable"); } });
  await assert.rejects(controller.resume(), /settings unavailable/);
  assert.equal(controller.isPaused(), true);
  await assert.rejects(controller.scan(), /paused/i);
  fail = false;
  await controller.resume();
  assert.deepEqual(await controller.scan(), []);
});

test("resume waits for persisted intent and refuses an overlapping pause", async () => {
  let release!: () => void;
  const controller = createReplicaController({
    scan: async () => [], readBlock: async () => new Uint8Array(),
  }, { paused: true, savePaused: () => new Promise(resolve => { release = resolve; }) });
  const resumed = controller.resume();
  assert.equal(controller.getState().phase, "resuming");
  await assert.rejects(controller.scan(), /paused/i);
  assert.throws(() => controller.pause(), /resuming/i);
  release(); await resumed;
  assert.equal(controller.getState().phase, "idle");
});

test("concurrent operations retain busy status until all finish", async () => {
  let release!: () => void;
  const controller = createReplicaController({
    scan: () => new Promise(resolve => { release = () => resolve([]); }),
    readBlock: async () => new Uint8Array([1]),
  });
  const active = controller.scan();
  assert.equal(controller.getState().phase, "scanning");
  await controller.readBlock("file", 0, 1);
  assert.equal(controller.getState().phase, "scanning");
  release(); await active;
  assert.equal(controller.getState().phase, "idle");
});
