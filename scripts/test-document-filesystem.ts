import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createDocumentFilesystem } from "../packages/core/dist/sync/documentFilesystem.js";
import { deriveUntrustedFolderCrypto, loadEncryptedDiskMetadata } from "../packages/core/dist/filesystem.js";
import { memoryDocumentStorage } from "./lan-test/replica-storage.ts";

test("automatic folder storage starts empty and retains folder roots and downloaded files across restarts", async () => {
  const { openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const options = { profileId: "fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => secret,
      save: async (value: string) => { secret = value; }, remove: async () => { secret = null; },
    } };
  let documents = createDocumentFilesystem(options);
  assert.equal((await documents.initialize(true)).vault.phase, "unlocked");
  assert.deepEqual(await documents.list("syncpeer-root"), []);
  await documents.rememberFolder({ id: "photos", label: "Photos" });
  const [photos] = await documents.list("syncpeer-root");
  assert.deepEqual(await documents.list(photos.id), []);
  await documents.register({ id: "photos", label: "Photos", password: "synthetic-remote-password" });
  const handle = await documents.beginDownload("photos", "sample.txt", 3, 1000);
  await documents.write(handle, 0, Uint8Array.of(1, 2, 3));
  await documents.finishDownload(handle);
  await documents.rememberFolder({ id: "music", label: "Music" });
  await documents.close();
  documents = createDocumentFilesystem(options);
  assert.equal((await documents.initialize(true)).vault.phase, "unlocked");
  const folders = await documents.list("syncpeer-root");
  assert.deepEqual(folders.map(folder => folder.name), ["Photos", "Music"]);
  assert.equal(folders[0].id, photos.id);
  assert.deepEqual(await documents.list(folders[1].id), []);
  assert.deepEqual((await documents.list(photos.id)).map(file => file.name), ["sample.txt"]);
  await documents.close();
});

test("automatic setup does not publish a vault when secure storage cannot retain its key", async () => {
  const { openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => null, save: async () => {}, remove: async () => {},
    } });
  await assert.rejects(documents.initialize(true), /verification failed/);
  assert.equal((await documents.status()).vault.phase, "uninitialized");
  await documents.close();
});

test("directory catalogs stay encrypted and cache eviction preserves favorites and local edits", async () => {
  const { roots, openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const options = { profileId: "policy-fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 100,
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => secret,
      save: async (value: string) => { secret = value; }, remove: async () => { secret = null; } } };
  const documents = createDocumentFilesystem(options);
  await documents.initialize(true);
  await documents.register({ id: "folder", label: "Folder", password: "synthetic-password" });
  await documents.attachDownloads("folder");
  await documents.saveDirectorySnapshot("folder", "synthetic-device", "", {
    entries: [{ name: "remote-only.txt", path: "remote-only.txt", type: "file", size: 9, modifiedMs: 1 }],
    versionKey: "v1", loadedAtMs: 10,
  });
  assert.equal((await documents.loadDirectorySnapshot("folder", "synthetic-device", ""))?.entries[0].name,
    "remote-only.txt");
  for (const path of ["favorite.txt", "evictable.txt", "edited.txt"]) {
    const handle = await documents.beginDownload("folder", path, 3, 1);
    await documents.write(handle, 0, Uint8Array.of(1, 2, 3));
    await documents.finishDownload(handle);
  }
  const settings = await documents.profileSettings();
  settings.profile.cache.overrideBytes = 6;
  settings.folders.folder = { exclusions: [], ignorePatterns: [], paused: false,
    favorites: [{ key: "file:folder:favorite.txt", folderId: "folder", path: "favorite.txt",
      name: "favorite.txt", kind: "file" }] };
  await documents.saveProfileSettings(settings);
  const [folder] = await documents.list("syncpeer-root");
  const edited = (await documents.list(folder.id)).find(entry => entry.name === "edited.txt")!;
  const writer = await documents.open(edited.id, "rw");
  await documents.write(writer, 0, Uint8Array.of(9));
  await documents.release(writer);
  const result = await documents.enforceCacheQuota();
  assert.deepEqual(result.evicted, ["folder:evictable.txt"]);
  assert.deepEqual((await documents.cachedFiles()).map(file => file.path).sort(), ["edited.txt", "favorite.txt"]);
  for (const root of roots.values()) for (const entry of root.files.values()) {
    assert.equal(Buffer.from(entry.bytes).includes(Buffer.from("remote-only.txt")), false);
  }
  await documents.close();
});

test("registered encrypted documents reopen with remembered credentials, and lock revokes handles", async () => {
  const { roots, openStorage } = memoryDocumentStorage();
  let remembered: string | null = null;
  const options = { profileId: "synthetic-profile", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes,
    rememberedSecret: { isDeviceUnlocked: async () => true, save: async (secret: string) => { remembered = secret; },
      load: async () => remembered, remove: async () => { remembered = null; } } };
  let documents = createDocumentFilesystem(options);
  assert.equal((await documents.initialize()).vault.phase, "uninitialized");
  await documents.createVault("synthetic-master", true);
  await documents.register({ id: "fixture-folder", label: "Fixture", password: "synthetic-folder-password" });
  const profileSettings = await documents.profileSettings();
  profileSettings.profile.versioning = "trash";
  profileSettings.folders["fixture-folder"] = { favorites: [{ key: "folder:fixture-folder:",
    folderId: "fixture-folder", path: "", name: "Fixture", kind: "folder" }], exclusions: [],
    ignorePatterns: [], paused: false };
  await documents.saveProfileSettings(profileSettings);
  const [folder] = await documents.list("syncpeer-root");
  const file = await documents.create(folder.id, "sample.txt", false);
  const writer = await documents.open(file.id, "rw");
  await documents.write(writer, 0, Uint8Array.of(1, 2, 3, 4));
  await documents.flush(writer);
  await documents.write(writer, 1, Uint8Array.of(8, 9));
  await documents.release(writer);
  await documents.close();
  documents = createDocumentFilesystem(options);
  assert.equal((await documents.initialize()).vault.phase, "unlocked");
  assert.equal((await documents.list(folder.id))[0].size, 4);
  const reader = await documents.open(file.id, "r");
  assert.deepEqual(await documents.read(reader, 0, 4), Uint8Array.of(1, 8, 9, 4));
  const firstWriter = await documents.open(file.id, "rw");
  const staleWriter = await documents.open(file.id, "rw");
  await documents.write(firstWriter, 0, Uint8Array.of(5));
  await documents.flush(firstWriter);
  await documents.write(staleWriter, 0, Uint8Array.of(6));
  await assert.rejects(documents.flush(staleWriter), /changed|version|stale/i);
  await assert.rejects(documents.write(staleWriter, 0, Uint8Array.of(7)), /closed/i);
  await documents.release(firstWriter);
  const append = await documents.open(file.id, "wa");
  await documents.write(append, 0, Uint8Array.of(10));
  await documents.release(append);
  const currentReader = await documents.open(file.id, "r");
  assert.deepEqual(await documents.read(currentReader, 0, 5), Uint8Array.of(5, 8, 9, 4, 10));
  const versions = await documents.versions(file.id);
  assert.ok(versions.length >= 2);
  const archived = versions.at(-1)!;
  await documents.restoreVersion(file.id, archived.id);
  const restoredReader = await documents.open(file.id, "r");
  const restoredBytes = await documents.read(restoredReader, 0, archived.sizeBytes);
  assert.notDeepEqual(restoredBytes, Uint8Array.of(5, 8, 9, 4, 10));
  await documents.release(restoredReader);
  assert.ok((await documents.versions(file.id)).length > versions.length,
    "Restore archives the current bytes and publishes restored data as a new version");
  profileSettings.profile.versioning = "simple";
  await documents.saveProfileSettings(profileSettings);
  for (const byte of [11, 12]) {
    const revision = await documents.open(file.id, "rwt");
    await documents.write(revision, 0, Uint8Array.of(byte));
    await documents.release(revision);
  }
  assert.equal((await documents.versions(file.id)).length, 1,
    "Encrypted archives apply the same selected simple-version retention policy");
  await documents.lock();
  await assert.rejects(documents.read(reader, 0, 1));
  await documents.close();
  documents = createDocumentFilesystem(options);
  assert.equal((await documents.initialize()).vault.phase, "locked", "Manual lock survives restart");
  await assert.rejects(documents.unlock("wrong-password"));
  await documents.unlock("synthetic-master");
  const recovered = await documents.list(folder.id);
  assert.equal(recovered.length, 2, "Stale acknowledged edits recover as a separate conflict copy");
  assert.deepEqual((await documents.status()).recoveryIssues, []);
  const conflict = recovered.find(file => file.name.includes(".sync-conflict-"))!;
  const conflictReader = await documents.open(conflict.id, "r");
  assert.deepEqual(await documents.read(conflictReader, 0, 4), Uint8Array.of(6, 8, 9, 4));
  await documents.release(conflictReader);
  const transfer = await documents.beginDownload("fixture-folder", "nested/download.txt", 4, 1000);
  assert.equal((await documents.list(folder.id)).some(file => file.name === "nested"), true);
  await documents.write(transfer, 2, Uint8Array.of(3, 4));
  await assert.rejects(documents.finishDownload(transfer), /incomplete/i);
  await documents.write(transfer, 0, Uint8Array.of(1, 2));
  await documents.finishDownload(transfer);
  const renameSource = await documents.create(folder.id, "rename-source.txt", false);
  const renameWriter = await documents.open(renameSource.id, "rwt");
  await documents.write(renameWriter, 0, Uint8Array.of(4, 5, 6));
  await documents.release(renameWriter);
  const renamed = await documents.rename(renameSource.id, "renamed.txt");
  const renamedReader = await documents.open(renamed.id, "r");
  assert.deepEqual(await documents.read(renamedReader, 0, 3), Uint8Array.of(4, 5, 6));
  await documents.release(renamedReader);
  assert.equal(await documents.remove(renamed.id), true);
  assert.equal((await documents.list(folder.id)).some(file => file.name === "renamed.txt"), false);
  const removableDirectory = await documents.create(folder.id, "removable", true);
  const removableFile = await documents.create(removableDirectory.id, "nested.txt", false);
  const removableWriter = await documents.open(removableFile.id, "rwt");
  await documents.write(removableWriter, 0, Uint8Array.of(7, 8, 9));
  await documents.release(removableWriter);
  assert.equal(await documents.remove(removableDirectory.id), true);
  await assert.rejects(documents.stat(removableFile.id), /unavailable/i);
  assert.equal((await documents.list(folder.id)).some(file => file.name === "removable"), false);
  await documents.attachDownloads("fixture-folder");
  const cached = await documents.cachedFiles();
  const downloaded = cached.find(file => file.path === "nested/download.txt")!;
  assert.equal(downloaded.sizeBytes, 4);
  const picker = await documents.open(JSON.stringify([JSON.parse(folder.id)[0], downloaded.path]), "rw");
  await documents.write(picker, 0, Uint8Array.of(9));
  await documents.release(picker);
  const replacement = await documents.beginDownload("fixture-folder", downloaded.path, 4, 2000);
  await documents.write(replacement, 0, Uint8Array.of(4, 3, 2, 1));
  const concurrent = await documents.open(JSON.stringify([JSON.parse(folder.id)[0], downloaded.path]), "rw");
  await documents.write(concurrent, 0, Uint8Array.of(8));
  await documents.release(concurrent);
  await assert.rejects(documents.finishDownload(replacement), /changed|version|stale/i);
  await documents.release(replacement, true);
  const partial = await documents.beginDownload("fixture-folder", "partial.txt", 4, 3000);
  await documents.write(partial, 0, Uint8Array.of(1));
  await documents.close();
  documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.unlock("synthetic-master");
  assert.equal((await documents.status()).folders[0].downloads, true);
  assert.equal((await documents.cachedFiles()).some(file => file.path === "partial.txt"), false, "Incomplete downloads must never be recovered as complete files");
  await documents.close();
  for (const root of roots.values()) for (const entry of root.files.values()) {
    assert.equal(Buffer.from(entry.bytes).includes(Buffer.from("synthetic-folder-password")), false);
  }
  const crypto = await deriveUntrustedFolderCrypto("fixture-folder", "synthetic-folder-password");
  let archives = 0;
  try {
    for (const root of roots.values()) for (const [path, entry] of root.files) {
      if (!path.startsWith(".stversions/") || entry.type !== "file") continue;
      const encryptedName = path.split("/").slice(2).join("/");
      assert.ok(encryptedName, "Archive retains the original encrypted path");
      const metadata = await loadEncryptedDiskMetadata({ size: entry.bytes.length,
        readRange: async (offset, size) => entry.bytes.slice(offset, offset + size) }, encryptedName, crypto.folderKey);
      try {
        assert.ok(["sample.txt", "nested/download.txt", "rename-source.txt", "renamed.txt",
          "removable/nested.txt"].includes(metadata.fileInfo.name));
        archives++;
      } finally { metadata.fileKey.fill(0); }
    }
    assert.ok(archives > 0);
  } finally { crypto.folderKey.fill(0); }
});
