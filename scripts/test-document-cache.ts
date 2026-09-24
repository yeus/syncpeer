import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { createDocumentFilesystem, dispatchDocumentCommand } from "../packages/core/dist/filesystem.js";
import { createDocumentCache } from "../packages/core/dist/sync/documentCache.js";
import { createOwnedRecoveryKit } from "../packages/core/dist/sync/personalSpaceSharing.js";
import { memoryDocumentStorage } from "./lan-test/replica-storage.ts";
import { createServer } from "vite";
import { createInitialSessionState } from "../packages/core/dist/ui/sessionPolicies.js";
import type { CachedFileRecord } from "../packages/core/src/ui/browserClient.ts";
import type * as AppActions from "../packages/app/src/app/actions.ts";
import type * as AppState from "../packages/app/src/app/state.ts";
import type * as DeviceActions from "../packages/app/src/app/deviceActions.ts";
import type * as DirectoryActions from "../packages/app/src/app/directoryActions.ts";
import type * as StarredActions from "../packages/app/src/app/starredActions.ts";
import type { TransferRuntime } from "../packages/app/src/app/transferRuntime.ts";

test("password actions publish changes only after secure storage succeeds", async t => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { createDeviceActions } = await server.ssrLoadModule("/packages/app/src/app/deviceActions.ts") as typeof DeviceActions;
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const state = createInitialState(null);
  state.passwords.saved = { photos: "synthetic-old" };
  state.passwords.drafts = { photos: "synthetic-new" };
  let failSave = true, sessionUpdates = 0;
  const actions = createDeviceActions({ state, client: {} as never,
    sessionStore: { actions: { setFolderPasswords: async () => { sessionUpdates++; } } } as never,
    refreshOverview: async () => {}, refreshActiveView: async () => {}, refreshCurrentDeviceId: async () => {},
    savePasswords: async () => { if (failSave) throw new Error("Synthetic secure storage failure"); },
  });
  await actions.saveFolderPassword("photos");
  assert.deepEqual(state.passwords.saved, { photos: "synthetic-old" });
  assert.equal(sessionUpdates, 0);
  failSave = false;
  await actions.saveFolderPassword("photos");
  assert.deepEqual(state.passwords.saved, { photos: "synthetic-new" });
  assert.equal(sessionUpdates, 1);
  failSave = true;
  await actions.clearFolderPassword("photos");
  assert.deepEqual(state.passwords.saved, { photos: "synthetic-new" });
  assert.equal(sessionUpdates, 1);
});

test("local folders can be browsed offline and with a locked remote connection", async t => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { createDirectoryActions } = await server.ssrLoadModule("/packages/app/src/app/directoryActions.ts") as typeof DirectoryActions;
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const state = createInitialState(null);
  state.localFolders = [{ id: "photos", label: "Photos", readOnly: false }];
  let failRead = false;
  const actions = createDirectoryActions({ state,
    client: { listLocalDirectory: async () => { if (failRead) throw new Error("Synthetic locked storage"); return []; },
      getCachedStatuses: async () => [] } as never,
    sessionStore: { actions: { goToPath: async () => assert.fail("Local browsing must not contact a peer") } } as never,
    refreshActiveView: async () => {}, syncStarredFiles: async () => {},
  });
  await actions.openFolderRoot("photos");
  assert.equal(state.session.currentFolderId, "photos");
  assert.deepEqual(state.session.entries, []);
  state.session.isConnected = true;
  state.session.folders = [{ id: "photos", label: "Photos", readOnly: true, encrypted: true, needsPassword: true }];
  assert.equal(await actions.openLocation("photos", "", "fixture.open", {}), true);
  failRead = true;
  assert.equal(await actions.openLocation("photos", "", "fixture.open", {}), false);
  assert.equal(state.ui.recentError, "Synthetic locked storage");
});

test("offline browsing loads remote entries from the encrypted catalog", async t => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { createDirectoryActions } = await server.ssrLoadModule("/packages/app/src/app/directoryActions.ts") as typeof DirectoryActions;
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const state = createInitialState(null);
  state.connection.remoteId = "ABCDEFG2";
  state.session.folders = [{ id: "photos", label: "Photos", readOnly: true, needsPassword: false }];
  const actions = createDirectoryActions({ state, client: {
    listLocalDirectory: async () => null,
    loadDirectorySnapshot: async (folderId: string, sourceDeviceId: string, path: string) => {
      assert.deepEqual({ folderId, sourceDeviceId, path },
        { folderId: "photos", sourceDeviceId: "ABCDEFG2", path: "album" });
      return { entries: [{ name: "remote-only.jpg", path: "album/remote-only.jpg", type: "file", size: 4, modifiedMs: 1 }],
        versionKey: "v1", loadedAtMs: 2 };
    },
  } as never, sessionStore: {} as never, refreshActiveView: async () => {}, syncStarredFiles: async () => {} });
  assert.equal(await actions.openLocation("photos", "album", "fixture.open", {}), true);
  assert.deepEqual(state.session.entries.map(entry => entry.name), ["remote-only.jpg"]);
  assert.equal(state.session.isOfflineSnapshot, true);
});

test("unfavoriting an inherited child creates a device-local exclusion", async t => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { createDirectoryActions } = await server.ssrLoadModule("/packages/app/src/app/directoryActions.ts") as typeof DirectoryActions;
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const state = createInitialState(null);
  state.favorites.items = [{ key: "folder:photos:album", folderId: "photos", path: "album", name: "album", kind: "folder" }];
  let saved: unknown;
  const actions = createDirectoryActions({ state, client: {
    loadProfileSettings: async () => ({ format: 1, profile: { versioning: "staggered", preserveLocalChanges: true,
      cache: { percent: 5, minimumBytes: 1, maximumBytes: 2 }, allowMetered: false, autoMount: false }, folders: {}, devices: {} }),
    saveProfileSettings: async value => { saved = structuredClone(value); },
  } as never, sessionStore: {} as never, refreshActiveView: async () => {}, syncStarredFiles: async () => {} });
  await actions.toggleFavorite("photos", "album/raw", "raw", "folder");
  assert.deepEqual(state.favorites.exclusions, [{ folderId: "photos", path: "album/raw", kind: "folder" }]);
  assert.deepEqual((saved as { folders: Record<string, { exclusions: unknown[] }> }).folders.photos.exclusions,
    state.favorites.exclusions);
});

test("a favorite folder downloads its non-ignored descendants", async t => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { createStarredActions } = await server.ssrLoadModule("/packages/app/src/app/starredActions.ts") as typeof StarredActions;
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const state = createInitialState(null);
  state.ui.isAppVisible = true; state.session.isConnected = true;
  state.favorites.items = [{ key: "folder:code:", folderId: "code", path: "", name: "Code", kind: "folder" }];
  const visited: string[] = [], downloaded: string[] = [];
  state.session.remoteFs = {
    readDir: async (_folderId: string, path: string) => {
      visited.push(path);
      if (!path) return [
        { name: "src", path: "src", type: "directory", size: 0, modifiedMs: 1 },
        { name: "node_modules", path: "node_modules", type: "directory", size: 0, modifiedMs: 1 },
      ];
      return path === "src" ? [{ name: "index.ts", path: "src/index.ts", type: "file", size: 2, modifiedMs: 2 }] : [];
    },
    readFileFully: async (_folderId: string, path: string) => { downloaded.push(path); return Uint8Array.of(1, 2); },
  } as never;
  const actions = createStarredActions({ state, client: { listCachedFiles: async () => [],
    cacheFile: async () => {} } as never, transfers: {
    begin: async () => {}, update: () => {}, finish: async () => {},
  } as never });
  await actions.syncStarredFiles();
  assert.deepEqual(downloaded, ["src/index.ts"]);
  assert.deepEqual(visited, ["", "src"]);
  assert.equal(visited.includes("node_modules"), false);
  state.favorites.pausedFolderIds.add("code");
  downloaded.length = 0; visited.length = 0;
  await actions.syncStarredFiles();
  assert.deepEqual(downloaded, [], "Paused favorite folders do not transfer descendants");
  assert.deepEqual(visited, [], "Paused favorite folders are not traversed");
});

test("discovery retains empty roots across peers and only downloads enter the local directory", async () => {
  const { openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const documents = createDocumentFilesystem({ profileId: "fixture", deviceCounterId: "42", openStorage, availableBytes: async () => 1024 * 1024 * 1024,
    profile: await openStorage("profile"), randomBytes, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => secret,
      save: async value => { secret = value; }, remove: async () => { secret = null; },
    } });
  await documents.initialize();
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  await documents.createVault("synthetic-master-password", true, "OWNER", kit.publicKey);
  const legacyFavorite = { key: "folder:photos:", folderId: "photos", path: "", name: "Photos", kind: "folder" as const };
  let legacyFavorites = [legacyFavorite];
  const cache = createDocumentCache({ enabled: () => true,
    request: async <T>(input: Record<string, unknown>) => await dispatchDocumentCommand(documents, input) as T,
    legacy: { listCachedFiles: async () => [], cacheFile: async () => assert.fail("No plaintext fallback"),
      listFavorites: async () => legacyFavorites, removeFavorite: async key =>
        legacyFavorites = legacyFavorites.filter(item => item.key !== key) },
    openLegacySource: async () => { throw new Error("No legacy files"); }, show: async () => {},
  });
  await cache.syncFolders([{ id: "photos", label: "Photos", readOnly: true, encrypted: true, needsPassword: true }], {});
  assert.deepEqual(await cache.platformAdapter.listLocalDirectory!("photos", ""), []);
  await assert.rejects(cache.platformAdapter.cacheFile!("photos", "image.bin", "image.bin", Uint8Array.of(1)), /not ready/);
  await Promise.all([
    cache.syncFolders([{ id: "photos", label: "Photos", readOnly: true, encrypted: true, needsPassword: false }],
      { photos: "synthetic-remote-password" }),
    cache.platformAdapter.cacheFile!("photos", "image.bin", "image.bin", Uint8Array.of(1)),
  ]);
  assert.deepEqual(await cache.platformAdapter.listFavorites!(), [legacyFavorite]);
  const sharedFolders = await cache.platformAdapter.sessionSharedFolders!("OWNER");
  const settingsFolderId = sharedFolders[0].id;
  assert.match(settingsFolderId, /^[a-f0-9]{32}$/);
  assert.deepEqual(sharedFolders.map(folder => ({ id: folder.id, mode: folder.encryption.mode })), [
    { id: settingsFolderId, mode: "encrypted" },
    { id: "photos", mode: "encrypted" },
  ]);
  assert.deepEqual((await cache.platformAdapter.sessionSharedFolders!("OWNER"))
    .map(folder => folder.encryption.mode), ["encrypted", "encrypted"],
  "A registered encrypted folder must never be advertised as plaintext when connection passwords are absent");
  assert.equal(sharedFolders.every(folder => typeof folder.replica?.scan === "function"), true);
  await assert.rejects(cache.connectFolder({ id: "photos", label: "Photos", password: "different-password" }), /migration/i);
  await cache.syncFolders([{ id: "music", label: "Music", readOnly: false }], {});
  assert.deepEqual((await cache.platformAdapter.sessionSharedFolders!("OWNER"))
    .map(folder => folder.id), [settingsFolderId, "photos"],
  "The hidden settings folder and whole-folder favorites are advertised as replicas");
  assert.deepEqual(await cache.platformAdapter.listFavorites!(), [legacyFavorite]);
  assert.deepEqual(legacyFavorites, [], "Legacy plaintext favorite settings are removed after encrypted migration");
  const favorite = legacyFavorite;
  assert.deepEqual(await cache.platformAdapter.upsertFavorite!(favorite), [favorite]);
  assert.deepEqual(await cache.platformAdapter.listFavorites!(), [favorite]);
  const settings = await cache.platformAdapter.loadProfileSettings!();
  assert.equal(settings.profile.versioning, "staggered");
  assert.equal(settings.folders.photos?.ignorePatterns.includes("node_modules/"), true);
  assert.deepEqual(await cache.platformAdapter.sessionSharedFolders!("EXTERNAL"), [],
    "Unlisted external devices receive neither documents nor private settings");
  await documents.savePersonalSpaceSetting(["folders", "photos", "shareTargets"],
    [{ kind: "device", syncthingId: "EXTERNAL" }]);
  assert.deepEqual((await cache.platformAdapter.sessionSharedFolders!("EXTERNAL"))
    .map(folder => folder.id), ["photos"],
  "An explicitly shared document folder does not also disclose the personal-space settings folder");
  assert.deepEqual((await cache.platformAdapter.sessionSharedFolders!("OWNER"))
    .map(folder => folder.id), [settingsFolderId]);
  assert.deepEqual(await cache.platformAdapter.removeFavorite!(favorite.key), []);
  const known = await cache.syncFolders([], {});
  assert.deepEqual(known.map(folder => folder.label), ["Photos", "Music"]);
  assert.deepEqual((await cache.platformAdapter.listLocalDirectory!("photos", ""))!.map(entry => entry.name), ["image.bin"]);
  assert.deepEqual(await cache.platformAdapter.listLocalDirectory!("music", ""), []);
  await documents.close();
});

test("fresh-install startup uses default settings while keeping existing plaintext cache browsable", async t => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { createAppActions } = await server.ssrLoadModule("/packages/app/src/app/actions.ts") as typeof AppActions;
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const { openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "uninitialized-cache", deviceCounterId: "42", openStorage,
    availableBytes: async () => 1024 * 1024 * 1024, profile: await openStorage("profile"), randomBytes,
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => null,
      save: async () => {}, remove: async () => {} } });
  await documents.initialize();
  let opened = 0;
  const cache = createDocumentCache({ enabled: () => true,
    request: async <T>(input: Record<string, unknown>) => await dispatchDocumentCommand(documents, input) as T,
    legacy: { openCachedFile: async (folderId, path) => {
      assert.deepEqual({ folderId, path }, { folderId: "legacy-folder", path: "legacy.txt" }); opened++;
    } }, openLegacySource: async () => { throw new Error("No legacy source"); },
    show: async () => { assert.fail("An uninitialized vault must use the legacy cache"); } });
  const settings = await cache.platformAdapter.loadProfileSettings!();
  assert.equal(settings.profile.versioning, "staggered");
  assert.deepEqual(settings.folders, {});
  assert.deepEqual(await cache.platformAdapter.listFavorites!(), []);
  const state = createInitialState(null);
  const actions = createAppActions({ state,
    client: cache.platformAdapter as Parameters<typeof createAppActions>[0]["client"],
    sessionStore: {} as Parameters<typeof createAppActions>[0]["sessionStore"],
    transfers: { begin: () => {}, update: () => {}, finish: () => {} } as unknown as TransferRuntime,
  });
  await actions.hydrate();
  assert.equal(state.ui.recentError, null);
  assert.deepEqual(state.favorites.items, []);
  await cache.platformAdapter.openCachedFile!("legacy-folder", "legacy.txt");
  assert.equal(opened, 1);
  await documents.createVault("synthetic-master");
  await documents.lock();
  await assert.rejects(cache.platformAdapter.loadProfileSettings!(), /locked/i,
    "An existing locked vault must not expose encrypted settings as defaults");
  await documents.close();
});

test("cache migration verifies and removes plaintext originals", async t => {
  const { openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "fixture", deviceCounterId: "42", openStorage, availableBytes: async () => 1024 * 1024 * 1024,
    profile: await openStorage("profile"), randomBytes, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => null, save: async () => {}, remove: async () => {},
    } });
  await documents.initialize(); await documents.createVault("synthetic-master");
  await assert.rejects(dispatchDocumentCommand(documents, { operation: "saveProfileSettings" }),
    /settings/i, "Malformed commands cannot silently reset encrypted settings to defaults");
  const original = Uint8Array.of(1, 2, 3, 4);
  let legacyWrites = 0;
  let failVerification = true, failRemoval = false;
  let digestOperations: string[] | null = null;
  const records = [{ key: "fixture-folder:sample.bin", folderId: "fixture-folder", path: "sample.bin", name: "sample.bin",
    localPath: "/synthetic/sample.bin", sizeBytes: 4, cachedAtMs: 10, modifiedMs: 10 }];
  const cache = createDocumentCache({ enabled: () => true,
    request: async <T>(request: Record<string, unknown>) => {
      if (digestOperations) digestOperations.push(String(request.operation));
      return await dispatchDocumentCommand(documents, request) as T;
    },
    legacy: { listCachedFiles: async () => records, cacheFile: async () => { legacyWrites++; },
      digestCachedFiles: async files => files.map(file => ({ ...file, hash: "synthetic-legacy-hash" })),
      removeCachedFile: async (folderId, path) => {
        if (failRemoval) return false;
        const index = records.findIndex(value => value.folderId === folderId && value.path === path);
        if (index < 0) return false;
        records.splice(index, 1); return true;
      },
      getCachedStatuses: async () => [{ path: "sample.bin", available: true, localPath: records[0].localPath }] },
    openLegacySource: async () => ({ size: 4, readRange: async (offset, size) => original.slice(offset, offset + size),
      verify: async () => { if (failVerification) throw new Error("Source changed during migration"); }, close: async () => {} }),
    show: async () => {},
  });
  assert.equal((await cache.platformAdapter.listCachedFiles!())[0].localPath, records[0].localPath);
  assert.deepEqual(await cache.platformAdapter.digestCachedFiles!([{ folderId: "fixture-folder", path: "sample.bin" }]),
    [{ folderId: "fixture-folder", path: "sample.bin", hash: "synthetic-legacy-hash" }],
    "Unmigrated files retain the native digest path");
  await assert.rejects(cache.connectFolder({ id: "fixture-folder", label: "Fixture", password: "synthetic-folder-password" }), /changed/i);
  assert.equal((await documents.status()).folders[0].downloads, undefined, "Failed verification must not switch owners");
  failVerification = false;
  await cache.connectFolder({ id: "fixture-folder", label: "Fixture", password: "synthetic-folder-password" });
  assert.equal(records.length, 0, "Verified migration removes the old plaintext copy");
  assert.equal(legacyWrites, 0);
  let [cached] = await cache.platformAdapter.listCachedFiles!();
  const baseline = cached.syncBaseline;
  assert.ok(baseline?.hash, "Downloads retain an encrypted sync baseline across app restarts");
  assert.ok(cached.localPath?.startsWith("syncpeer-document:"));
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!(cached.localPath!), original);
  digestOperations = [];
  assert.deepEqual(await cache.platformAdapter.digestCachedFiles!([{ folderId: cached.folderId, path: cached.path }]),
    [{ folderId: cached.folderId, path: cached.path, hash: baseline.hash }],
    "Automatic refresh hashes the encrypted document, not the old plaintext cache");
  assert.ok(digestOperations.includes("digestCachedFiles"), "The document owner should hash its own bytes");
  assert.equal(digestOperations.includes("read"), false, "Hashing must not stream file ranges through the UI bridge");
  digestOperations = null;
  await documents.detachDownloads("fixture-folder");
  records.push({ key: "fixture-folder:retry.bin", folderId: "fixture-folder", path: "retry.bin", name: "retry.bin",
    localPath: "/synthetic/retry.bin", sizeBytes: 4, cachedAtMs: 11, modifiedMs: 11 });
  failRemoval = true;
  await assert.rejects(cache.connectFolder({ id: "fixture-folder", label: "Fixture", password: "synthetic-folder-password" }), /could not be removed/i);
  assert.equal(records.length, 1, "A failed plaintext deletion keeps the old copy for retry");
  assert.equal((await documents.status()).folders[0].downloads, undefined, "Failed cleanup must not attach encrypted downloads");
  assert.equal((await documents.cachedFiles("fixture-folder")).some(file => file.path === "retry.bin"), true,
    "Encrypted data remains available when cleanup fails");
  failRemoval = false;
  await cache.connectFolder({ id: "fixture-folder", label: "Fixture", password: "synthetic-folder-password" });
  assert.equal(records.length, 0, "A retry removes the verified plaintext copy");
  cached = (await cache.platformAdapter.listCachedFiles!()).find(file => file.path === "sample.bin")!;
  const picker = await documents.open(cached.localPath!.slice("syncpeer-document:".length), "rw");
  await documents.write(picker, 0, Uint8Array.of(9)); await documents.release(picker);
  assert.deepEqual((await cache.platformAdapter.listCachedFiles!())[0].syncBaseline, baseline, "Picker edits must not change the last remote baseline");
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!(cached.localPath!), Uint8Array.of(9, 2, 3, 4));
  assert.deepEqual(await cache.platformAdapter.digestCachedFiles!([{ folderId: cached.folderId, path: cached.path }]),
    [{ folderId: cached.folderId, path: cached.path,
      hash: createHash("sha256").update(Uint8Array.of(9, 2, 3, 4)).digest("hex") }],
    "An external document edit must change the digest used for conflict detection");
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
  const { createTransferRuntime } = await server.ssrLoadModule("/packages/app/src/app/transferRuntime.ts") as {
    createTransferRuntime: (args: {
      state: Parameters<typeof createAppActions>[0]["state"];
      client: Parameters<typeof createAppActions>[0]["client"];
      runtimeSurface: "web-ui";
    }) => TransferRuntime;
  };
  const { createInitialState } = await server.ssrLoadModule("/packages/app/src/app/state.ts") as typeof AppState;
  const state = createInitialState(null), session = createInitialSessionState();
  const sample = (await cache.platformAdapter.listCachedFiles!()).find(file => file.path === "sample.bin")!;
  assert.equal(sample.syncBaseline?.modifiedMs, 30,
    "Completed downloads persist the exact remote version used for later conflict detection");
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
    transfers: createTransferRuntime({
      state,
      client: cache.platformAdapter as Parameters<typeof createAppActions>[0]["client"],
      runtimeSurface: "web-ui",
    }),
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

test("encrypted folders can be migrated back to verified plaintext storage", async t => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null }, appType: "custom" });
  t.after(() => server.close());
  const { openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const documents = createDocumentFilesystem({ profileId: "reverse-fixture", deviceCounterId: "42", openStorage, availableBytes: async () => 1024 * 1024 * 1024,
    profile: await openStorage("profile"), randomBytes, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => secret, save: async value => { secret = value; }, remove: async () => { secret = null; },
    } });
  await documents.initialize();
  await documents.createVault("synthetic-master-password", true);
  const records: Array<CachedFileRecord> = [], localBytes = new Map<string, Uint8Array>();
  let corruptPlaintext = false;
  const legacy = {
    listCachedFiles: async () => records,
    cacheFile: async (folderId: string, path: string, name: string, bytes: Uint8Array) => {
      const existing = records.find(value => value.folderId === folderId && value.path === path);
      const value = { key: `${folderId}:${path}`, folderId, path, name, localPath: `/synthetic/${path}`,
        sizeBytes: bytes.length, cachedAtMs: Date.now() };
      localBytes.set(value.localPath, bytes.slice());
      if (corruptPlaintext) localBytes.get(value.localPath)![0] ^= 1;
      if (existing) Object.assign(existing, value); else records.push(value);
    },
    removeCachedFile: async () => false,
  };
  const cache = createDocumentCache({ enabled: () => true,
    request: async <T>(input: Record<string, unknown>) => await dispatchDocumentCommand(documents, input) as T,
    legacy,
    openLegacySource: async file => ({ size: file.sizeBytes,
      readRange: async (offset, size) => localBytes.get(file.localPath!)!.slice(offset, offset + size),
      verify: async () => {}, close: async () => {} }),
    show: async () => {},
  });
  await cache.connectFolder({ id: "reverse", label: "Reverse", password: "synthetic-password" });
  await cache.platformAdapter.cacheFile!("reverse", "sample.bin", "sample.bin", Uint8Array.of(1, 2, 3));
  const before = await cache.platformAdapter.listCachedFiles!();
  assert.equal(before.length, 1);
  corruptPlaintext = true;
  await assert.rejects(cache.disconnectFolder("reverse"), /verification/i);
  assert.equal((await documents.status()).folders[0].downloads, true, "Failed reverse verification keeps encrypted ownership");
  assert.equal((await documents.cachedFiles("reverse")).length, 1, "Failed reverse verification retains encrypted data");
  corruptPlaintext = false;
  await cache.disconnectFolder("reverse");
  assert.equal((await cache.platformAdapter.listCachedFiles!()).length, 1, "Plain migration retains the verified local file");
  assert.equal((await documents.status()).folders[0].downloads, undefined, "Encrypted ownership is detached only after verification");
  assert.equal((await documents.cachedFiles("reverse")).length, 1,
    "Switching storage owners must not publish a synchronized deletion or silently release the encrypted copy");
  await documents.close();
});

test("encrypted downloads resume verified ranges after a document runtime restart", async () => {
  const { openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const openDocuments = async () => {
    const documents = createDocumentFilesystem({ profileId: "resume-fixture", deviceCounterId: "42", openStorage, availableBytes: async () => 1024 * 1024 * 1024,
      profile: await openStorage("profile"), randomBytes, rememberedSecret: {
        isDeviceUnlocked: async () => true, load: async () => secret,
        save: async value => { secret = value; }, remove: async () => { secret = null; },
      } });
    await documents.initialize();
    if ((await documents.status()).vault.phase === "uninitialized") {
      await documents.createVault("synthetic-master-password", true);
    }
    return documents;
  };
  const openCache = (documents: Awaited<ReturnType<typeof openDocuments>>) => createDocumentCache({ enabled: () => true,
    request: async <T>(input: Record<string, unknown>) => await dispatchDocumentCommand(documents, input) as T,
    legacy: { listCachedFiles: async () => [] },
    openLegacySource: async () => { throw new Error("No legacy files"); }, show: async () => {},
  });
  let documents = await openDocuments(), cache = openCache(documents);
  await cache.connectFolder({ id: "resume", label: "Resume", password: "synthetic-password" });
  const metadata = { sourceDeviceId: "synthetic-peer", folderId: "resume", path: "partial.bin",
    sizeBytes: 6, encrypted: false, contentId: "blocks:synthetic-content" };
  const first = await cache.platformAdapter.createFileDownloadSink!({ folderId: "resume", path: "partial.bin",
    name: "partial.bin", modifiedMs: 1000 });
  await first.begin(metadata);
  await first.write(0, Uint8Array.of(1, 2, 3));
  await first.suspend!();
  await documents.close();

  documents = await openDocuments(); cache = openCache(documents);
  const resumed = await cache.platformAdapter.createFileDownloadSink!({ folderId: "resume", path: "partial.bin",
    name: "partial.bin", modifiedMs: 1000 });
  await resumed.begin(metadata);
  assert.equal(resumed.hasRange!(0, 3), true, "Restarted encrypted storage exposes its durable completed range");
  assert.equal((await resumed.digestPartialRanges!([{ offset: 0, size: 3 }])).length, 1);
  await resumed.write(3, Uint8Array.of(4, 5, 6));
  await resumed.commit();
  const [stored] = await cache.platformAdapter.listCachedFiles!();
  assert.deepEqual(await cache.platformAdapter.readBinaryFile!(stored.localPath!), Uint8Array.of(1, 2, 3, 4, 5, 6));

  const stale = await cache.platformAdapter.createFileDownloadSink!({ folderId: "resume", path: "changed.bin",
    name: "changed.bin", modifiedMs: 2000 });
  await stale.begin({ ...metadata, path: "changed.bin", contentId: "blocks:old" });
  await stale.write(0, Uint8Array.of(7, 8, 9));
  await stale.suspend!();
  await documents.close();
  documents = await openDocuments(); cache = openCache(documents);
  const changed = await cache.platformAdapter.createFileDownloadSink!({ folderId: "resume", path: "changed.bin",
    name: "changed.bin", modifiedMs: 2000 });
  await changed.begin({ ...metadata, path: "changed.bin", contentId: "blocks:new" });
  assert.equal(changed.hasRange!(0, 3), false, "Changed remote content never reuses stale encrypted bytes");
  await changed.abort(new Error("Synthetic cleanup"));
  await documents.close();
});
