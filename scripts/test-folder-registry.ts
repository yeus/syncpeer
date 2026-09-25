import assert from "node:assert/strict";
import test from "node:test";
import { createFolderRegistry } from "../packages/core/dist/sync/folderRegistry.js";
import { createReplicaController } from "../packages/core/dist/sync/replicaControl.js";

test("folder registry persists registrations, exposes failures, and retries opening", async () => {
  const config = { id: "fixture-folder", label: "Fixture", storageId: "opaque-fixture-root" };
  let fail = true;
  let saved: typeof config[] = [];
  let closed = 0;
  const registry = createFolderRegistry({ load: async () => saved, save: async value => { saved = value; },
    open: async () => {
      if (fail) throw new Error("fixture storage locked");
      return { replica: createReplicaController({ scan: async () => [], readBlock: async () => new Uint8Array() }),
        close: async () => { closed++; } };
    } });
  await registry.initialize();
  await assert.rejects(registry.add(config), /storage locked/);
  assert.deepEqual(saved, [config]);
  assert.equal(registry.getState()[0].phase, "error");
  fail = false;
  await registry.open(config.id);
  assert.equal(registry.getState()[0].phase, "idle");
  await registry.pause(config.id);
  assert.equal(registry.getState()[0].phase, "paused");
  await registry.resume(config.id);
  await registry.detach(config.id);
  assert.equal(closed, 1);
  assert.deepEqual(saved, []);
  assert.deepEqual(registry.getState(), []);
});

test("detaching drains the existing controller and stops stale session references", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let closed = false;
  const registry = createFolderRegistry({ load: async () => [{ id: "fixture-folder", label: "Fixture", storageId: "root" }],
    save: async () => {}, open: async () => ({ replica: createReplicaController({
      scan: async () => { entered.resolve(); await release.promise; return []; }, readBlock: async () => new Uint8Array(),
    }), close: async () => { closed = true; } }) });
  await registry.initialize();
  await registry.open("fixture-folder");
  const replica = registry.getReplica("fixture-folder")!;
  const scan = replica.scan();
  await entered.promise;
  const detaching = registry.detach("fixture-folder");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([scan, detaching]);
  assert.equal(closed, true);
  await assert.rejects(replica.scan(), /paused|closed/i);
});

test("browse-only release keeps registration but closes stale local replicas", async () => {
  const config = { id: "fixture-folder", label: "Fixture", storageId: "root", downloads: true };
  let saved = [config];
  const registry = createFolderRegistry({ load: async () => saved,
    save: async value => { saved = value; },
    open: async () => ({ replica: createReplicaController({ scan: async () => [],
      readBlock: async () => new Uint8Array() }), close: async () => {} }) });
  await registry.initialize();
  await registry.open(config.id);
  const stale = registry.getReplica(config.id)!;
  await registry.markBrowseOnly(config.id);
  assert.deepEqual(saved, [{ id: config.id, label: config.label, storageId: config.storageId,
    browseOnly: true }]);
  assert.equal(registry.getReplica(config.id), undefined);
  await assert.rejects(stale.scan(), /closed/i);
  await registry.close();
});

test("signed release commits its record with browse-only state before closing the replica", async () => {
  const config = { id: "fixture-folder", label: "Fixture", storageId: "root", downloads: true };
  const release = { kind: "dangerous" as const, exception: { folderId: config.id } };
  let saved: typeof config[] | Array<{ id: string; label: string; storageId: string; browseOnly: true }> = [config];
  let committed = false, closed = false;
  const registry = createFolderRegistry({ load: async () => saved,
    save: async () => { throw new Error("unsigned browse-only save is not allowed"); },
    commitRelease: async (folders, record) => {
      assert.deepEqual(record, release);
      saved = folders as typeof saved;
      committed = true;
    },
    open: async () => ({ replica: createReplicaController({ scan: async () => [],
      readBlock: async () => new Uint8Array() }), close: async () => {
      assert.equal(committed, true);
      closed = true;
    } }) });
  await registry.initialize(); await registry.open(config.id);
  await registry.commitBrowseOnlyRelease(config.id, release);
  assert.equal(closed, true);
  assert.deepEqual(saved, [{ id: config.id, label: config.label, storageId: config.storageId,
    browseOnly: true }]);
  await registry.close();
});

test("failed catalog persistence does not forget a configured folder", async () => {
  const config = { id: "fixture-folder", label: "Fixture", storageId: "root" };
  const registry = createFolderRegistry({ load: async () => [config], save: async () => { throw new Error("fixture save failure"); },
    open: async () => ({ replica: createReplicaController({ scan: async () => [], readBlock: async () => new Uint8Array() }), close: async () => {} }) });
  await registry.initialize();
  await assert.rejects(registry.detach(config.id), /save failure/);
  assert.equal(registry.getState()[0].id, config.id);
  await assert.rejects(registry.add({ ...config, id: "other" }), /storage|root/i);
});

test("closing during an opening cancels it and releases a late handle", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  let closed = 0;
  const registry = createFolderRegistry({ load: async () => [{ id: "fixture-folder", label: "Fixture", storageId: "root" }],
    save: async () => {}, open: async (_config, signal) => {
      started.resolve(signal); await release.promise;
      return { replica: createReplicaController({ scan: async () => [], readBlock: async () => new Uint8Array() }), close: async () => { closed++; } };
    } });
  await registry.initialize();
  const opening = assert.rejects(registry.open("fixture-folder"), { name: "AbortError" });
  const signal = await started.promise;
  const closing = registry.close();
  assert.equal(signal.aborted, true);
  release.resolve();
  await Promise.all([opening, closing]);
  assert.equal(closed, 1);
  assert.equal(registry.getState()[0].phase, "closed");
});

test("failed handle cleanup stays visible and is retried on shutdown", async () => {
  let attempts = 0;
  const registry = createFolderRegistry({ load: async () => [{ id: "fixture-folder", label: "Fixture", storageId: "root" }],
    save: async () => {}, open: async () => ({
      replica: createReplicaController({ scan: async () => [], readBlock: async () => new Uint8Array() }),
      close: async () => { if (++attempts === 1) throw new Error("fixture close failure"); },
    }) });
  await registry.initialize(); await registry.open("fixture-folder");
  await assert.rejects(registry.close(), AggregateError);
  assert.equal(registry.getState()[0].phase, "error");
  await registry.close();
  assert.equal(attempts, 2);
  assert.equal(registry.getState()[0].phase, "closed");
});
