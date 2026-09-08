import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createDocumentFilesystem, dispatchDocumentCommand } from "../packages/core/dist/filesystem.js";
import { createDocumentCache } from "../packages/core/dist/sync/documentCache.js";
import { memoryDocumentStorage } from "./lan-test/replica-storage.ts";
import { createServer } from "vite";
import { createInitialSessionState } from "../packages/core/dist/ui/sessionPolicies.js";
import type * as AppActions from "../packages/app/src/app/actions.ts";
import type * as AppState from "../packages/app/src/app/state.ts";

test("opt-in cache migration preserves originals and routes downloads and picker edits through one owner", async t => {
  const { openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => null, save: async () => {}, remove: async () => {},
    } });
  await documents.initialize(); await documents.createVault("synthetic-master");
  const original = Uint8Array.of(1, 2, 3, 4);
  let legacyWrites = 0;
  let failVerification = true;
  const records = [{ key: "fixture-folder:sample.bin", folderId: "fixture-folder", path: "sample.bin", name: "sample.bin",
    localPath: "/synthetic/sample.bin", sizeBytes: 4, cachedAtMs: 10, modifiedMs: 10 }];
  const cache = createDocumentCache({ enabled: () => true,
    request: async <T>(request: Record<string, unknown>) => await dispatchDocumentCommand(documents, request) as T,
    legacy: { listCachedFiles: async () => records, cacheFile: async () => { legacyWrites++; },
      getCachedStatuses: async () => [{ path: "sample.bin", available: true, localPath: records[0].localPath }] },
    openLegacySource: async () => ({ size: 4, readRange: async (offset, size) => original.slice(offset, offset + size),
      verify: async () => { if (failVerification) throw new Error("Source changed during migration"); }, close: async () => {} }),
    show: async () => {},
  });
  assert.equal((await cache.platformAdapter.listCachedFiles!())[0].localPath, records[0].localPath);
  await assert.rejects(cache.connectFolder({ id: "fixture-folder", label: "Fixture", password: "synthetic-folder-password" }), /changed/i);
  assert.equal((await documents.status()).folders[0].downloads, undefined, "Failed verification must not switch owners");
  failVerification = false;
  await cache.connectFolder({ id: "fixture-folder", label: "Fixture", password: "synthetic-folder-password" });
  assert.equal(records.length, 1, "Migration never deletes originals");
  assert.equal(legacyWrites, 0);
  let [cached] = await cache.platformAdapter.listCachedFiles!();
  const baseline = cached.syncBaseline;
  assert.ok(baseline?.hash, "Downloads retain an encrypted sync baseline across app restarts");
  assert.ok(cached.localPath?.startsWith("syncpeer-document:"));
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!(cached.localPath!), original);
  const picker = await documents.open(cached.localPath!.slice("syncpeer-document:".length), "rw");
  await documents.write(picker, 0, Uint8Array.of(9)); await documents.release(picker);
  assert.deepEqual((await cache.platformAdapter.listCachedFiles!())[0].syncBaseline, baseline, "Picker edits must not change the last remote baseline");
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!(cached.localPath!), Uint8Array.of(9, 2, 3, 4));
  assert.equal(await cache.platformAdapter.acknowledgeCachedSync!("fixture-folder", "sample.bin", baseline!), true);
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!(cached.localPath!), Uint8Array.of(9, 2, 3, 4), "Acknowledging an uploaded snapshot never replays old bytes over picker edits");
  await cache.platformAdapter.cacheFile!("fixture-folder", "nested/new.bin", "new.bin", Uint8Array.of(8, 7), 20);
  cached = (await cache.platformAdapter.listCachedFiles!()).find(file => file.path === "nested/new.bin")!;
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!(cached.localPath!), Uint8Array.of(8, 7));
  assert.deepEqual((await cache.platformAdapter.getCachedStatuses!("fixture-folder", ["", "nested", "sample.bin", "missing.bin"]))
    .map(status => status.available), [true, true, true, false]);
  assert.equal(legacyWrites, 0, "New downloads must not write the old plaintext cache");
  const reused = await cache.platformAdapter.createFileDownloadSink!({ folderId: "fixture-folder", path: "sample.bin", name: "sample.bin", modifiedMs: 30 });
  await reused.begin({ folderId: "fixture-folder", path: "sample.bin", sizeBytes: 4, encrypted: false });
  const ranges = [{ offset: 0, size: 3 }];
  assert.equal((await reused.digestCachedRanges!(ranges)).length, 1);
  await reused.copyCachedRanges!(ranges);
  await reused.write(3, Uint8Array.of(5));
  assert.equal((await reused.digestPartialRanges!(ranges)).length, 1);
  await reused.commit();
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!((await cache.platformAdapter.listCachedFiles!()).find(file => file.path === "sample.bin")!.localPath!), Uint8Array.of(9, 2, 3, 5));
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { createAppActions } = await server.ssrLoadModule("/packages/app/src/app/actions.ts") as typeof AppActions;
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const state = createInitialState(null), session = createInitialSessionState();
  const sample = (await cache.platformAdapter.listCachedFiles!()).find(file => file.path === "sample.bin")!;
  const edit = async (byte: number) => {
    const handle = await documents.open(sample.localPath!.slice("syncpeer-document:".length), "rw");
    await documents.write(handle, 0, Uint8Array.of(byte)); await documents.release(handle);
  };
  await edit(7);
  const guarded = await cache.platformAdapter.createFileDownloadSink!({ folderId: "fixture-folder", path: "sample.bin", name: "sample.bin",
    expectedLocalHash: sample.syncBaseline!.hash });
  await assert.rejects(guarded.begin({ folderId: "fixture-folder", path: "sample.bin", sizeBytes: 4, encrypted: false }), /changed/i);
  await guarded.abort(new Error("Guard rejected stale automatic update"));
  let remoteModifiedMs = 30, uploads = 0, downloads = 0;
  session.phase = "connected";
  session.remoteFs = {
    readDir: async () => [{ name: "sample.bin", path: "sample.bin", type: "file", size: 4, modifiedMs: remoteModifiedMs }],
    writeFileFully: async (_folder, _path, bytes) => {
      uploads++; assert.deepEqual(bytes, Uint8Array.of(7, 2, 3, 5));
      await edit(6); // An independent picker edit while the old snapshot is being uploaded.
    },
    readFileFully: async () => { downloads++; return original; },
  } as unknown as NonNullable<typeof session.remoteFs>;
  state.session.isConnected = true; state.session.remoteFs = session.remoteFs;
  state.ui.isAppVisible = true;
  state.favorites.items = [{ key: sample.key, folderId: sample.folderId, path: sample.path, name: sample.name, kind: "file" }];
  const actions = createAppActions({ state,
    client: cache.platformAdapter as Parameters<typeof createAppActions>[0]["client"],
    sessionStore: { actions: { refreshOverview: async () => {} }, getState: () => session } as unknown as Parameters<typeof createAppActions>[0]["sessionStore"],
  });
  await actions.refreshActiveView();
  assert.equal(uploads, 1, "A fresh UI detects picker edits using the persisted remote baseline");
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!(sample.localPath!), Uint8Array.of(6, 2, 3, 5));
  state.sync.starredFileSyncState = {}; // Another app restart with both sides changed.
  remoteModifiedMs = 40;
  await actions.refreshActiveView();
  assert.equal(downloads, 0, "Simultaneous remote and picker edits must not blindly overwrite either side");
  assert.equal(uploads, 1);
  await documents.lock();
  await assert.rejects(cache.platformAdapter.cacheFile!("fixture-folder", "blocked.bin", "blocked.bin", original), /locked/i);
  assert.equal(legacyWrites, 0, "A locked vault must not silently fall back to plaintext");
  await documents.close();
});
