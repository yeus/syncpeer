import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createDocumentFilesystem } from "../packages/core/src/sync/documentFilesystem.ts";
import { syncServiceFileFavorites } from "../packages/core/src/sync/serviceFavoriteSync.ts";
import type { FileEntry, RemoteFs } from "../packages/core/src/core/model/remoteFs.ts";
import { memoryDocumentStorage } from "./lan-test/replica-storage.ts";

const encoder = new TextEncoder();

function fakeRemote(files: Map<string, { bytes: Uint8Array; modifiedMs: number }>, options: {
  indexReceived?: boolean;
  failUploads?: boolean;
  failDeletes?: boolean;
} = {}) {
  const requests = { uploads: [] as Array<{ path: string; bytes: Uint8Array }>, deletions: [] as string[] };
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
    readDir: async (_folderId: string, parent: string): Promise<FileEntry[]> => children(parent),
    readFileToSink: async (_folderId: string, path: string, sink: {
      begin: (metadata: { folderId: string; path: string; sizeBytes: number; encrypted: boolean; contentId?: string }) => Promise<void>;
      write: (offset: number, bytes: Uint8Array) => Promise<void>;
      commit: () => Promise<void>;
    }) => {
      const file = files.get(path);
      if (!file) throw new Error(`Remote file is missing: ${path}`);
      await sink.begin({ folderId: "folder", path, sizeBytes: file.bytes.length, encrypted: false, contentId: "test" });
      await sink.write(0, file.bytes);
      await sink.commit();
      return { bytesWritten: file.bytes.length, totalBytes: file.bytes.length };
    },
    writeFileFully: async (_folderId: string, path: string, bytes: Uint8Array, uploadOptions?: { modifiedMs?: number }) => {
      if (options.failUploads) throw new Error("Synthetic upload failure.");
      requests.uploads.push({ path, bytes: bytes.slice() });
      files.set(path, { bytes: bytes.slice(), modifiedMs: uploadOptions?.modifiedMs ?? Date.now() });
    },
    deleteFile: async (_folderId: string, path: string) => {
      if (options.failDeletes) throw new Error("Synthetic delete failure.");
      requests.deletions.push(path); files.delete(path);
    },
  };
  return { remote, requests, files };
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
  return { documents, options, openStorage, storageId: JSON.parse((await documents.list("syncpeer-root"))[0].id)[0] as string };
}

async function cacheRemoteFile(documents: Awaited<ReturnType<typeof createFixture>>["documents"],
  path: string, bytes: Uint8Array, modifiedMs: number) {
  const handle = await documents.beginDownload("folder", path, bytes.length, modifiedMs);
  await documents.write(handle, 0, bytes);
  await documents.finishDownload(handle);
}

const favoriteState = async (documents: Awaited<ReturnType<typeof createFixture>>["documents"]) =>
  (await documents.favoriteSyncState("folder")).entries["notes.txt"];

test("downloads a newly selected favorite and persists its baseline", async () => {
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "downloaded" }]);
  const id = JSON.stringify([storageId, "notes.txt"]);
  const reader = await documents.open(id, "r");
  assert.deepEqual(await documents.read(reader, 0, content.length), content);
  await documents.release(reader);
  assert.deepEqual((await documents.syncBaseline(id))?.hash.length, 64);
  assert.equal((await favoriteState(documents))?.phase, "synced");
  await documents.close();
});

test("uploads an offline favorite edit and advances the baseline", async () => {
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer"), edited = encoder.encode("offline edit");
  const { remote, requests } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = JSON.stringify([storageId, "notes.txt"]);
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

test("propagates a local favorite deletion to the peer and clears its baseline", async () => {
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = JSON.stringify([storageId, "notes.txt"]);
  await documents.remove(id);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(requests.deletions, ["notes.txt"]);
  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "deleted" }]);
  assert.equal(await documents.syncBaseline(id), undefined);
  await documents.close();
});

test("removes the local copy when the peer deleted an unchanged favorite", async () => {
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  requests.deletions.length = 0;
  files.delete("notes.txt");

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(requests.deletions, []);
  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "deleted-local" }]);
  await assert.rejects(documents.stat(JSON.stringify([storageId, "notes.txt"])), /unavailable/i);
  assert.equal(await documents.syncBaseline(JSON.stringify([storageId, "notes.txt"])), undefined);
  await documents.close();
});

test("preserves a locally edited favorite when the peer deleted its copy", async () => {
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  files.delete("notes.txt");
  const id = JSON.stringify([storageId, "notes.txt"]);
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
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  await documents.remove(JSON.stringify([storageId, "notes.txt"]));
  files.set("notes.txt", { bytes: encoder.encode("peer changed"), modifiedMs: 20 });

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(requests.deletions, []);
  assert.equal(results[0].result, "conflict");
  assert.ok(await documents.syncBaseline(JSON.stringify([storageId, "notes.txt"])),
    "A conflict keeps the verified baseline for later resolution");
  await documents.close();
});

test("publishes a renamed favorite and removes the old peer path", async () => {
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  await documents.rename(JSON.stringify([storageId, "notes.txt"]), "renamed.txt");

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
  assert.ok(await documents.syncBaseline(JSON.stringify([storageId, "renamed.txt"])));
  const favorites = (await documents.profileSettings()).folders.folder.favorites;
  assert.equal(favorites[0].path, "renamed.txt");
  assert.equal(favorites[0].key, "file:folder:renamed.txt");
  assert.equal((await documents.favoriteSyncState("folder")).renames.length, 0);
  await documents.close();
});

test("resumes a rename that was interrupted after publishing the new name", async () => {
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const first = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]), { failDeletes: true });
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  await documents.rename(JSON.stringify([storageId, "notes.txt"]), "renamed.txt");

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
  const { documents, options, openStorage, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const first = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]), { failUploads: true });
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = JSON.stringify([storageId, "notes.txt"]);
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
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests } = fakeRemote(new Map(), { indexReceived: false });
  await cacheRemoteFile(documents, "notes.txt", content, 10);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "notes.txt", result: "waiting",
    message: "Folder index is still being received." }]);
  assert.deepEqual(requests.deletions, []);
  const reader = await documents.open(JSON.stringify([storageId, "notes.txt"]), "r");
  assert.equal((await documents.read(reader, 0, 9)).length, 9);
  await documents.release(reader);
  await documents.close();
});

test("downloads only the selected descendants of a directory favorite", async () => {
  const { documents, storageId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
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
  const reader = await documents.open(JSON.stringify([storageId, "docs/sub/nested.txt"]), "r");
  assert.deepEqual(await documents.read(reader, 0, nested.length), nested);
  await documents.release(reader);
  await assert.rejects(documents.stat(JSON.stringify([storageId, "docs/skip.log"])), /unavailable/i);
  await assert.rejects(documents.stat(JSON.stringify([storageId, "other.txt"])), /unavailable/i);
  await documents.close();
});

test("uploads an offline edit inside a directory favorite", async () => {
  const { documents, storageId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const original = encoder.encode("from peer"), edited = encoder.encode("edited offline");
  const { remote, requests } = fakeRemote(new Map([["docs/keep.txt", { bytes: original, modifiedMs: 10 }]]));

  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  const id = JSON.stringify([storageId, "docs/keep.txt"]);
  const writer = await documents.open(id, "rw");
  await documents.write(writer, 0, edited);
  await documents.release(writer);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 2000 });

  assert.deepEqual(results, [{ folderId: "folder", path: "docs/keep.txt", result: "uploaded" }]);
  assert.deepEqual(requests.uploads, [{ path: "docs/keep.txt", bytes: edited }]);
  await documents.close();
});

test("propagates a peer deletion inside a directory favorite and keeps local edits", async () => {
  const { documents, storageId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const content = encoder.encode("from peer");
  const { remote, files } = fakeRemote(new Map([
    ["docs/gone.txt", { bytes: content, modifiedMs: 10 }],
    ["docs/edited.txt", { bytes: content, modifiedMs: 10 }],
  ]));
  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  files.delete("docs/gone.txt");
  files.delete("docs/edited.txt");
  const editedId = JSON.stringify([storageId, "docs/edited.txt"]);
  const writer = await documents.open(editedId, "rw");
  await documents.write(writer, 0, encoder.encode("local edit"));
  await documents.release(writer);

  const { results } = await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 2000 });

  assert.deepEqual(results.map(result => [result.path, result.result]).sort(), [
    ["docs/edited.txt", "conflict"],
    ["docs/gone.txt", "deleted-local"],
  ]);
  await assert.rejects(documents.stat(JSON.stringify([storageId, "docs/gone.txt"])), /unavailable/i);
  const reader = await documents.open(editedId, "r");
  assert.deepEqual(await documents.read(reader, 0, 10), encoder.encode("local edit"));
  await documents.release(reader);
  await documents.close();
});

test("renames a directory favorite by publishing descendants and tombstoning old names", async () => {
  const { documents, storageId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const first = encoder.encode("first"), second = encoder.encode("second");
  const { remote, requests, files } = fakeRemote(new Map([
    ["docs/a.txt", { bytes: first, modifiedMs: 10 }],
    ["docs/sub/b.txt", { bytes: second, modifiedMs: 11 }],
  ]));
  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  await documents.rename(JSON.stringify([storageId, "docs"]), "notes");

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
  const { documents, storageId } = await createFixture([{ path: "docs", name: "docs", kind: "folder" }]);
  const content = encoder.encode("from peer");
  const { remote, requests } = fakeRemote(new Map([["docs/keep.txt", { bytes: content, modifiedMs: 10 }]]));
  await syncServiceFileFavorites(documents, remote as unknown as RemoteFs, { nowMs: 1000 });
  const created = await documents.create(JSON.stringify([storageId, "docs"]), "offline.txt", false);
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

test("applies a recorded keep-local resolution by publishing the local copy", async () => {
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, requests, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = JSON.stringify([storageId, "notes.txt"]);
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
  const { documents, storageId } = await createFixture();
  const content = encoder.encode("from peer");
  const { remote, files } = fakeRemote(new Map([["notes.txt", { bytes: content, modifiedMs: 10 }]]));
  await cacheRemoteFile(documents, "notes.txt", content, 10);
  const id = JSON.stringify([storageId, "notes.txt"]);
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
