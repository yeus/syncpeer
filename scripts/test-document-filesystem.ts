import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createDocumentFilesystem } from "../packages/core/dist/sync/documentFilesystem.js";
import { changesSessionConfiguration, deriveUntrustedFolderCrypto, loadEncryptedDiskMetadata } from "../packages/core/dist/filesystem.js";
import { scryptPasswordKdf, type PasswordKdf } from "../packages/core/dist/kdf.js";
import { memoryDocumentStorage } from "./lan-test/replica-storage.ts";
import { createOwnedDeviceIdentity, createOwnedRecoveryKit } from "../packages/core/dist/sync/personalSpaceSharing.js";
import { createCredentialVault } from "../packages/core/dist/sync/credentialVault.js";
import { createCredentialVaultStorage, createPersonalSpaceBootstrapStorage } from
  "../packages/core/dist/sync/credentialVaultStorage.js";
import { defaultFolderSettings, defaultProfileSettings } from "../packages/core/dist/sync/profileSettings.js";
import { purgePrivateReplicaContents } from "../packages/core/dist/sync/replicaPurge.js";

test("listener snapshots are invalidated by sharing changes, not ordinary document edits", () => {
  for (const operation of ["lock", "unlock", "saveProfileSettings", "savePersonalSpaceSetting",
    "revokeOwnedDevice", "register", "attachDownloads", "saveConnectionPasswords"]) {
    assert.equal(changesSessionConfiguration(operation), true, operation);
  }
  for (const operation of ["status", "sessionSharedFolders", "read", "write", "flush", "remove", "rename"]) {
    assert.equal(changesSessionConfiguration(operation), false, operation);
  }
  assert.equal(changesSessionConfiguration("savePersonalSpaceSetting", ["folders", "photos", "retention"]), false);
  assert.equal(changesSessionConfiguration("resolvePersonalSpaceConflict", ["folders", "photos", "retention"]), false);
  for (const path of [["folders", "photos", "credential"], ["folders", "photos", "shareTargets"],
    ["folders", "photos", "devices", "owner"]]) {
    assert.equal(changesSessionConfiguration("savePersonalSpaceSetting", path), true);
  }
});

test("an ordinary Syncthing peer can receive an explicitly selected folder without a personal space", async () => {
  const { openStorage } = memoryDocumentStorage();
  const preparationStages: string[] = [];
  const documents = createDocumentFilesystem({ profileId: "ordinary-peer-fixture", deviceCounterId: "45",
    openStorage, profile: await openStorage("profile"), randomBytes,
    availableBytes: async () => 1024 * 1024 * 1024,
    onDiagnostic: event => preparationStages.push(event) });
  await documents.initialize();
  await documents.createVault("synthetic-master-password", false);
  await documents.register({ id: "photos", label: "Photos", password: "synthetic-folder-password" });
  await documents.attachDownloads("photos");
  const settings = await documents.profileSettings();
  settings.folders.photos = { ...defaultFolderSettings(), favorites: [{ key: "folder:photos:",
    folderId: "photos", path: "", name: "Photos", kind: "folder" }] };
  await documents.saveProfileSettings(settings);
  const folders = await documents.sessionSharedFolders("SYNTHETIC-ORDINARY-PEER");
  assert.deepEqual(folders.map(folder => folder.id), ["photos"]);
  assert.equal(folders[0]?.encryption?.mode, "encrypted");
  assert.deepEqual(preparationStages.filter(event => event.startsWith("document.session_folders.")), [
    "document.session_folders.queued", "document.session_folders.queued_done",
    "document.session_folders.membership_done",
    "document.session_folders.context_done", "document.session_folders.credentials_done",
    "document.session_folders.settings_done", "document.session_folders.done",
  ]);
  await documents.close();
});

test("status refreshes shared credentials only when the settings replica changes", async () => {
  const { openStorage } = memoryDocumentStorage();
  const events: string[] = [];
  const documents = createDocumentFilesystem({ profileId: "settings-refresh-fixture", deviceCounterId: "46",
    openStorage, profile: await openStorage("profile"), randomBytes,
    availableBytes: async () => 1024 * 1024 * 1024,
    onDiagnostic: event => events.push(event) });
  await documents.initialize();
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  await documents.createVault("synthetic-master-password", false, "DEVICE", kit.publicKey);
  const peer = await createOwnedDeviceIdentity(crypto.subtle, randomBytes, "PEER");
  await documents.exportPairingTransfer("DEVICE", { id: peer.id, syncthingId: peer.syncthingId,
    state: peer.state, signingKey: peer.signingKey });
  const deviceId = (await documents.ownedDevices()).localDeviceId!;
  await documents.status();
  await documents.status();
  assert.equal(events.filter(event => event === "document.settings_refresh.started").length, 1);
  await documents.appendPersonalSpaceChange({ id: "new-credential", deviceId,
    path: ["folders", "photos", "credential"], parents: [],
    value: { label: "Photos", password: "synthetic-shared-folder-password" } });
  assert.deepEqual((await documents.status()).folders.map(folder => folder.id), ["photos"]);
  assert.equal(events.filter(event => event === "document.settings_refresh.started").length, 2);
  await documents.close();
});

test("local-only purge keeps the replica marker and never emits BEP tombstones", async () => {
  const { openStorage, roots } = memoryDocumentStorage();
  const storage = await openStorage("synthetic-root");
  await storage.makeDirectory(".stfolder");
  await storage.makeDirectory("encrypted-directory");
  const file = await storage.createSink("encrypted-directory/block", 3);
  await file.write(0, Uint8Array.of(1, 2, 3)); await file.commit();
  const index = await storage.createSink(".syncpeer-replica-index", 1);
  await index.write(0, Uint8Array.of(4)); await index.commit();
  await purgePrivateReplicaContents(storage);
  assert.deepEqual([...roots.get("synthetic-root")!.files.keys()], [".stfolder"]);
  await storage.close();
  const empty = await openStorage("unmarked-root");
  await assert.rejects(purgePrivateReplicaContents(empty), /marker/i);
  await empty.close();
});

test("acknowledged local release persists browse-only state, purges only its private copy, and survives restart", async () => {
  const { roots, openStorage } = memoryDocumentStorage();
  const options = { profileId: "release-fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024 };
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  let documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.createVault("synthetic-master-password", false, "OWNER", kit.publicKey);
  await documents.register({ id: "photos", label: "Photos", password: "synthetic-folder-password" });
  await documents.attachDownloads("photos");
  const handle = await documents.beginDownload("photos", "keep.txt", 3, 100);
  await documents.write(handle, 0, Uint8Array.of(1, 2, 3));
  await documents.finishDownload(handle);
  const before = (await documents.status()).folders.find(folder => folder.id === "photos")!;
  await assert.rejects(documents.releaseLocalCopy("photos", { mode: "dangerous", confirmedText: "release" }),
    /RELEASE LOCAL COPY/i);
  assert.equal((await documents.status()).folders.find(folder => folder.id === "photos")?.downloads, true);
  await documents.releaseLocalCopy("photos", { mode: "dangerous", confirmedText: "RELEASE LOCAL COPY" });
  assert.equal((await documents.status()).folders.find(folder => folder.id === "photos")?.browseOnly, true);
  assert.deepEqual([...roots.get(before.storageId)!.files.keys()], [".stfolder"]);
  assert.equal((await documents.localReleaseHistory())[0]?.kind, "dangerous");
  const { dispatchDocumentCommand } = await import("../packages/core/dist/sync/documentCommands.js");
  assert.equal((await dispatchDocumentCommand(documents, { operation: "localReleaseHistory" }) as
    Array<{ kind: string }>)[0]?.kind, "dangerous");
  await documents.close();
  documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.unlock("synthetic-master-password");
  assert.equal((await documents.status()).folders.find(folder => folder.id === "photos")?.browseOnly, true);
  assert.deepEqual(await documents.cachedFiles(), []);
  await documents.close();
});

test("safe release requires a live authenticated peer whose full blocks match the local manifest", async () => {
  const { roots, openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "safe-release-fixture", deviceCounterId: "42",
    openStorage, profile: await openStorage("profile"), randomBytes,
    availableBytes: async () => 1024 * 1024 * 1024 });
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  await documents.initialize();
  await documents.createVault("synthetic-master-password", false, "OWNER", kit.publicKey);
  await documents.register({ id: "photos", label: "Photos", password: "synthetic-folder-password" });
  await documents.attachDownloads("photos");
  const content = Uint8Array.of(1, 2, 3, 4);
  const handle = await documents.beginDownload("photos", "keep.txt", content.length, 100);
  await documents.write(handle, 0, content); await documents.finishDownload(handle);
  const localId = (await documents.ownedDevices()).localDeviceId!;
  await documents.savePersonalSpaceSetting(["folders", "photos", "retention"], {
    minimumCopies: 2, retentionRevision: 2,
    holders: [{ id: localId, kind: "syncpeer" }, { id: "PEER", kind: "syncthing" },
      { id: "PEER2", kind: "syncthing" }],
  });
  await documents.savePersonalSpaceSetting(["folders", "photos", "shareTargets"],
    [{ kind: "device", syncthingId: "PEER" }]);
  const settings = await documents.profileSettings();
  settings.folders.photos = { ...defaultFolderSettings(), favorites: [{ key: "folder:photos:",
    folderId: "photos", path: "", name: "Photos", kind: "folder" }] };
  await documents.saveProfileSettings(settings);
  const [shared] = await documents.sessionSharedFolders("PEER");
  const files = await shared.replica!.scan();
  let closed = false;
  const session = { remoteDeviceId: "PEER", isClosed: () => closed,
    remoteFs: { completeFolderIndex: async () => files,
      readFileRange: async (_folderId: string, _path: string, offset: number, size: number) => content.slice(offset, offset + size) } };
  await assert.rejects(documents.releaseLocalCopy("photos", { mode: "safe", sessions: [] }), /online|copy/i);
  closed = true;
  await assert.rejects(documents.releaseLocalCopy("photos", { mode: "safe", sessions: [session] }), /online|closed/i);
  closed = false;
  await assert.rejects(documents.releaseLocalCopy("photos", { mode: "safe", sessions: [session] }), /online|copy/i);
  await assert.rejects(documents.releaseLocalCopy("photos", { mode: "safe", sessions: [session,
    { ...session, remoteDeviceId: "PEER", claimedHolderId: "PEER2" }] }), /online|copy/i);
  await assert.rejects(documents.releaseLocalCopy("photos", { mode: "safe", sessions: [session,
    { ...session, remoteDeviceId: "PEER2", remoteFs: { ...session.remoteFs,
      readFileRange: async () => Uint8Array.of(0, 0, 0, 0) } }] }), /online|copy/i);
  await documents.releaseLocalCopy("photos", { mode: "safe", sessions: [session,
    { ...session, remoteDeviceId: "PEER2" }] });
  const folder = (await documents.status()).folders.find(value => value.id === "photos")!;
  assert.equal(folder.browseOnly, true);
  assert.deepEqual([...roots.get(folder.storageId)!.files.keys()], [".stfolder"]);
  assert.equal((await documents.localReleaseHistory())[0]?.kind, "safe");
  await documents.close();
});

test("an interrupted private purge resumes from the signed pending release on unlock", async () => {
  const { roots, openStorage: backingStorage } = memoryDocumentStorage();
  let failPurge = false;
  const openStorage = async (id: string) => {
    const storage = await backingStorage(id);
    return { ...storage, remove: async (path: string, directory: boolean) => {
      if (id !== "profile" && failPurge && path !== ".stfolder") {
        failPurge = false;
        throw new Error("synthetic interrupted purge");
      }
      await storage.remove(path, directory);
    } };
  };
  const options = { profileId: "release-recovery-fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024 };
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  let documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.createVault("synthetic-master-password", false, "OWNER", kit.publicKey);
  await documents.register({ id: "photos", label: "Photos", password: "synthetic-folder-password" });
  await documents.attachDownloads("photos");
  const handle = await documents.beginDownload("photos", "keep.txt", 1, 100);
  await documents.write(handle, 0, Uint8Array.of(9)); await documents.finishDownload(handle);
  const folder = (await documents.status()).folders.find(value => value.id === "photos")!;
  failPurge = true;
  await assert.rejects(documents.releaseLocalCopy("photos", { mode: "dangerous",
    confirmedText: "RELEASE LOCAL COPY" }), /interrupted purge/i);
  assert.equal((await documents.status()).folders.find(value => value.id === "photos")?.browseOnly, true);
  assert.equal((await documents.status()).pendingLocalReleases?.length, 1);
  await assert.rejects(documents.attachDownloads("photos"), /pending local release/i);
  await assert.rejects(documents.register({ id: "photos", label: "Photos" }), /pending local release/i);
  assert.ok(roots.get(folder.storageId)!.files.size > 1);
  await documents.close();
  documents = createDocumentFilesystem(options);
  await documents.initialize(); await documents.unlock("synthetic-master-password");
  assert.deepEqual([...roots.get(folder.storageId)!.files.keys()], [".stfolder"]);
  assert.deepEqual((await documents.status()).pendingLocalReleases, []);
  assert.equal((await documents.localReleaseHistory()).length, 1);
  await documents.close();
});

test("document bridge identifies an invalid transfer field without echoing its value", async () => {
  const { dispatchDocumentCommand } = await import("../packages/core/dist/sync/documentCommands.js");
  const oversized = "synthetic-marker".repeat(300);
  await assert.rejects(dispatchDocumentCommand({} as never, { operation: "beginDownload",
    folderId: "fixture-folder", path: "fixture.bin", size: 1, modifiedMs: 1,
    encrypted: false, contentId: oversized }), error => {
    assert.match(String(error), /contentId.*4096/);
    assert.doesNotMatch(String(error), /synthetic-marker/);
    return true;
  });
});

test("first-run folder storage requires a recoverable master password and retains files across restarts", async () => {
  const { openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const restrictedOpenStorage = async (id: string) => {
    assert.match(id, /^(profile|[a-f0-9]{32})$/, "Encrypted profile storage IDs must match the native boundary.");
    return openStorage(id);
  };
  const options = { profileId: "fixture", deviceCounterId: "42", openStorage: restrictedOpenStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => secret,
      save: async (value: string) => { secret = value; }, remove: async () => { secret = null; },
    } };
  let documents = createDocumentFilesystem(options);
  assert.equal((await documents.initialize()).vault.phase, "uninitialized");
  await assert.rejects(documents.createVault("synthetic-master-password", true, "FIRST-DEVICE"), /recovery signing kit/i);
  await assert.rejects(documents.createVault("synthetic-master-password", true, "FIRST-DEVICE", "invalid"), /recovery signing key/i);
  assert.equal((await documents.status()).vault.phase, "uninitialized");
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  await documents.createVault("synthetic-master-password", true, "FIRST-DEVICE", kit.publicKey);
  const initialMembership = await documents.ownedDevices();
  assert.equal(initialMembership.devices.length, 1);
  assert.equal(initialMembership.devices[0].syncthingId, "FIRST-DEVICE");
  assert.equal(initialMembership.localDeviceId, initialMembership.devices[0].id);
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
  assert.equal((await documents.initialize()).vault.phase, "unlocked");
  const folders = await documents.list("syncpeer-root");
  assert.deepEqual(folders.map(folder => folder.name), ["Photos", "Music"]);
  assert.equal(folders[0].id, photos.id);
  assert.deepEqual(await documents.list(folders[1].id), []);
  assert.deepEqual((await documents.list(photos.id)).map(file => file.name), ["sample.txt"]);
  await documents.close();
});

test("automatic setup does not create an unrecoverable vault when secure storage is unavailable", async () => {
  const { openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => null, save: async () => {}, remove: async () => {},
    } });
  assert.equal((await documents.initialize()).vault.phase, "uninitialized");
  assert.equal((await documents.status()).vault.phase, "uninitialized");
  await documents.close();
});

test("an injected password KDF port serves vault creation and unlock", async () => {
  const { openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const calls: Array<{ password: string; saltLength: number }> = [];
  const kdf: PasswordKdf = async (passwordBytes, salt) => {
    calls.push({ password: new TextDecoder().decode(passwordBytes), saltLength: salt.length });
    return scryptPasswordKdf(passwordBytes, salt);
  };
  const options = { profileId: "kdf-fixture", deviceCounterId: "42", openStorage, kdf,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => secret,
      save: async (value: string) => { secret = value; }, remove: async () => { secret = null; },
    } };
  const documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.createVault("synthetic-master-password", false);
  await documents.close();
  assert.deepEqual(calls.map(call => ({ passwordLength: call.password.length, saltLength: call.saltLength })), [
    { passwordLength: "synthetic-master-password".length, saltLength: 16 },
    { passwordLength: 64, saltLength: 41 },
  ]);
  const reopened = createDocumentFilesystem(options);
  assert.equal((await reopened.initialize()).vault.phase, "locked");
  await reopened.unlock("synthetic-master-password");
  await reopened.close();
  assert.deepEqual(calls.map(call => ({ passwordLength: call.password.length, saltLength: call.saltLength })), [
    { passwordLength: "synthetic-master-password".length, saltLength: 16 },
    { passwordLength: 64, saltLength: 41 },
    { passwordLength: "synthetic-master-password".length, saltLength: 16 },
    { passwordLength: 64, saltLength: 41 },
  ]);
});

test("fresh encrypted profiles never store document names or content in plaintext", async () => {
  const { roots, openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const options = { profileId: "fresh-fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => secret,
      save: async (value: string) => { secret = value; }, remove: async () => { secret = null; },
    } };
  const documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.createVault("synthetic-master-password", false);
  await documents.register({ id: "fresh-folder", label: "Private folder label", password: "synthetic-folder-password" });
  await documents.attachDownloads("fresh-folder");
  const name = "private-fresh-install-marker.txt";
  const content = new TextEncoder().encode("fresh install plaintext marker");
  const handle = await documents.beginDownload("fresh-folder", name, content.length, 1);
  await documents.write(handle, 0, content);
  await documents.finishDownload(handle);
  await documents.close();
  for (const [storageId, fixture] of roots) {
    for (const [path, file] of fixture.files) {
      assert.equal(path.includes("private-fresh-install-marker"), false, `Plaintext name leaked in ${storageId}:${path}`);
      const text = new TextDecoder().decode(file.bytes);
      assert.equal(text.includes("fresh install plaintext marker"), false, `Plaintext content leaked in ${storageId}:${path}`);
      assert.equal(text.includes("Private folder label"), false, `Plaintext label leaked in ${storageId}:${path}`);
    }
  }
});

test("directory catalogs stay encrypted and cache eviction preserves favorites and local edits", async () => {
  const { roots, openStorage } = memoryDocumentStorage();
  let secret: string | null = null;
  const options = { profileId: "policy-fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 100,
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => secret,
      save: async (value: string) => { secret = value; }, remove: async () => { secret = null; } } };
  const documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.createVault("synthetic-master-password", true);
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

test("legacy folder registrations migrate only after encrypted read-back and stay hidden while locked", async () => {
  const { roots, openStorage } = memoryDocumentStorage();
  const profile = await openStorage("profile");
  const options = { profileId: "migration-fixture", deviceCounterId: "42", openStorage, profile, randomBytes,
    availableBytes: async () => 1024 * 1024 * 1024,
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => null,
      save: async () => {}, remove: async () => {} } };
  const documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.createVault("synthetic-master-password", false);
  await documents.close();
  const legacy = [{ id: "legacy-folder", label: "Private legacy label", storageId: "legacy-root" }];
  const data = new TextEncoder().encode(JSON.stringify(legacy));
  const sink = await profile.createSink(".syncpeer-document-folders", data.length);
  await sink.write(0, data); await sink.commit();
  const reopened = createDocumentFilesystem(options);
  assert.deepEqual((await reopened.initialize()).folders, []);
  assert.ok(roots.get("profile")!.files.has(".syncpeer-document-folders"));
  assert.deepEqual((await reopened.unlock("synthetic-master-password")).folders, legacy);
  assert.equal(roots.get("profile")!.files.has(".syncpeer-document-folders"), false);
  await reopened.lock();
  assert.deepEqual((await reopened.status()).folders, []);
  await reopened.close();
});

test("backup commands restore portable credentials without device-local roots or documents", async () => {
  const { dispatchDocumentCommand } = await import("../packages/core/dist/sync/documentCommands.js");
  const makeDocuments = async () => {
    const { openStorage } = memoryDocumentStorage();
    return createDocumentFilesystem({ profileId: "backup-fixture", deviceCounterId: "42", openStorage,
      profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024,
      rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => null,
        save: async () => {}, remove: async () => {} } });
  };
  const source = await makeDocuments();
  await source.initialize();
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  await source.createVault("synthetic-master-password", false, "SOURCE", kit.publicKey);
  await assert.rejects(dispatchDocumentCommand(source, { operation: "sessionSharedFolders" }),
    /remote device identity/i);
  const [sourceSettings] = await source.sessionSharedFolders("SOURCE");
  assert.match(sourceSettings.id, /^[a-f0-9]{32}$/);
  assert.equal(sourceSettings.encryption.mode, "encrypted");
  assert.equal((sourceSettings.encryption as { password: string }).password.length, 64);
  assert.deepEqual(await source.list("syncpeer-root"), [], "The settings folder is never user-visible");
  await source.register({ id: "photos", label: "Photos", password: "synthetic-folder-password" });
  assert.deepEqual((await source.sharedPersonalSpaceSettings()).settings?.folders.photos.credential,
    { label: "Photos", password: "synthetic-folder-password" });
  await source.saveConnectionPasswords({ photos: "synthetic-folder-password" });
  await source.saveUiState({ deviceLocal: "synthetic-private-device" });
  const backup = await dispatchDocumentCommand(source, { operation: "exportRecoveryBackup", password: "synthetic-backup-password" });
  const pairedIdentity = await createOwnedDeviceIdentity(crypto.subtle, randomBytes, "PAIRED");
  const joiningDevice = { id: pairedIdentity.id, syncthingId: pairedIdentity.syncthingId,
    state: pairedIdentity.state, signingKey: pairedIdentity.signingKey };
  const pairingTransfer = await dispatchDocumentCommand(source, { operation: "exportPairingTransfer",
    localDeviceId: "SOURCE", joiningDevice });
  assert.deepEqual(await source.sessionSharedFolders("EXTERNAL"), [],
    "An ordinary external peer must never receive the hidden personal-space settings folder");
  assert.equal((await source.sessionSharedFolders("PAIRED"))[0]?.id, sourceSettings.id,
    "An approved owned device may receive the settings folder");
  assert.equal((await source.sessionSharedFolders("P-A-I-R-E-D"))[0]?.id, sourceSettings.id,
    "Formatted forms of an approved device ID select the same policy");
  const target = await makeDocuments();
  await target.initialize();
  await assert.rejects(dispatchDocumentCommand(target, { operation: "restoreRecoveryBackup", backup,
    recoveryPassword: "wrong-password", password: "new-synthetic-master" }));
  await dispatchDocumentCommand(target, { operation: "restoreRecoveryBackup", backup,
    recoveryPassword: "synthetic-backup-password", password: "new-synthetic-master" });
  await assert.rejects(dispatchDocumentCommand(target, { operation: "recoverOwnedDevice",
    localDeviceId: "RECOVERED", kit, password: "wrong-password" }), /recovery kit/i);
  await dispatchDocumentCommand(target, { operation: "recoverOwnedDevice",
    localDeviceId: "RECOVERED", kit, password: "synthetic-offline-kit-password" });
  assert.deepEqual((await target.ownedDevices()).devices.map(device => [device.syncthingId, device.state]),
    [["SOURCE", "revoked"], ["RECOVERED", "active"]]);
  assert.deepEqual((await target.status()).folders, []);
  assert.equal(await target.uiState(), null);
  assert.deepEqual(await target.connectionPasswords(), { photos: "synthetic-folder-password" });
  await target.register({ id: "photos", label: "Recovered photos", password: "synthetic-folder-password" });
  assert.deepEqual(await target.cachedFiles(), []);
  const paired = await makeDocuments();
  await paired.initialize();
  await dispatchDocumentCommand(paired, { operation: "importPairingTransfer", transfer: pairingTransfer,
    identity: pairedIdentity, password: "paired-device-master", remember: false });
  const [pairedSettings] = await paired.sessionSharedFolders("SOURCE");
  assert.equal(pairedSettings.id, sourceSettings.id);
  assert.deepEqual(pairedSettings.encryption, sourceSettings.encryption);
  assert.deepEqual(await paired.list("syncpeer-root"), [], "Pairing does not expose the settings folder");
  assert.deepEqual((await dispatchDocumentCommand(paired, { operation: "ownedDevices" }) as { devices: unknown[] }).devices,
    pairingTransfer.trust.updates.at(-1)?.devices);
  assert.deepEqual(await paired.connectionPasswords(), {}, "Pairing does not copy device-local credentials directly");
  assert.equal(await pairedSettings.replica?.receive?.(pairedSettings.id,
    await sourceSettings.replica!.scan(), sourceSettings.replica!.readBlock), true);
  assert.deepEqual((await paired.status()).folders.map(folder => folder.id), ["photos"],
    "The approved peer imports the signed credential after encrypted settings replica exchange.");
  await assert.rejects(paired.register({ id: "photos", label: "Photos", password: "wrong-password" }),
    /password changes/i);
  await assert.rejects(dispatchDocumentCommand(target, { operation: "restoreRecoveryBackup", backup,
    recoveryPassword: "synthetic-backup-password", password: "new-synthetic-master" }), /already exists/);
  await source.close(); await target.close(); await paired.close();
});

test("personal-space settings replica survives restart and is revoked by lock", async () => {
  const { openStorage } = memoryDocumentStorage();
  let remembered: string | null = null;
  const options = { profileId: "settings-folder-fixture", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024,
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => remembered,
      save: async (value: string) => { remembered = value; }, remove: async () => { remembered = null; } } };
  let documents = createDocumentFilesystem(options);
  await documents.initialize();
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  await documents.createVault("synthetic-master-password", true, "DEVICE", kit.publicKey);
  const [settings] = await documents.sessionSharedFolders("DEVICE");
  const deviceId = (await documents.ownedDevices()).localDeviceId!;
  const change = { id: "one", deviceId, path: ["folders", "photos", "retention"],
    parents: [], value: { minimumCopies: 2, retentionRevision: 2, holders: [] } };
  await documents.appendPersonalSpaceChange(change);
  await assert.rejects(documents.appendPersonalSpaceChange(change), /already exists|duplicate/i);
  assert.equal((await documents.sharedPersonalSpaceSettings()).settings?.folders.photos.minimumCopies, 2);
  await documents.appendPersonalSpaceChange({ ...change, id: "two",
    value: { minimumCopies: 3, retentionRevision: 2, holders: [] } });
  const conflict = await documents.sharedPersonalSpaceSettings();
  assert.equal(conflict.settings, null);
  assert.deepEqual(conflict.conflicts[0]?.heads, ["one", "two"]);
  await documents.resolvePersonalSpaceConflict(["folders", "photos", "retention"], "two");
  assert.equal((await documents.sharedPersonalSpaceSettings()).settings?.folders.photos.minimumCopies, 3);
  await documents.close();

  documents = createDocumentFilesystem(options);
  assert.equal((await documents.initialize()).vault.phase, "unlocked");
  const [reopened] = await documents.sessionSharedFolders("DEVICE");
  assert.equal(reopened.id, settings.id);
  const persisted = await documents.personalSpaceChanges();
  assert.equal(persisted.length, 3);
  assert.equal(typeof persisted[0]?.signature, "string");
  assert.equal((await documents.sharedPersonalSpaceSettings()).settings?.folders.photos.minimumCopies, 3);
  await documents.lock();
  await assert.rejects(documents.sessionSharedFolders("DEVICE"), /locked/i);
  await documents.close();
});

test("an approved device registers a signed shared folder credential without auto-downloading", async () => {
  const { openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "shared-credential-fixture", deviceCounterId: "42",
    openStorage, profile: await openStorage("profile"), randomBytes,
    availableBytes: async () => 1024 * 1024 * 1024 });
  await documents.initialize();
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  await documents.createVault("synthetic-master-password", false, "DEVICE", kit.publicKey);
  const deviceId = (await documents.ownedDevices()).localDeviceId!;
  await documents.rememberFolder({ id: "photos", label: "Photos" });
  await documents.appendPersonalSpaceChange({ id: "shared-credential", deviceId,
    path: ["folders", "photos", "credential"], parents: [],
    value: { label: "Photos", password: "synthetic-shared-folder-password" } });
  await documents.sessionSharedFolders("DEVICE");
  assert.deepEqual((await documents.status()).folders.map(folder => [folder.id, Boolean(folder.downloads)]),
    [["photos", false]]);
  await assert.rejects(documents.register({ id: "photos", label: "Photos",
    password: "wrong-password" }), /password changes/i);
  await documents.register({ id: "photos", label: "Photos",
    password: "synthetic-shared-folder-password" });
  assert.deepEqual((await documents.status()).folders.map(folder => [folder.id, Boolean(folder.downloads)]),
    [["photos", false]], "A rejected password must not replace the signed credential or start downloads.");
  assert.equal((await documents.personalSpaceChanges()).length, 1,
    "Importing a shared credential must not republish it as a conflicting edit.");
  await documents.close();
});

test("shared favorite selections apply to the local profile while other devices remain isolated", async () => {
  const { openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "shared-favorites-fixture", deviceCounterId: "43", openStorage,
    profile: await openStorage("profile"), randomBytes, availableBytes: async () => 1024 * 1024 * 1024,
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => null,
      save: async () => {}, remove: async () => {} } });
  await documents.initialize();
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  await documents.createVault("synthetic-master-password", false, "DEVICE", kit.publicKey);
  const deviceId = (await documents.ownedDevices()).localDeviceId!;
  const favorite = { folderId: "photos", key: "file:photos:a", path: "a", name: "A", kind: "file" as const };
  await documents.savePersonalSpaceSetting(["folders", "photos", "devices", deviceId],
    { favorites: [favorite], exclusions: [] });
  await documents.savePersonalSpaceSetting(["folders", "photos", "devices", "another-device"],
    { favorites: [], exclusions: [] }).then(() => assert.fail("A device must not edit another device's selection"),
      error => assert.match(String(error), /device selection/i));
  assert.deepEqual((await documents.profileSettings()).folders.photos.favorites, [favorite]);
  const next = await documents.profileSettings();
  next.folders.photos.favorites = [];
  await documents.saveProfileSettings(next);
  assert.deepEqual((await documents.profileSettings()).folders.photos.favorites, []);
  assert.equal((await documents.personalSpaceChanges()).length, 2);
  await documents.close();
});

test("an existing vault keeps local favorites until its device writes a shared selection", async () => {
  const { openStorage } = memoryDocumentStorage();
  const profile = await openStorage("profile");
  await profile.initializeReplica();
  const kit = await createOwnedRecoveryKit(crypto.subtle, randomBytes, "synthetic-offline-kit-password");
  const favorite = { folderId: "photos", key: "folder:photos:", path: "", name: "Photos", kind: "folder" as const };
  const vault = createCredentialVault({ profileId: "existing-favorites-fixture", randomBytes,
    storage: createCredentialVaultStorage(profile, profile),
    bootstrapStorage: createPersonalSpaceBootstrapStorage(profile, profile), revokeAccess: async () => {} });
  await vault.create("synthetic-master-password", false, "DEVICE", kit.publicKey);
  await vault.saveProfileSettings({ ...defaultProfileSettings(), folders: {
    photos: { ...defaultFolderSettings(), favorites: [favorite] },
  } });
  await vault.close();

  const documents = createDocumentFilesystem({ profileId: "existing-favorites-fixture", deviceCounterId: "44",
    openStorage, profile, randomBytes, availableBytes: async () => 1024 * 1024 * 1024,
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => null,
      save: async () => {}, remove: async () => {} } });
  await documents.initialize();
  await documents.unlock("synthetic-master-password");
  assert.deepEqual((await documents.profileSettings()).folders.photos.favorites, [favorite]);
  const deviceId = (await documents.ownedDevices()).localDeviceId!;
  await documents.savePersonalSpaceSetting(["folders", "photos", "devices", deviceId],
    { favorites: [], exclusions: [] });
  assert.deepEqual((await documents.profileSettings()).folders.photos.favorites, [],
    "An explicit shared empty selection must still replace the legacy favorite");
  await documents.close();
});
