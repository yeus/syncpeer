import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createDocumentFilesystem } from "../packages/core/src/sync/documentFilesystem.ts";
import { encodeDocumentId, decodeDocumentId } from "../packages/core/src/sync/documentId.ts";
import { syncServiceFileFavorites, createFavoriteSyncMemo } from "../packages/core/src/sync/serviceFavoriteSync.ts";
import { createServiceTransferScheduler } from "../packages/core/src/sync/serviceTransferScheduler.ts";
import type { FileEntry, RemoteFs } from "../packages/core/src/core/model/remoteFs.ts";
import { memoryDocumentStorage } from "./lan-test/replica-storage.ts";

const encoder = new TextEncoder();

function fakeRemote(files: Map<string, { bytes: Uint8Array; modifiedMs: number }>, options: {
  indexReceived?: boolean;
  failUploads?: boolean;
  failDeletes?: boolean;
} = {}) {
  const tombstones = new Set<string>();
  const requests = { uploads: [] as Array<{ path: string; bytes: Uint8Array }>, deletions: [] as string[],
    uploadReads: [] as number[] };
  const children = (parent: string) => {
    const prefix = parent ? parent + "/" : "";
    const directories = new Set<string>(), entries: FileEntry[] = [];
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) entries.push({ name: rest, path, type: "file", size: file.bytes.length, modifiedMs: file.modifiedMs });
      else directories.add(rest.slice(0, slash));
    }
    return [...directories].map(name => ({ name, path: prefix + name, type: "directory" as const,
      size: 0, modifiedMs: 0 })).concat(entries);
  };
  const remote = {
    listFolders: async () => [{ id: "folder", label: "Folder", readOnly: false, stats: undefined }],
    getRemoteDeviceInfo: () => ({ id: "synthetic-peer", deviceName: "Synthetic", clientName: "test", clientVersion: "0" }),
    getFolderSyncState: async (folderId: string) => ({ folderId, remoteIndexId: "1", remoteMaxSequence: "1",
      indexReceived: options.indexReceived ?? true }),
    waitForFolderIndex: async () => options.indexReceived ?? true,
    indexedFile: async (_folderId: string, path: string): Promise<FileEntry | null> => {
      if (options.indexReceived === false) return null;
      if (tombstones.has(path)) return { path, name: path.split("/").at(-1)!, type: "file", size: 0, modifiedMs: 10, deleted: true };
      return children(path.split("/").slice(0, -1).join("/")).find(entry => entry.path === path) ?? null;
    },
    readDir: async (_folderId: string, parent: string): Promise<FileEntry[]> => children(parent),
    readFileToSink: async (folderId: string, path: string, sink: {
      begin: (metadata: { folderId: string; path: string; sizeBytes: number; encrypted: boolean; contentId?: string }) => Promise<void>;
      write: (offset: number, bytes: Uint8Array) => Promise<void>;
      commit: () => Promise<void>;
    }, onProgress?: (progress: { downloadedBytes: number; totalBytes: number }) => void) => {
      const file = files.get(path);
      if (!file) throw new Error(`Remote file is missing: ${path}`);
      await sink.begin({ folderId, path, sizeBytes: file.bytes.length, encrypted: false, contentId: "test" });
      await sink.write(0, file.bytes);
      onProgress?.({ downloadedBytes: file.bytes.length, totalBytes: file.bytes.length });
      await sink.commit();
      return { bytesWritten: file.bytes.length, totalBytes: file.bytes.length };
    },
    writeFileFully: async (_folderId: string, path: string, bytes: Uint8Array, uploadOptions?: { modifiedMs?: number }) => {
      if (options.failUploads) throw new Error("Synthetic upload failure.");
      requests.uploads.push({ path, bytes: bytes.slice() });
      files.set(path, { bytes: bytes.slice(), modifiedMs: uploadOptions?.modifiedMs ?? Date.now() });
    },
    writeFileStream: async (_folderId: string, path: string, source: { size: number; read: (offset: number, size: number) => Promise<Uint8Array> },
      uploadOptions?: { modifiedMs?: number; onProgress?: (progress: {
        processedBytes: number; totalBytes: number; elapsedMs: number; phase: "preparing" | "publishing" }) => void }) => {
      if (options.failUploads) throw new Error("Synthetic upload failure.");
      const bytes = new Uint8Array(source.size);
      for (let offset = 0; offset < source.size; offset += 131072) {
        const chunk = await source.read(offset, Math.min(131072, source.size - offset));
        requests.uploadReads.push(chunk.length);
        bytes.set(chunk, offset);
        uploadOptions?.onProgress?.({ processedBytes: Math.min(offset + chunk.length, source.size),
          totalBytes: source.size, elapsedMs: 0, phase: "preparing" });
      }
      requests.uploads.push({ path, bytes });
      files.set(path, { bytes: bytes.slice(), modifiedMs: uploadOptions?.modifiedMs ?? Date.now() });
    },
    deleteFile: async (_folderId: string, path: string) => {
      if (options.failDeletes) throw new Error("Synthetic delete failure.");
      requests.deletions.push(path); files.delete(path);
    },
  };
  return { remote, requests, files, tombstones };
}

async function createFixture(favorites: Array<{ path: string; name: string; kind: "file" | "folder" }> = [
  { path: "notes.txt", name: "notes.txt", kind: "file" },
]) {
  const { openStorage } = memoryDocumentStorage();
  let remembered: string | null = null;
  const options = { profileId: "favorite-fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024,
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => remembered,
      save: async (value: string) => { remembered = value; }, remove: async () => { remembered = null; } } };
  const documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.createVault("synthetic-master-password", true);
  await documents.register({ id: "folder", label: "Folder", password: "synthetic-folder-password" });
  await documents.attachDownloads("folder");
  const settings = await documents.profileSettings();
  settings.folders.folder = { exclusions: [], ignorePatterns: [], paused: false,
    favorites: favorites.map(favorite => ({ key: `${favorite.kind}:folder:${favorite.path}`,
      folderId: "folder", ...favorite })) };
  await documents.saveProfileSettings(settings);
  return { documents, options, openStorage, folderId: decodeDocumentId((await documents.list("syncpeer-root"))[0].id).folderId };
}

async function cacheRemoteFile(documents: Awaited<ReturnType<typeof createFixture>>["documents"],
  path: string, bytes: Uint8Array, modifiedMs: number) {
  const handle = await documents.beginDownload("folder", path, bytes.length, modifiedMs);
  await documents.write(handle, 0, bytes);
  await documents.finishDownload(handle);
}

const favoriteState = async (documents: Awaited<ReturnType<typeof createFixture>>["documents"]) =>
  (await documents.favoriteSyncState("folder")).entries["notes.txt"];

test("skips favorite sync for a folder owned by live replica sync", async () => {
  const { documents } = await createFixture();
  const { remote } = fakeRemote(new Map([["notes.txt", {
    bytes: encoder.encode("from peer"), modifiedMs: 10,
  }]]));
  remote.readDir = async () => { throw new Error("Excluded folder was read."); };

  const result = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, {
    nowMs: 1000,
    excludeFolderIds: ["folder"],
  });

  assert.deepEqual(result, { results: [] });
  await documents.close();
});

test("downloads a newly selected favorite and persists its baseline", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "downloaded" }]);
  const id = encodeDocumentId(folderId, "notes.txt");
  const reader = await documents.open(id, "r");
  assert.deepEqual(await documents.read(reader, 0, content.length), content);
  await documents.release(reader);
  assert.deepEqual((await documents.syncBaseline(id))?.hash.length, 64);
  assert.equal((await favoriteState(documents))?.phase, "synced");
  await documents.close();
});

test("unchanged favorites reuse their verified version but changed files are hashed", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("original");
  const { remote, requests } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  const run = () => syncServiceFileFavorites(documents, remote as unknown as RemoteFs);
  try {
    await run();
    let reads = 0;
    const originalRead = documents.read;
    documents.read = async (...args) => { reads++; return originalRead(...args); };
    assert.equal((await run()).results[0].result, "unchanged");
    assert.equal(reads, 0, "Unchanged verified file should not be streamed again");
    const id = encodeDocumentId(folderId, "notes.txt");
    const writer = await documents.open(id, "rwt");
    await documents.write(writer, 0, encoder.encode("modified"));
    await documents.release(writer);
    assert.equal((await run()).results[0].result, "uploaded");
    assert.ok(reads > 0, "A new local revision requires real content verification");
    assert.deepEqual(requests.uploads[0].bytes, encoder.encode("modified"));
  } finally { await documents.close(); }
});


test("incremental clean folder skips scans until remote revision, local mutation or audit deadline", async () => {
  const { documents, folderId } = await createFixture();
  const { remote, requests } = fakeRemote(new Map([["notes.txt", { bytes: encoder.encode("original"), modifiedMs: 10 }]]));
  let revision = 1, scans = 0, nowMs = 1000;
  const fs = Object.assign(remote, { folderSyncRevision: () => revision }) as unknown as RemoteFs;
  const memo = createFavoriteSyncMemo();
  const original = documents.cachedFiles;
  documents.cachedFiles = async (...args) => { scans++; return original(...args); };
  const run = () => syncServiceFileFavorites(documents, fs, { memo, nowMs: nowMs++ });
  try {
    await run(); await run();
    const before = scans;
    await run();
    assert.equal(scans, before, "stable folder does not rescan");
    revision++;
    await run();
    assert.equal(scans, before + 1);
    const id = encodeDocumentId(folderId, "notes.txt");
    const writer = await documents.open(id, "rwt");
    await documents.write(writer, 0, encoder.encode("edited"));
    await documents.release(writer);
    await run();
    assert.deepEqual(requests.uploads.at(-1)?.bytes, encoder.encode("edited"));
    await run(); await run();
    const cleanScans = scans;
    nowMs += 120_001;
    await run();
    assert.ok(scans > cleanScans, "periodic full audit remains enabled");
  } finally { await documents.close(); }
});

test("interactive folder read bypasses the background queue and latches a yield", async () => {
  const scheduler = createServiceTransferScheduler();
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = scheduler.runFavorite(async shouldYield => {
    started(); await gate; return shouldYield();
  });
  await ready;
  assert.equal(await scheduler.runInteractive(async () => "listing"), "listing");
  release();
  assert.equal(await work, true);
  assert.equal(await scheduler.runFavorite(async shouldYield => shouldYield()), false);
});

test("manual transfer runs between favorite transactions and the next pass replans", async () => {
  const { documents, folderId } = await createFixture([{ path: "", name: "Folder", kind: "folder" }]);
  const { remote, files } = fakeRemote(new Map([
    ["a.txt", { bytes: encoder.encode("first"), modifiedMs: 10 }],
    ["b.txt", { bytes: encoder.encode("old"), modifiedMs: 11 }],
  ]));
  const scheduler = createServiceTransferScheduler();
  const events: string[] = [];
  const download = remote.readFileToSink;
  let entered!: () => void, resume!: () => void;
  const enteredFirst = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  remote.readFileToSink = async (...args) => {
    events.push(args[1]);
    if (args[1] === "a.txt") { entered(); await gate; }
    return download(...args);
  };
  const run = () => scheduler.runFavorite(shouldYield =>
    syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { shouldYield }));
  try {
    const favorites = run();
    await enteredFirst;
    const manual = scheduler.runManual(async () => {
      events.push("manual");
      const updated = { bytes: encoder.encode("new manual copy"), modifiedMs: 12 };
      files.set("b.txt", updated);
      await cacheRemoteFile(documents, "b.txt", updated.bytes, updated.modifiedMs);
    });
    const queuedFavorite = run();
    resume();
    const result = await favorites;
    assert.equal(result.yielded, true);
    assert.deepEqual(result.results.map(item => item.result), ["downloaded", "waiting"]);
    await manual;
    await queuedFavorite;
    await run();
    assert.deepEqual(events, ["a.txt", "manual"]);
    const handle = await documents.open(encodeDocumentId(folderId, "b.txt"), "r");
    assert.equal(new TextDecoder().decode(await documents.read(handle, 0, await documents.size(handle))), "new manual copy");
    await documents.release(handle);
    // Rejection must not poison the scheduler or leave a manual count stuck.
    await assert.rejects(scheduler.runManual(async () => { throw new Error("cancelled"); }), /cancelled/);
    assert.equal(await scheduler.runFavorite(async shouldYield => shouldYield()), false);
  } finally { resume(); await documents.close(); }
});

test("uploads an offline favorite edit and advances the baseline", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer"), edited = encoder.encode("offline edit");
  const { remote, requests } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = encodeDocumentId(folderId, "notes.txt");
  const writer = await documents.open(id, "rw");
  await documents.write(writer, 0, edited);
  await documents.release(writer);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "uploaded" }]);
  assert.deepEqual(requests.uploads, [{ path: "notes.txt", bytes: edited }]);
  const baseline = await documents.syncBaseline(id);
  assert.equal(baseline?.sizeBytes, edited.length);
  assert.equal(baseline?.modifiedMs, 1000);
  await documents.close();
});

test("streams a favorite larger than the retired service buffer cap", { timeout: 120000 }, async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const size = 33 * 1024 * 1024 + 7;
  const { remote, requests } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = encodeDocumentId(folderId, "notes.txt");
  const writer = await documents.open(id, "rw");
  const edited = new Uint8Array(size).fill(4);
  for (let offset = 0; offset < size; offset += 131072) {
    await documents.write(writer, offset, edited.subarray(offset, Math.min(size, offset + 131072)));
  }
  await documents.release(writer);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "uploaded" }]);
  assert.equal(requests.uploads.length, 1);
  assert.equal(requests.uploads[0].bytes.length, size);
  assert.ok(requests.uploadReads.every(read => read <= 131072), "Upload reads stay block-bounded");
  assert.equal((await documents.syncBaseline(id))?.sizeBytes, size);
  await documents.close();
});

test("propagates a local favorite deletion to the peer and clears its baseline", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = encodeDocumentId(folderId, "notes.txt");
  await documents.remove(id);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(requests.deletions, ["notes.txt"]);
  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "deleted" }]);
  assert.equal(await documents.syncBaseline(id), undefined);
  await documents.close();
});

test("removes the local copy when the peer deleted an unchanged favorite", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files, tombstones } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  requests.deletions.length = 0;
  files.delete("notes.txt");
  tombstones.add("notes.txt");

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(requests.deletions, []);
  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "deleted-local" }]);
  await assert.rejects(documents.stat(encodeDocumentId(folderId, "notes.txt")), /unavailable/i);
  assert.equal(await documents.syncBaseline(encodeDocumentId(folderId, "notes.txt")), undefined);
  await documents.close();
});

test("preserves a locally edited favorite when the peer deleted its copy", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files, tombstones } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  files.delete("notes.txt");
  tombstones.add("notes.txt");
  const id = encodeDocumentId(folderId, "notes.txt");
  const writer = await documents.open(id, "rw");
  await documents.write(writer, 0, encoder.encode("edited locally"));
  await documents.release(writer);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(requests.deletions, []);
  assert.equal(results[0].result, "conflict");
  const reader = await documents.open(id, "r");
  assert.deepEqual(await documents.read(reader, 0, 14), encoder.encode("edited locally"));
  await documents.release(reader);
  assert.equal((await favoriteState(documents))?.phase, "conflict");
  await documents.close();
});

test("preserves the peer copy when the local favorite was deleted and the peer changed", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  await documents.remove(encodeDocumentId(folderId, "notes.txt"));
  files.set("notes.txt", { bytes: encoder.encode("peer changed"), modifiedMs: 20 });

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(requests.deletions, []);
  assert.equal(results[0].result, "conflict");
  assert.ok(await documents.syncBaseline(encodeDocumentId(folderId, "notes.txt")),
    "A conflict keeps the verified baseline for later resolution");
  await documents.close();
});

test("a same-size peer edit with an unchanged timestamp survives a local deletion", async () => {
  const { documents, folderId } = await createFixture();
  const original = encoder.encode("original"), changed = encoder.encode("modified");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: original, modifiedMs: 10 }]]));
  try {
    await cacheRemoteFile(documents, "notes.txt", original, 10);
    await documents.remove(encodeDocumentId(folderId, "notes.txt"));
    files.set("notes.txt", { bytes: changed, modifiedMs: 10 });
    const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs);
    assert.equal(results[0].result, "conflict");
    assert.deepEqual(requests.deletions, []);
    assert.deepEqual(files.get("notes.txt")?.bytes, changed);
  } finally { await documents.close(); }
});

test("a missing rename target never authorizes deletion of the peer original", async () => {
  const { documents, folderId } = await createFixture();
  const original = encoder.encode("original");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: original, modifiedMs: 10 }]]));
  try {
    await cacheRemoteFile(documents, "notes.txt", original, 10);
    await documents.rename(encodeDocumentId(folderId, "notes.txt"), "renamed.txt");
    await documents.remove(encodeDocumentId(folderId, "renamed.txt"));
    const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs);
    assert.equal(results[0].result, "conflict");
    assert.deepEqual(requests.deletions, []);
    assert.deepEqual(files.get("notes.txt")?.bytes, original);
    assert.equal((await documents.favoriteSyncState("folder")).renames.length, 1);
  } finally { await documents.close(); }
});

test("a same-size peer edit with an unchanged timestamp survives a local rename", async () => {
  const { documents, folderId } = await createFixture();
  const original = encoder.encode("original"), changed = encoder.encode("modified");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: original, modifiedMs: 10 }]]));
  try {
    await cacheRemoteFile(documents, "notes.txt", original, 10);
    await documents.rename(encodeDocumentId(folderId, "notes.txt"), "renamed.txt");
    files.set("notes.txt", { bytes: changed, modifiedMs: 10 });
    const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs);
    assert.equal(results[0].result, "conflict");
    assert.deepEqual(requests.deletions, []);
    assert.deepEqual(files.get("notes.txt")?.bytes, changed);
  } finally { await documents.close(); }
});

test("publishes a renamed favorite and removes the old peer path", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  await documents.rename(encodeDocumentId(folderId, "notes.txt"), "renamed.txt");

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [
    { folderId: "folder", path: "notes.txt", result: "renamed" },
    { folderId: "folder", path: "renamed.txt", result: "unchanged" },
  ]);
  assert.equal(requests.uploads.length, 1);
  assert.equal(requests.uploads[0].path, "renamed.txt");
  assert.deepEqual(requests.uploads[0].bytes, content);
  assert.deepEqual(requests.deletions, ["notes.txt"]);
  assert.equal(files.has("notes.txt"), false);
  assert.ok(await documents.syncBaseline(encodeDocumentId(folderId, "renamed.txt")));
  const favorites = (await documents.profileSettings()).folders.folder.favorites;
  assert.equal(favorites[0].path, "renamed.txt");
  assert.equal(favorites[0].key, "file:folder:renamed.txt");
  assert.equal((await documents.favoriteSyncState("folder")).renames.length, 0);
  await documents.close();
});

test("resumes a rename that was interrupted after publishing the new name", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const first = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]), { failDeletes: true });
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  await documents.rename(encodeDocumentId(folderId, "notes.txt"), "renamed.txt");

  const failed = await syncServiceFileFavorites(documents, first.remote as unknown as RemoteFs, { nowMs: 1000 });
  assert.equal(failed.results[0].result, "error");
  assert.equal(first.files.has("renamed.txt"), true, "The new name was published before the failure");
  assert.equal(first.files.has("notes.txt"), true);

  const retry = fakeRemote(first.files, {});
  const recovered = await syncServiceFileFavorites(documents, retry.remote as unknown as RemoteFs, { nowMs: 20000 });
  assert.deepEqual(recovered.results, [
    { folderId: "folder", path: "notes.txt", result: "renamed" },
    { folderId: "folder", path: "renamed.txt", result: "unchanged" },
  ]);
  assert.deepEqual(retry.requests.deletions, ["notes.txt"]);
  assert.equal(retry.files.has("notes.txt"), false);
  assert.equal((await documents.profileSettings()).folders.folder.favorites[0].path, "renamed.txt");
  await documents.close();
});

test("keeps retry state across a service restart and backs off a failed favorite", async () => {
  const { documents, options, openStorage, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const first = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]), { failUploads: true });
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = encodeDocumentId(folderId, "notes.txt");
  const writer = await documents.open(id, "rw");
  await documents.write(writer, 0, encoder.encode("edited locally"));
  await documents.release(writer);

  const failed = await syncServiceFileFavorites(documents, first.remote as unknown as RemoteFs, { nowMs: 1000 });
  assert.equal(failed.results[0].result, "error");
  const failedEntry = (await documents.favoriteSyncState("folder")).entries["notes.txt"];
  assert.equal(failedEntry.phase, "error");
  assert.equal(failedEntry.attempts, 1);
  assert.ok(failedEntry.nextAttemptMs > 1000);
  await documents.close();

  const restarted = createDocumentFilesystem({ ...options, profile: await openStorage("profile") });
  assert.equal((await restarted.initialize()).vault.phase, "unlocked");
  const persisted = (await restarted.favoriteSyncState("folder")).entries["notes.txt"];
  assert.equal(persisted.phase, "error");
  assert.equal(persisted.attempts, 1);
  assert.equal(persisted.nextAttemptMs > 1000, true);
  const skipped = await syncServiceFileFavorites(restarted, first.remote as unknown as RemoteFs, { nowMs: 1001 });
  assert.equal(skipped.results[0].result, "error");
  assert.equal(first.requests.uploads.length, 0, "A backed-off favorite is not retried before its deadline");
  await restarted.close();
});

test("waits for the folder index instead of deleting local favorites", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests } = fakeRemote(new Map(), { indexReceived: false });
  await cacheRemoteFile(documents, "notes.txt", content, 10);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "waiting",
    message: "Folder index is still being received." }]);
  assert.deepEqual(requests.deletions, []);
  const reader = await documents.open(encodeDocumentId(folderId, "notes.txt"), "r");
  assert.equal((await documents.read(reader, 0, 9)).length, 9);
  await documents.release(reader);
  await documents.close();
});

test("a partial peer listing never deletes or redownloads an unchanged favorite", async () => {
  const { documents, folderId } = await createFixture();
  const bytes = encoder.encode("from peer");
  const { remote, files, tombstones, requests } = fakeRemote(new Map([["notes.txt", { bytes, modifiedMs: 10 }]]));
  const run = () => syncServiceFileFavorites(documents, remote as unknown as RemoteFs);
  try {
    await run();
    const id = encodeDocumentId(folderId, "notes.txt");
    files.delete("notes.txt");
    assert.equal((await run()).results[0].result, "waiting");
    files.set("notes.txt", { bytes, modifiedMs: 10 });
    assert.equal((await run()).results[0].result, "unchanged");
    const reader = await documents.open(id, "r");
    files.delete("notes.txt");
    tombstones.add("notes.txt");
    assert.equal((await run()).results[0].result, "waiting");
    assert.deepEqual(await documents.read(reader, 0, bytes.length), bytes);
    await documents.release(reader);
    assert.equal((await run()).results[0].result, "deleted-local");
    assert.deepEqual(requests.deletions, []);
  } finally { await documents.close(); }
});

test("an unrecorded local disappearance restores the cache instead of deleting the peer", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  const id = encodeDocumentId(folderId, "notes.txt");
  try {
    await cacheRemoteFile(documents, "notes.txt", content, 10);
    const baseline = (await documents.syncBaseline(id))!;
    await documents.remove(id);
    assert.equal((await documents.syncBaseline(id))?.localDeletion, true);
    // Simulate a disappeared cache entry with an old baseline but no delete intent.
    await documents.setSyncBaseline(id, baseline);
    const result = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs);
    assert.equal(result.results[0].result, "downloaded");
    assert.deepEqual(requests.deletions, []);
  } finally { await documents.close(); }
});


test("downloads only the selected descendants of a directory favorite", async () => {
  const { documents, folderId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const keep = encoder.encode("keep"), nested = encoder.encode("nested");
  const { remote } = fakeRemote(new Map([
    ["docs/keep.txt", { bytes: keep, modifiedMs: 10 }],
    ["docs/sub/nested.txt", { bytes: nested, modifiedMs: 11 }],
    ["docs/skip.log", { bytes: encoder.encode("skip"), modifiedMs: 12 }],
    ["other.txt", { bytes: encoder.encode("other"), modifiedMs: 13 }],
  ]));
  const settings = await documents.profileSettings();
  settings.folders.folder.ignorePatterns = ["*.log"];
  await documents.saveProfileSettings(settings);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results.map(result => [result.path, result.result]), [
    ["docs/keep.txt", "downloaded"],
    ["docs/sub/nested.txt", "downloaded"],
  ]);
  const reader = await documents.open(encodeDocumentId(folderId, "docs/sub/nested.txt"), "r");
  assert.deepEqual(await documents.read(reader, 0, nested.length), nested);
  await documents.release(reader);
  await assert.rejects(documents.stat(encodeDocumentId(folderId, "docs/skip.log")), /unavailable/i);
  await assert.rejects(documents.stat(encodeDocumentId(folderId, "other.txt")), /unavailable/i);
  await documents.close();
});

test("uploads an offline edit inside a directory favorite", async () => {
  const { documents, folderId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const original = encoder.encode("from peer"), edited = encoder.encode("edited offline");
  const { remote, requests } = fakeRemote(new Map([["docs/keep.txt", { bytes: original, modifiedMs: 10 }]]));

  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  const id = encodeDocumentId(folderId, "docs/keep.txt");
  const writer = await documents.open(id, "rw");
  await documents.write(writer, 0, edited);
  await documents.release(writer);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 2000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "docs/keep.txt", result: "uploaded" }]);
  assert.deepEqual(requests.uploads, [{ path: "docs/keep.txt", bytes: edited }]);
  await documents.close();
});

test("propagates a peer deletion inside a directory favorite and keeps local edits", async () => {
  const { documents, folderId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const content = encoder.encode("from peer");
  const { remote, files, tombstones } = fakeRemote(new Map([
    ["docs/gone.txt", { bytes: content, modifiedMs: 10 }],
    ["docs/edited.txt", { bytes: content, modifiedMs: 10 }],
  ]));
  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  files.delete("docs/gone.txt");
  files.delete("docs/edited.txt");
  tombstones.add("docs/gone.txt");
  tombstones.add("docs/edited.txt");
  const editedId = encodeDocumentId(folderId, "docs/edited.txt");
  const writer = await documents.open(editedId, "rw");
  await documents.write(writer, 0, encoder.encode("local edit"));
  await documents.release(writer);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 2000 });

  assert.deepEqual(results.map(result => [result.path, result.result]).sort(), [
    ["docs/edited.txt", "conflict"],
    ["docs/gone.txt", "deleted-local"],
  ]);
  await assert.rejects(documents.stat(encodeDocumentId(folderId, "docs/gone.txt")), /unavailable/i);
  const reader = await documents.open(editedId, "r");
  assert.deepEqual(await documents.read(reader, 0, 10), encoder.encode("local edit"));
  await documents.release(reader);
  await documents.close();
});

test("renames a directory favorite by publishing descendants and tombstoning old names", async () => {
  const { documents, folderId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const first = encoder.encode("first"), second = encoder.encode("second");
  const { remote, requests, files } = fakeRemote(new Map([
    ["docs/a.txt", { bytes: first, modifiedMs: 10 }],
    ["docs/sub/b.txt", { bytes: second, modifiedMs: 11 }],
  ]));
  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  await documents.rename(encodeDocumentId(folderId, "docs"), "notes");

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 2000 });

  assert.deepEqual(results.filter(result => result.result === "renamed").map(result => result.path).sort(),
    ["docs/a.txt", "docs/sub/b.txt"]);
  assert.deepEqual(requests.uploads.map(upload => upload.path).sort(), ["notes/a.txt", "notes/sub/b.txt"]);
  assert.deepEqual(requests.deletions.sort(), ["docs/a.txt", "docs/sub/b.txt"]);
  assert.equal(files.has("docs/a.txt"), false);
  assert.equal(files.has("notes/a.txt"), true);
  const favorites = (await documents.profileSettings()).folders.folder.favorites;
  assert.deepEqual(favorites.map(favorite => favorite.path), ["notes"]);
  assert.equal((await documents.favoriteSyncState("folder")).renames.length, 0);
  await documents.close();
});

test("keeps a local-only file in a directory favorite instead of deleting it", async () => {
  const { documents, folderId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const content = encoder.encode("from peer");
  const { remote, requests } = fakeRemote(new Map([["docs/keep.txt", { bytes: content, modifiedMs: 10 }]]));
  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  const created = await documents.create(encodeDocumentId(folderId, "docs"), "offline.txt", false);
  const writer = await documents.open(created.id, "rw");
  await documents.write(writer, 0, encoder.encode("local"));
  await documents.release(writer);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 2000 });

  assert.deepEqual(results, [
    { folderId: "folder", path: "docs/keep.txt", result: "unchanged" },
    { folderId: "folder", path: "docs/offline.txt", result: "uploaded" },
  ]);
  assert.deepEqual(requests.uploads, [{ path: "docs/offline.txt", bytes: encoder.encode("local") }]);
  await documents.close();
});

test("publishes Save As outside favorites without downloading unrelated peer files", async () => {
  const { documents, folderId } = await createFixture([]);
  const { remote, requests, files } = fakeRemote(new Map([["remote-only.txt", { bytes: encoder.encode("peer"), modifiedMs: 10 }]]));
  const created = await documents.create(encodeDocumentId(folderId, ""), "saved.txt", false);
  const writer = await documents.open(created.id, "rw");
  await documents.write(writer, 0, encoder.encode("new file"));
  const pending = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  assert.equal(pending.results[0]?.result, "waiting");
  assert.equal(requests.uploads.length, 0);
  await documents.release(writer);
  const published = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 2000 });
  assert.equal(published.results[0]?.result, "uploaded");
  assert.deepEqual(files.get("saved.txt")?.bytes, encoder.encode("new file"));
  assert.deepEqual((await documents.cachedFiles("folder")).map(file => file.path), ["saved.txt"]);
  const next = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 3000 });
  assert.deepEqual(next.results, []);
  assert.equal(requests.uploads.length, 1);
  await documents.close();
});

test("uploads an edited nonfavorite download but never overwrites a changed peer", async () => {
  const { documents, folderId } = await createFixture([]);
  const original = encoder.encode("original");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: original, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", original, 10);
  const id = encodeDocumentId(folderId, "notes.txt");
  const edit = async (value: string) => {
    const writer = await documents.open(id, "rwt");
    await documents.write(writer, 0, encoder.encode(value));
    await documents.release(writer);
  };
  await edit("new text");
  assert.equal((await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 })).results[0]?.result, "uploaded");
  await edit("my edit");
  files.set("notes.txt", { bytes: encoder.encode("peeredit"), modifiedMs: 1000 });
  assert.equal((await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 2000 })).results[0]?.result, "conflict");
  assert.equal(requests.uploads.length, 1);
  assert.deepEqual(files.get("notes.txt")?.bytes, encoder.encode("peeredit"));
  await documents.close();
});

test("saves an offline directory snapshot for each visited favorite directory", async () => {
  const { documents } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const { remote } = fakeRemote(new Map([
    ["docs/keep.txt", { bytes: encoder.encode("keep"), modifiedMs: 10 }],
    ["docs/sub/nested.txt", { bytes: encoder.encode("nested"), modifiedMs: 11 }],
  ]));

  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  const root = await documents.loadDirectorySnapshot("folder", "synthetic-peer", "docs");
  assert.deepEqual(root?.entries.map(entry => entry.path).sort(), ["docs/keep.txt", "docs/sub"]);
  const nested = await documents.loadDirectorySnapshot("folder", "synthetic-peer", "docs/sub");
  assert.deepEqual(nested?.entries.map(entry => entry.path), ["docs/sub/nested.txt"]);
  await documents.close();
});

test("favorite upload preserves a same-size peer edit with an unchanged timestamp", async () => {
  const { documents, folderId } = await createFixture();
  const original = encoder.encode("original");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: original, modifiedMs: 10 }]]));
  try {
    await cacheRemoteFile(documents, "notes.txt", original, 10);
    const id = encodeDocumentId(folderId, "notes.txt");
    const writer = await documents.open(id, "rwt");
    await documents.write(writer, 0, encoder.encode("local123"));
    await documents.release(writer);
    files.set("notes.txt", { bytes: encoder.encode("peeredit"), modifiedMs: 10 });
    const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs);
    assert.equal(results[0]?.result, "conflict");
    assert.equal(requests.uploads.length, 0);
    assert.deepEqual(files.get("notes.txt")?.bytes, encoder.encode("peeredit"));
    assert.equal((await favoriteState(documents))?.phase, "conflict");
  } finally { await documents.close(); }
});

test("applies a recorded keep-local resolution by publishing the local copy", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = encodeDocumentId(folderId, "notes.txt");
  const writer = await documents.open(id, "rw");
  await documents.write(writer, 0, encoder.encode("local choice"));
  await documents.release(writer);
  files.set("notes.txt", { bytes: encoder.encode("peer choice"), modifiedMs: 20 });
  const conflicted = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  assert.equal(conflicted.results[0].result, "conflict");
  await documents.recordFavoriteResolution("folder", "notes.txt", "keep-local");

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "uploaded" }]);
  assert.deepEqual(requests.uploads.at(-1), { path: "notes.txt", bytes: encoder.encode("local choice") });
  assert.equal((await documents.favoriteSyncState("folder")).entries["notes.txt"]?.resolution, undefined);
  await documents.close();
});

test("applies a recorded keep-remote resolution by replacing the local copy", async () => {
  const { documents, folderId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = encodeDocumentId(folderId, "notes.txt");
  const writer = await documents.open(id, "rw");
  await documents.write(writer, 0, encoder.encode("local choice"));
  await documents.release(writer);
  files.set("notes.txt", { bytes: encoder.encode("peer choice"), modifiedMs: 20 });
  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  await documents.recordFavoriteResolution("folder", "notes.txt", "keep-remote");

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "downloaded" }]);
  const reader = await documents.open(id, "r");
  assert.deepEqual(await documents.read(reader, 0, 11), encoder.encode("peer choice"));
  await documents.release(reader);
  assert.equal((await documents.favoriteSyncState("folder")).entries["notes.txt"]?.resolution, undefined);
  await documents.close();
});

test("redacted favorite-sync progress includes stages but never filenames or folder identities", async () => {
  const { documents } = await createFixture();
  const { remote } = fakeRemote(new Map([["notes.txt", {
    bytes: encoder.encode("fixture"), modifiedMs: 10,
  }]]));
  const progress: unknown[] = [];
  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs,
    { nowMs: 1000, onProgress: item => progress.push(item) });
  assert.equal(results[0]?.result, "downloaded");
  assert.ok(progress.some(item => (item as { stage: string }).stage === "download"));
  assert.ok(progress.some(item => (item as { stage: string }).stage === "complete"));
  assert.ok(!JSON.stringify(progress).includes("notes.txt"));
  assert.ok(progress.every(item => !Object.keys(item as object).some(key => key === "folderId" || key === "path")));
  assert.ok(progress.some(item => (item as { transferredBytes?: number }).transferredBytes === 7));
  assert.ok(progress.some(item => (item as { totalBytes?: number }).totalBytes === 7));
  await documents.close();
});

test("an unexpected favorite folder failure becomes a result, not a rejected sync run", async () => {
  const { documents } = await createFixture();
  const { remote } = fakeRemote(new Map([["notes.txt", {
    bytes: encoder.encode("fixture"), modifiedMs: 10,
  }]]));
  remote.getFolderSyncState = async () => { throw new Error("Synthetic metadata transport failure"); };
  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs,
    { nowMs: 1000, onProgress: () => { throw new Error("Telemetry callback failed"); } });
  assert.equal(results.length, 1);
  assert.equal(results[0].result, "unavailable");
  await documents.close();
});
test("a timed-out favorite folder does not prevent another folder downloading", async () => {
  const { documents } = await createFixture();
  await documents.register({ id: "other", label: "Other", password: "synthetic-folder-password" });
  await documents.attachDownloads("other");
  const settings = await documents.profileSettings();
  settings.folders.other = { exclusions: [], ignorePatterns: [], paused: false,
    favorites: [{ key: "file:other:notes.txt", folderId: "other", kind: "file",
      path: "notes.txt", name: "notes.txt" }] };
  await documents.saveProfileSettings(settings);
  const { remote } = fakeRemote(new Map([["notes.txt", {
    bytes: encoder.encode("unaffected"), modifiedMs: 10,
  }]]));
  const listFolders = remote.listFolders;
  remote.listFolders = async () => [...await listFolders(), {
    id: "other", label: "Other", readOnly: false, stats: undefined,
  }];
  remote.getFolderSyncState = async folderId => {
    if (folderId === "folder") throw new Error("Synthetic metadata transport timeout");
    return { folderId, remoteIndexId: "1", remoteMaxSequence: "1", indexReceived: true };
  };
  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  assert.deepEqual(results.map(({ folderId, result }) => [folderId, result]),
    [["folder", "unavailable"], ["other", "downloaded"]]);
  await documents.close();
});


test("a failed offline directory snapshot does not abort downloaded favorites", async () => {
  const { documents, folderId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const { remote } = fakeRemote(new Map([
    ["docs/keep.txt", { bytes: encoder.encode("still available"), modifiedMs: 10 }],
  ]));
  documents.saveDirectorySnapshot = async () => { throw new Error("Synthetic snapshot storage failure"); };
  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  assert.deepEqual(results.map(({ result }) => result), ["downloaded"]);
  const reader = await documents.open(encodeDocumentId(folderId, "docs/keep.txt"), "r");
  assert.deepEqual(await documents.read(reader, 0, 15), encoder.encode("still available"));
  await documents.release(reader);
  await documents.close();
});
