import { sha256 } from "@noble/hashes/sha2.js";
import { deriveUntrustedFolderCrypto, encryptUntrustedFilename } from "../core/model/untrusted.js";
import type { PasswordKdf } from "../core/model/passwordKdf.js";
import { createCredentialVault, type RememberedUnlockSecretStore } from "./credentialVault.js";
import { createCredentialVaultStorage, createPersonalSpaceBootstrapStorage } from "./credentialVaultStorage.js";
import { createFolderRegistry, type FolderRegistration } from "./folderRegistry.js";
import { createFolderRegistryStorage } from "./folderRegistryStorage.js";
import { createEncryptedReplicaStorage } from "./encryptedReplicaStorage.js";
import { createFolderReplica } from "./replicaStorage.js";
import { createReplicaController } from "./replicaControl.js";
import { createReplicaFileSource } from "./replicaFileSource.js";
import type { LocalFolderReplica } from "./replicaIndex.js";
import { removeAbandonedEncryptedScratch } from "./encryptedScratch.js";
import { openDocumentDraft, openDocumentDownloadDraft, recoverDocumentDrafts } from "./documentDraft.js";
import { loadEncryptedDiskMetadata, readEncryptedDiskRange } from "./encryptedFilesystem.js";
import type { createNativeFilesystem } from "./nativeFilesystem.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";
import type { CachedFileRecord } from "../ui/browserClient.js";
import { cachedFileKey, sameDeviceId } from "../ui/helpers.js";
import { deleteDocumentBaseline, loadDocumentBaseline, saveDocumentBaseline } from "./documentBaseline.js";
import { clearFavoriteRenames, loadFavoriteSyncState, recordFavoriteRename,
  removeFavoriteSyncEntry, saveFavoriteSyncEntries, type FavoriteSyncEntry } from "./documentFavoriteState.js";
import { classifyFavoritePath } from "../ui/favoriteSelection.js";
import { defaultFolderSettings, type SyncpeerProfileSettings } from "./profileSettings.js";
import { cacheQuotaBytes, planCacheEvictions } from "./profileSettings.js";
import { planVersionRemovals } from "./folderSync.js";
import { loadCacheAccess, loadDirectorySnapshot, saveCacheAccess,
  saveDirectorySnapshot, type StoredDirectorySnapshot } from "./documentPrivateRecords.js";
import { createPersonalSpaceSettingsJournal } from "./personalSpaceSettingsJournal.js";
import { materializePersonalSpaceSettings } from "./personalSpaceSettings.js";
import { resolvePersonalSpaceChanges } from "./personalSpaceChanges.js";
import { createSpaceMembershipJournal } from "./spaceMembershipJournal.js";
import type { PersonalSpaceChange } from "./personalSpaceChanges.js";
import { resolveFolderShareDevices, settingsFolderDevices,
  type OwnedDeviceIdentity, type OwnedSpaceDevice } from "./personalSpaceSharing.js";
import { authorizeReplicaRelease, defaultFolderRetentionPolicy, folderManifestDigestFromBep,
  verifyLocalReplicaManifest, verifyRemoteReplicaManifest, type FolderRetentionPolicy,
  type LocalReleaseRecord } from "./folderRetention.js";
import { folderRetentionPolicyFromSettings } from "./personalSpaceSettings.js";
import { purgePrivateReplicaContents } from "./replicaPurge.js";
import type { SyncpeerSessionHandle } from "../client.js";

type NativeFs = Awaited<ReturnType<typeof createNativeFilesystem>>;
type Vault = ReturnType<typeof createCredentialVault>;
type FolderRegistry = ReturnType<typeof createFolderRegistry>;
type ReplicaFileSource = Awaited<ReturnType<typeof createReplicaFileSource>>;
type DocumentDraft = Awaited<ReturnType<typeof openDocumentDraft>>;

interface DocumentFilesystemOptions {
  profileId: string;
  deviceCounterId: string;
  profile: NativeFs;
  openStorage: (id: string) => Promise<NativeFs>;
  rememberedSecret: RememberedUnlockSecretStore;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
  availableBytes: () => Promise<number>;
  /** Defaults to the in-process scrypt derivation; platforms may inject a worker. */
  kdf?: PasswordKdf;
}

interface DocumentHandle {
  documentId: string;
  reader?: ReplicaFileSource;
  writer?: DocumentDraft;
  dirty: boolean;
  append?: boolean;
  download?: { size: number; modifiedMs: number; ranges: Array<{ offset: number; end: number }> };
}

interface DownloadMetadata {
  encrypted: boolean;
  sourceDeviceId?: string;
  contentId?: string;
}

interface CacheCandidate {
  key: string;
  sizeBytes: number;
  lastAccessedMs: number;
  protected: boolean;
  folder: FolderRegistration;
  path: string;
}

interface DocumentRuntime {
  readonly options: DocumentFilesystemOptions;
  configs: ReturnType<typeof createFolderRegistryStorage>;
  readonly storage: Map<string, NativeFs>;
  readonly folderKeys: Map<string, Uint8Array>;
  readonly handles: Map<number, DocumentHandle>;
  readonly recoveryIssues: Map<string, string[]>;
  settingsFolder?: { id: string; replica: LocalFolderReplica; close: () => Promise<void> };
  vault: Vault;
  registry: FolderRegistry | undefined;
  nextHandle: number;
  closed: boolean;
  queue: Promise<void>;
  closeTask: Promise<void> | undefined;
}

const randomStorageId = async (runtime: DocumentRuntime): Promise<string> =>
  [...await runtime.options.randomBytes(16)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

const createVersionId = async (runtime: DocumentRuntime): Promise<string> =>
  `${Date.now()}-${await randomStorageId(runtime)}`;

const versionTime = (path: string): number | null => {
  const match = /^\.stversions\/(\d{13})-[a-f0-9]{32}$/.exec(path);
  return match ? Number(match[1]) : null;
};

const toEntry = (
  folder: FolderRegistration,
  path: string,
  size: number,
  directory: boolean,
  modifiedMs = 0,
) => ({
  id: JSON.stringify([folder.storageId, path]),
  name: path ? path.split("/").at(-1)! : folder.label,
  size,
  directory,
  modifiedMs,
});

const assertRanges = (ranges: readonly { offset: number; size: number }[]): void => {
  if (ranges.length > 256 || ranges.some(range => !Number.isSafeInteger(range.offset) || range.offset < 0 ||
    !Number.isSafeInteger(range.size) || range.size < 0 || !Number.isSafeInteger(range.offset + range.size))) {
    throw new Error("Invalid document ranges.");
  }
};

const hashReplicaFile = async (replica: LocalFolderReplica, path: string): Promise<string> => {
  const source = await createReplicaFileSource(replica, path), hash = sha256.create();
  for (let offset = 0; offset < source.size; offset += 131072) {
    const data = await source.readRange(offset, Math.min(131072, source.size - offset));
    try { hash.update(data); } finally { data.fill(0); }
  }
  return [...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

const removeReplicaPaths = async (
  replica: LocalFolderReplica,
  folderId: string,
  paths: readonly string[],
): Promise<void> => {
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    const current = (await replica.scan()).find(value => value.name === path && !value.deleted);
    if (!current) continue;
    await replica.edit!({ method: "delete", folderId, path,
      modifiedMs: Date.now(), expectedVersion: current.version ?? {} });
  }
};

const runQueued = <T>(runtime: DocumentRuntime, fn: () => Promise<T>): Promise<T> => {
  const task = runtime.queue.then(() => {
    if (runtime.closed) throw new Error("Documents are closed.");
    return fn();
  });
  runtime.queue = task.then(() => {}, () => {});
  return task;
};

const revokeAccess = async (runtime: DocumentRuntime): Promise<void> => {
  const pending = [...runtime.handles.values()]; runtime.handles.clear();
  const results = await Promise.allSettled(pending.map(handle => handle.writer?.close()));
  const settingsResult = await Promise.allSettled([runtime.settingsFolder?.close()]);
  runtime.settingsFolder = undefined;
  const registryResult = await Promise.allSettled([runtime.registry?.close()]);
  runtime.registry = undefined;
  // A failed controller/storage close must never retain unlocked folder keys.
  for (const key of runtime.folderKeys.values()) key.fill(0);
  runtime.folderKeys.clear();
  const storageResults = await Promise.allSettled([...runtime.storage.values()].map(bytes => bytes.close()));
  runtime.storage.clear();
  const errors = [...results, ...settingsResult, ...registryResult, ...storageResults]
    .filter(result => result.status === "rejected");
  if (errors.length) throw new Error("Some document handles could not be closed.");
};

const settingsStorageId = (folderId: string) =>
  [...sha256(new TextEncoder().encode(`syncpeer.personal-settings-storage.v1:${folderId}`)).slice(0, 16)]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");

const reconcileSpaceDeviceMembership = async (runtime: DocumentRuntime) => {
  if (!runtime.settingsFolder) throw new Error("Personal-space settings storage is unavailable.");
  let local = await runtime.vault.spaceDeviceMembership();
  if (!local) return null;
  const journal = createSpaceMembershipJournal(runtime.settingsFolder.replica, runtime.settingsFolder.id);
  const remote = await journal.load();
  for (let index = 0; index < Math.min(remote.length, local.trust.updates.length); index++) {
    if (remote[index].hash !== local.trust.updates[index].hash) throw new Error("Trusted device list fork detected.");
  }
  if (remote.length > local.trust.updates.length) {
    await runtime.vault.acceptSpaceDeviceMembership({ genesisKey: local.trust.genesisKey,
      knownHead: remote.at(-1)!.hash, updates: remote });
    local = (await runtime.vault.spaceDeviceMembership())!;
  } else if (remote.length < local.trust.updates.length) {
    await journal.appendMissing(local.trust.updates, local.localDeviceId);
  }
  return local;
};

const openPersonalSpaceFolder = async (runtime: DocumentRuntime): Promise<void> => {
  const descriptor = await runtime.vault.personalSpaceFolder();
  if (!descriptor || runtime.settingsFolder?.id === descriptor.id) return;
  await runtime.settingsFolder?.close();
  runtime.settingsFolder = undefined;
  const crypto = await deriveUntrustedFolderCrypto(descriptor.id, descriptor.password, runtime.options.kdf);
  let bytes: NativeFs | undefined;
  try {
    bytes = await runtime.options.openStorage(settingsStorageId(descriptor.id));
    await bytes.initializeReplica();
    await bytes.withLock(() => removeAbandonedEncryptedScratch(bytes!));
    const encrypted = createEncryptedReplicaStorage(bytes, {
      folderKey: crypto.folderKey, randomBytes: runtime.options.randomBytes,
      withLock: bytes.withLock, checkHealth: bytes.checkHealth, archive: async () => {},
    });
    const replica = createReplicaController(createFolderReplica(
      encrypted, runtime.options.deviceCounterId, sha256));
    await replica.scan();
    runtime.settingsFolder = { id: descriptor.id, replica, close: async () => {
      try { await bytes!.close(); } finally { crypto.folderKey.fill(0); }
    } };
    await reconcileSpaceDeviceMembership(runtime);
  } catch (error) {
    runtime.settingsFolder = undefined;
    crypto.folderKey.fill(0);
    await bytes?.close().catch(() => undefined);
    throw error;
  }
};

const openFolderStorage = async (
  runtime: DocumentRuntime,
  folder: FolderRegistration,
  folderKey: Uint8Array,
): Promise<NativeFs> => {
  let bytes: NativeFs;
  try { bytes = await runtime.options.openStorage(folder.storageId); }
  catch (error) { folderKey.fill(0); throw error; }
  try {
    await bytes.initializeReplica();
    await bytes.withLock(() => removeAbandonedEncryptedScratch(bytes));
    return bytes;
  } catch (error) { folderKey.fill(0); await bytes.close(); throw error; }
};

const pruneStoredVersions = async (
  bytes: NativeFs,
  storedPath: string,
  versioning: "trash" | "simple" | "staggered",
): Promise<void> => {
  const roots = await bytes.listDirectory(".stversions");
  const versions = (await Promise.all(roots.map(async root => {
    const createdMs = root.type === "directory" ? versionTime(root.path) : null;
    return createdMs === null || !await bytes.stat(`${root.path}/${storedPath}`)
      ? null : { id: root.path, createdMs };
  }))).filter((version): version is { id: string; createdMs: number } => version !== null);
  for (const root of planVersionRemovals(versions, {
    externalDeletion: "ignore", versioning,
    ...(versioning === "staggered" ? { maxAgeMs: 365 * 86_400_000 } : {}),
  }, Date.now())) {
    await bytes.remove(`${root}/${storedPath}`, false);
    if ((await bytes.listDirectory(root)).length === 0) await bytes.remove(root, true);
  }
};

const createArchiveVersion = (
  runtime: DocumentRuntime,
  folder: FolderRegistration,
  bytes: NativeFs,
) => async (path: string, originalPath: string): Promise<void> => {
  const settings = await effectiveProfileSettings(runtime);
  const folderSettings = settings.folders[folder.id] ?? defaultFolderSettings();
  const selection = classifyFavoritePath({ folderId: folder.id, path: originalPath, kind: "file" },
    folderSettings.favorites, folderSettings.exclusions, folderSettings.ignorePatterns);
  if (selection.status !== "favorite" || settings.profile.versioning === "disabled") return;
  if (!await bytes.stat(".stversions")) await bytes.makeDirectory(".stversions");
  const versionRoot = ".stversions/" + await createVersionId(runtime);
  await bytes.makeDirectory(versionRoot);
  // The original ciphertext path is needed to decrypt archived metadata.
  await bytes.copy(path, versionRoot + "/" + path);
  await pruneStoredVersions(bytes, path, settings.profile.versioning);
};

const makeFolderClose = (
  runtime: DocumentRuntime,
  folder: FolderRegistration,
  bytes: NativeFs,
  folderKey: Uint8Array,
) => async (): Promise<void> => {
  try { await bytes.close(); } finally {
    folderKey.fill(0); runtime.folderKeys.delete(folder.storageId); runtime.storage.delete(folder.storageId);
  }
};

const openFolderRuntime = async (
  runtime: DocumentRuntime,
  folder: FolderRegistration,
) => {
  const password = await runtime.vault.folderPassword(folder.id);
  if (!password) throw new Error("Folder credentials are unavailable.");
  const crypto = await deriveUntrustedFolderCrypto(folder.id, password, runtime.options.kdf);
  const bytes = await openFolderStorage(runtime, folder, crypto.folderKey);
  try {
    const encrypted = createEncryptedReplicaStorage(bytes, {
      folderKey: crypto.folderKey,
      randomBytes: runtime.options.randomBytes,
      withLock: bytes.withLock,
      checkHealth: bytes.checkHealth,
      archive: createArchiveVersion(runtime, folder, bytes),
    });
    const replica = createReplicaController(createFolderReplica(encrypted, runtime.options.deviceCounterId, sha256));
    await replica.scan();
    runtime.recoveryIssues.set(folder.storageId, await recoverDocumentDrafts(bytes, {
      folderId: folder.id, folderKey: crypto.folderKey, replica, randomBytes: runtime.options.randomBytes,
    }));
    runtime.storage.set(folder.storageId, bytes);
    runtime.folderKeys.set(folder.storageId, crypto.folderKey);
    return { replica, close: makeFolderClose(runtime, folder, bytes, crypto.folderKey) };
  } catch (error) { crypto.folderKey.fill(0); await bytes.close(); throw error; }
};

const openRegisteredFolders = async (runtime: DocumentRuntime): Promise<void> => {
  if (runtime.vault.status().phase !== "unlocked") return;
  await openPersonalSpaceFolder(runtime);
  runtime.registry ??= createFolderRegistry({
    ...runtime.configs,
    commitRelease: (folders, record) => runtime.vault.commitLocalRelease(record, folders),
    open: (folder) => openFolderRuntime(runtime, folder),
  });
  await runtime.registry.initialize();
  for (const release of await runtime.vault.pendingLocalReleases()) {
    const id = release.kind === "safe" ? release.proposal.folderId : release.exception.folderId;
    const folder = runtime.registry.getState().find(value => value.id === id && value.browseOnly);
    if (!folder) throw new Error("Pending local release has no browse-only folder registration.");
    const storage = await runtime.options.openStorage(folder.storageId);
    try { await purgePrivateReplicaContents(storage); }
    finally { await storage.close(); }
    await runtime.vault.completeLocalRelease(id);
  }
  if (runtime.vault.status().phase === "unlocked") {
    for (const folder of runtime.registry.getState()) {
      if (!folder.browseOnly && await runtime.vault.folderPassword(folder.id)) await runtime.registry.open(folder.id);
    }
  }
};

const documentStatus = async (runtime: DocumentRuntime) => ({
  vault: runtime.vault.status(),
  folders: runtime.vault.status().phase === "unlocked" ? await runtime.configs.load() : [],
  pendingLocalReleases: runtime.vault.status().phase === "unlocked"
    ? (await runtime.vault.pendingLocalReleases()).map(record => record.kind === "safe"
      ? record.proposal.folderId : record.exception.folderId) : [],
  recoveryIssues: [...runtime.recoveryIssues.values()].flat(),
});

const initializeFilesystem = async (runtime: DocumentRuntime) => {
  await runtime.options.profile.initializeReplica();
  await runtime.vault.initialize();
  await openRegisteredFolders(runtime);
  return documentStatus(runtime);
};

const closeFilesystem = (runtime: DocumentRuntime): Promise<void> => {
  runtime.closed = true;
  runtime.closeTask ??= runtime.queue.then(async () => {
    await runtime.vault.close();
    await runtime.options.profile.close();
  });
  return runtime.closeTask;
};

const resolveDocument = (runtime: DocumentRuntime, id: string) => {
  if (runtime.vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
  const decoded: unknown = JSON.parse(id);
  if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some(part => typeof part !== "string")) {
    throw new Error("Invalid document ID.");
  }
  const [storageId, path] = decoded as [string, string];
  if (path) { assertReplicaPath(path); if (isInternalReplicaPath(path)) throw new Error("Private document."); }
  const folder = runtime.registry?.getState().find(folder => folder.storageId === storageId);
  if (!folder) throw new Error("Document folder is unavailable.");
  const replica = runtime.registry!.getReplica(folder.id);
  if (!replica) throw new Error("Document folder is not open.");
  return { folder, replica, path, bytes: runtime.storage.get(storageId)! };
};

const documentStat = async (runtime: DocumentRuntime, id: string) => {
  const { folder, path, replica } = resolveDocument(runtime, id);
  if (!path) return toEntry(folder, "", 0, true);
  const info = (await replica.scan()).find(file => file.name === path && !file.deleted && !file.invalid);
  if (!info || ![0, 1].includes(Number(info.type ?? 0))) throw new Error("Document is unavailable.");
  return toEntry(folder, path, Number(info.size ?? 0), info.type === 1, Number(info.modified_s ?? 0) * 1000);
};

const openWritableDraft = async (
  runtime: DocumentRuntime,
  id: string,
  truncate: boolean,
) => {
  const { folder, replica, path, bytes } = resolveDocument(runtime, id);
  return openDocumentDraft(bytes, { folderId: folder.id, path, truncate, replica,
    folderKey: runtime.folderKeys.get(folder.storageId)!, randomBytes: runtime.options.randomBytes });
};

const requireHandle = (runtime: DocumentRuntime, id: number): DocumentHandle => {
  const found = runtime.handles.get(id);
  if (!found) throw new Error("Document handle is closed.");
  return found;
};

const writeToHandle = async (
  runtime: DocumentRuntime,
  id: number,
  offset: number,
  bytes: Uint8Array,
): Promise<void> => {
  const value = requireHandle(runtime, id);
  if (!value.writer) throw new Error("Document is read only.");
  if (value.download && offset + bytes.length > value.download.size) {
    throw new Error("Download write exceeds expected size.");
  }
  await value.writer.write(value.append ? await value.writer.size() : offset, bytes); value.dirty = true;
  if (value.download && bytes.length) {
    value.download.ranges = value.writer.downloadRanges();
  }
};

const touchCachedFile = async (
  runtime: DocumentRuntime,
  folder: FolderRegistration,
  path: string,
): Promise<void> => {
  if (!folder.downloads) return;
  const bytes = runtime.storage.get(folder.storageId)!, key = runtime.folderKeys.get(folder.storageId)!;
  const access = await loadCacheAccess(bytes, key);
  access[path] = Date.now();
  await saveCacheAccess(bytes, key, runtime.options.randomBytes, access);
};

const openArchivedSource = async (
  runtime: DocumentRuntime,
  storageId: string,
  path: string,
  versionId: string,
) => {
  if (!/^(?:\d{13}-)?[a-f0-9]{32}$/.test(versionId)) throw new Error("Invalid document version.");
  const bytes = runtime.storage.get(storageId)!;
  const key = runtime.folderKeys.get(storageId)!;
  const encrypted = await encryptUntrustedFilename(key, path);
  const archivePath = `.stversions/${versionId}/${encrypted}`;
  const stat = await bytes.stat(archivePath);
  if (!stat || stat.type !== "file") throw new Error("Document version is unavailable.");
  const source = { size: stat.size, readRange: (offset: number, size: number) => bytes.readRange(archivePath, offset, size) };
  const metadata = await loadEncryptedDiskMetadata(source, encrypted, key);
  if (metadata.fileInfo.name !== path) { metadata.fileKey.fill(0); throw new Error("Document version does not match this path."); }
  return { source, metadata };
};

const requireUnlockedRegistry = (runtime: DocumentRuntime): FolderRegistry => {
  if (runtime.vault.status().phase !== "unlocked" || !runtime.registry) {
    throw new Error("Document vault is locked.");
  }
  return runtime.registry;
};

const findVisibleFolder = (
  runtime: DocumentRuntime,
  folderId: string,
): FolderRegistration | null => {
  const registry = requireUnlockedRegistry(runtime);
  const folder = registry.getState().find(value => value.id === folderId);
  return folder && registry.getReplica(folderId) ? folder : null;
};

const favoriteStateTarget = (runtime: DocumentRuntime, folderId: string) => {
  const registry = requireUnlockedRegistry(runtime);
  const folder = registry.getState().find(value => value.id === folderId);
  const bytes = folder ? runtime.storage.get(folder.storageId) : undefined;
  const key = folder ? runtime.folderKeys.get(folder.storageId) : undefined;
  if (!folder || !bytes || !key || !registry.getReplica(folderId)) throw new Error("Document folder is not open.");
  return { bytes, key };
};

const rememberFolderAction = async (
  runtime: DocumentRuntime,
  folder: { id: string; label: string },
) => {
  if (!runtime.registry) throw new Error("Folder storage is unavailable.");
  if (!runtime.registry.getState().some(value => value.id === folder.id)) {
    await runtime.registry.add({ ...folder, storageId: await randomStorageId(runtime) }, false);
  }
  return documentStatus(runtime);
};

const assertNoPendingLocalRelease = async (runtime: DocumentRuntime, folderId: string) => {
  const pending = await runtime.vault.pendingLocalReleases();
  if (pending.some(record => (record.kind === "safe" ? record.proposal.folderId : record.exception.folderId) === folderId)) {
    throw new Error("Complete the pending local release cleanup before reopening this folder.");
  }
};

const registerFolderAction = async (
  runtime: DocumentRuntime,
  folder: { id: string; label: string; password?: string },
  publishCredential = true,
) => {
  if (!runtime.registry) throw new Error("Folder storage is unavailable.");
  await assertNoPendingLocalRelease(runtime, folder.id);
  if (!folder.id.trim() || !folder.label.trim() || folder.id !== folder.id.trim() || folder.label !== folder.label.trim()) {
    throw new Error("Invalid folder registration.");
  }
  const existing = await runtime.vault.folderPassword(folder.id);
  if (existing === null) await runtime.vault.addFolder(folder.id, folder.password);
  else if (folder.password !== undefined && folder.password !== existing) {
    throw new Error("Folder password changes require migration.");
  }
  if (runtime.registry.getState().some(value => value.id === folder.id)) await runtime.registry.open(folder.id);
  else await runtime.registry.add({ id: folder.id, label: folder.label, storageId: await randomStorageId(runtime) });
  if (publishCredential) await publishSharedFolderCredential(runtime, folder.id, folder.label);
  return documentStatus(runtime);
};

const unlockAfterVaultChange = async (
  runtime: DocumentRuntime,
  change: () => Promise<unknown>,
) => {
  await change();
  await openRegisteredFolders(runtime);
  return documentStatus(runtime);
};

const attachDownloadsAction = async (runtime: DocumentRuntime, id: string): Promise<void> => {
  if (runtime.vault.status().phase !== "unlocked" || !runtime.registry) {
    throw new Error("Document vault is locked.");
  }
  await assertNoPendingLocalRelease(runtime, id);
  await runtime.registry.attachDownloads(id);
};

const detachDownloadsAction = async (runtime: DocumentRuntime, id: string) => {
  if (runtime.vault.status().phase !== "unlocked" || !runtime.registry) {
    throw new Error("Document vault is locked.");
  }
  await runtime.registry.detachDownloads(id);
  return documentStatus(runtime);
};

const loadDirectorySnapshotAction = async (
  runtime: DocumentRuntime,
  folderId: string,
  sourceDeviceId: string,
  path: string,
) => {
  const folder = findVisibleFolder(runtime, folderId);
  if (!folder) return null;
  assertReplicaPath(path || "root");
  return loadDirectorySnapshot(
    runtime.storage.get(folder.storageId)!,
    runtime.folderKeys.get(folder.storageId)!,
    sourceDeviceId,
    path,
  );
};

const saveDirectorySnapshotAction = async (
  runtime: DocumentRuntime,
  folderId: string,
  sourceDeviceId: string,
  path: string,
  snapshot: StoredDirectorySnapshot,
) => {
  const folder = findVisibleFolder(runtime, folderId);
  if (!folder) throw new Error("Document folder is unavailable.");
  assertReplicaPath(path || "root");
  await saveDirectorySnapshot(runtime.storage.get(folder.storageId)!, {
    folderKey: runtime.folderKeys.get(folder.storageId)!,
    randomBytes: runtime.options.randomBytes, sourceDeviceId, path, snapshot,
  });
};

const cachedFilesAction = async (
  runtime: DocumentRuntime,
  folderId?: string,
): Promise<CachedFileRecord[]> => {
  if (runtime.vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
  const files: CachedFileRecord[] = [];
  for (const folder of runtime.registry!.getState().filter(folder =>
    !folder.browseOnly && (folderId ? folder.id === folderId : folder.downloads))) {
    for (const info of await runtime.registry!.getReplica(folder.id)!.scan()) {
      if (info.deleted || info.invalid || Number(info.type ?? 0) !== 0) continue;
      const modifiedMs = Number(info.modified_s ?? 0) * 1000 + Number(info.modified_ns ?? 0) / 1000000;
      files.push({ key: cachedFileKey(folder.id, info.name), folderId: folder.id, path: info.name,
        name: info.name.split("/").at(-1)!, sizeBytes: Number(info.size ?? 0), modifiedMs, cachedAtMs: modifiedMs,
        localPath: "syncpeer-document:" + JSON.stringify([folder.storageId, info.name]),
        syncBaselineRequired: true,
        syncBaseline: await loadDocumentBaseline(runtime.storage.get(folder.storageId)!, runtime.folderKeys.get(folder.storageId)!, info.name) });
    }
  }
  return files;
};

const digestCachedFilesAction = async (
  runtime: DocumentRuntime,
  files: readonly { folderId: string; path: string }[],
) => {
  if (runtime.vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
  const folders = new Set(runtime.registry!.getState().filter(folder => folder.downloads).map(folder => folder.id));
  const digests: Array<{ folderId: string; path: string; hash: string }> = [];
  for (const file of files) {
    if (!folders.has(file.folderId)) throw new Error("Downloads are not attached.");
    assertReplicaPath(file.path);
    if (isInternalReplicaPath(file.path)) throw new Error("Private document.");
    const replica = runtime.registry!.getReplica(file.folderId)!;
    digests.push({ ...file, hash: await hashReplicaFile(replica, file.path) });
  }
  return digests;
};

const cachedStatusesAction = async (
  runtime: DocumentRuntime,
  folderId: string,
  paths: string[],
) => {
  if (runtime.vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
  const folder = runtime.registry!.getState().find(folder => folder.id === folderId && folder.downloads);
  if (!folder) throw new Error("Downloads are not attached.");
  const files = await runtime.registry!.getReplica(folderId)!.scan();
  return paths.map(path => {
    if (path) { assertReplicaPath(path); if (isInternalReplicaPath(path)) throw new Error("Private document."); }
    const file = files.find(file => file.name === path && !file.deleted && !file.invalid);
    const available = !path || !!file;
    return { path, available, localPath: available ? "syncpeer-document:" + JSON.stringify([folder.storageId, path]) : undefined,
      cachedAtMs: file ? Number(file.modified_s ?? 0) * 1000 : undefined };
  });
};

const removeDocumentAction = async (runtime: DocumentRuntime, id: string) => {
  const file = resolveDocument(runtime, id);
  const current = await file.replica.scan();
  const old = current.find(info => info.name === file.path && !info.deleted);
  if (!old) return false;
  const paths = old.type === 1
    ? current.filter(info => !info.deleted && (info.name === file.path || info.name.startsWith(file.path + "/")))
      .map(info => info.name)
    : [file.path];
  await removeReplicaPaths(file.replica, file.folder.id, paths);
  return true;
};

const recordRenamedFavorite = async (
  runtime: DocumentRuntime,
  folder: { id: string; storageId: string },
  from: string,
  to: string,
): Promise<void> => {
  const settings = await effectiveProfileSettings(runtime);
  const selected = settings.folders[folder.id]?.favorites.some(item => item.path === from);
  if (!selected) return;
  const bytes = runtime.storage.get(folder.storageId), key = runtime.folderKeys.get(folder.storageId);
  if (!bytes || !key) throw new Error("Document folder is not open.");
  await recordFavoriteRename(bytes, { folderKey: key, randomBytes: runtime.options.randomBytes },
    { from, to, atMs: Date.now() });
};

/** Copies every descendant to the new prefix, then tombstones the old paths.
 * A partial copy is cleaned up before the error is surfaced.
 */
const renameDirectoryAction = async (
  runtime: DocumentRuntime,
  file: ReturnType<typeof resolveDocument>,
  descendants: Awaited<ReturnType<LocalFolderReplica["scan"]>>,
  target: string,
  modifiedMs: number,
): Promise<void> => {
  const sourcePrefix = file.path + "/", created: string[] = [];
  const fail = async (error: unknown): Promise<never> => {
    await removeReplicaPaths(file.replica, file.folder.id, created).catch(() => {});
    throw error;
  };
  try {
    await file.replica.edit!({ method: "mkdir", folderId: file.folder.id, path: target, modifiedMs, expectedVersion: null });
    created.push(target);
    for (const info of [...descendants].sort((left, right) => left.name.length - right.name.length)) {
      const next = target + "/" + info.name.slice(sourcePrefix.length);
      if (info.type === 1) {
        await file.replica.edit!({ method: "mkdir", folderId: file.folder.id, path: next, modifiedMs, expectedVersion: null });
      } else {
        await file.replica.edit!({ method: "write", folderId: file.folder.id, path: next, modifiedMs, expectedVersion: null,
          source: await createReplicaFileSource(file.replica, info.name) });
      }
      created.push(next);
    }
  } catch (error) { await fail(error); }
  try {
    await removeReplicaPaths(file.replica, file.folder.id,
      [...descendants].map(info => info.name).concat(file.path));
  } catch (error) { await fail(error); }
};

const renameDocumentAction = async (runtime: DocumentRuntime, id: string, name: string) => {
  assertReplicaPath(name);
  if (name.includes("/")) throw new Error("Expected one document name.");
  const file = resolveDocument(runtime, id), current = await file.replica.scan();
  const old = current.find(info => info.name === file.path && !info.deleted);
  if (!old) throw new Error("Document is unavailable.");
  const parent = file.path.split("/").slice(0, -1).join("/"), target = parent ? `${parent}/${name}` : name;
  if (target === file.path) return documentStat(runtime, id);
  const previousTarget = current.find(info => info.name === target);
  if (previousTarget && !previousTarget.deleted) throw new Error("A document with that name already exists.");
  const modifiedMs = Date.now();
  if (old.type === 1) {
    const descendants = current.filter(info => !info.deleted && info.name.startsWith(file.path + "/"));
    await renameDirectoryAction(runtime, file, descendants, target, modifiedMs);
    await recordRenamedFavorite(runtime, file.folder, file.path, target);
    return documentStat(runtime, JSON.stringify([file.folder.storageId, target]));
  }
  const created = await file.replica.edit!({ method: "write", folderId: file.folder.id, path: target, modifiedMs,
    expectedVersion: previousTarget?.version ?? null, source: await createReplicaFileSource(file.replica, file.path) });
  try {
    await file.replica.edit!({ method: "delete", folderId: file.folder.id, path: file.path,
      modifiedMs, expectedVersion: old.version ?? {} });
  } catch (error) {
    await file.replica.edit!({ method: "delete", folderId: file.folder.id, path: target,
      modifiedMs, expectedVersion: created.version ?? {} }).catch(() => {});
    throw error;
  }
  await recordRenamedFavorite(runtime, file.folder, file.path, target);
  return documentStat(runtime, JSON.stringify([file.folder.storageId, target]));
};

const statById = async (runtime: DocumentRuntime, id: string) => {
  const root = (await runtime.configs.load()).find(folder => id === JSON.stringify([folder.storageId, ""]));
  return root ? toEntry(root, "", 0, true) : documentStat(runtime, id);
};

const listEntriesAction = async (runtime: DocumentRuntime, id: string) => {
  if (id === "syncpeer-root") return (await runtime.configs.load()).map(folder => toEntry(folder, "", 0, true));
  if (runtime.vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
  const root = runtime.registry!.getState().find(folder => id === JSON.stringify([folder.storageId, ""]));
  if (root && !runtime.registry!.getReplica(root.id)) return [];
  const { folder, path, replica } = resolveDocument(runtime, id);
  if (!(await documentStat(runtime, id)).directory) throw new Error("Document is not a directory.");
  const prefix = path ? path + "/" : "";
  return (await replica.scan()).filter(file => !file.deleted && !file.invalid && [0, 1].includes(Number(file.type ?? 0)) &&
    file.name.startsWith(prefix) && !file.name.slice(prefix.length).includes("/") && file.name !== path)
    .map(file => toEntry(folder, file.name, Number(file.size ?? 0), file.type === 1, Number(file.modified_s ?? 0) * 1000));
};

const createEntryAction = async (
  runtime: DocumentRuntime,
  parentId: string,
  name: string,
  directory: boolean,
) => {
  assertReplicaPath(name); if (name.includes("/")) throw new Error("Expected one document name.");
  const parent = resolveDocument(runtime, parentId), path = parent.path ? parent.path + "/" + name : name;
  if (!(await documentStat(runtime, parentId)).directory) throw new Error("Parent is not a directory.");
  await parent.replica.edit!({ folderId: parent.folder.id, path, modifiedMs: Date.now(), expectedVersion: null,
    ...(directory ? { method: "mkdir" as const } : { method: "write" as const, source: { size: 0, readRange: async () => new Uint8Array() } }) });
  return documentStat(runtime, JSON.stringify([parent.folder.storageId, path]));
};

const assertDownloadRequest = (
  runtime: DocumentRuntime,
  size: number,
  modifiedMs: number,
  path: string,
): void => {
  if (runtime.vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
  if (runtime.handles.size >= 64) throw new Error("Too many open documents.");
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(modifiedMs) || modifiedMs < 0) {
    throw new Error("Invalid download metadata.");
  }
  assertReplicaPath(path);
};

const assertExpectedLocalHash = async (
  replica: LocalFolderReplica,
  path: string,
  expectedLocalHash: string | null,
): Promise<void> => {
  const current = (await replica.scan()).find(info => info.name === path && !info.deleted);
  if (expectedLocalHash === null) {
    if (current) throw new Error("Local document changed before download began.");
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(expectedLocalHash) || !current) {
    throw new Error("Local document changed before download began.");
  }
  if (await hashReplicaFile(replica, path) !== expectedLocalHash) {
    throw new Error("Local document changed before download began.");
  }
};

const ensureDownloadParents = async (
  replica: LocalFolderReplica,
  folderId: string,
  path: string,
  modifiedMs: number,
): Promise<void> => {
  const parts = path.split("/");
  for (let count = 1; count < parts.length; count++) {
    const parent = parts.slice(0, count).join("/");
    const old = (await replica.scan()).find(info => info.name === parent);
    if (!old || old.deleted) await replica.edit!({ method: "mkdir", folderId, path: parent,
      expectedVersion: old?.version ?? null, modifiedMs });
    else if (old.type !== 1) throw new Error("Download parent is not a directory.");
  }
};

const openExistingReader = async (
  replica: LocalFolderReplica,
  path: string,
  writer: DocumentDraft,
): Promise<ReplicaFileSource | undefined> => {
  const old = (await replica.scan()).find(info => info.name === path && !info.deleted);
  if (!old) return undefined;
  try { return await createReplicaFileSource(replica, path); }
  catch (error) { await writer.discard(); throw error; }
};

const beginDownloadAction = async (
  runtime: DocumentRuntime,
  folderId: string,
  path: string,
  size: number,
  modifiedMs: number,
  expectedLocalHash: string | null | undefined,
  metadata: DownloadMetadata,
): Promise<number> => {
  assertDownloadRequest(runtime, size, modifiedMs, path);
  const folder = runtime.registry?.getState().find(folder => folder.id === folderId);
  if (!folder) throw new Error("Document folder is unavailable.");
  const documentId = JSON.stringify([folder.storageId, path]);
  const file = resolveDocument(runtime, documentId);
  if (expectedLocalHash !== undefined) await assertExpectedLocalHash(file.replica, path, expectedLocalHash);
  await ensureDownloadParents(file.replica, folderId, path, modifiedMs);
  const writer = await openDocumentDownloadDraft(file.bytes, { folderId, path,
    replica: file.replica, folderKey: runtime.folderKeys.get(folder.storageId)!, randomBytes: runtime.options.randomBytes,
    download: { folderId, path, sizeBytes: size, modifiedMs, encrypted: metadata.encrypted,
      ...(metadata.sourceDeviceId ? { sourceDeviceId: metadata.sourceDeviceId } : {}),
      ...(metadata.contentId ? { contentId: metadata.contentId } : {}) } });
  const reader = await openExistingReader(file.replica, path, writer);
  const id = ++runtime.nextHandle;
  runtime.handles.set(id, { documentId, writer, reader, dirty: true,
    download: { size, modifiedMs, ranges: writer.downloadRanges() } });
  return id;
};

const downloadRangesAction = async (runtime: DocumentRuntime, id: number) => {
  const value = requireHandle(runtime, id);
  if (!value.download) throw new Error("Not a download handle.");
  return value.download.ranges.map(range => ({ offset: range.offset, size: range.end - range.offset }));
};

const suspendDownloadAction = async (runtime: DocumentRuntime, id: number): Promise<void> => {
  const value = requireHandle(runtime, id);
  if (!value.download || !value.writer) throw new Error("Not a download handle.");
  runtime.handles.delete(id);
  await value.writer.close();
};

const finishDownloadAction = async (runtime: DocumentRuntime, id: number): Promise<void> => {
  const value = requireHandle(runtime, id), download = value.download;
  if (!download || !value.writer) throw new Error("Not a download handle.");
  if (await value.writer.size() !== download.size || (download.size &&
    (download.ranges.length !== 1 || download.ranges[0].offset !== 0 || download.ranges[0].end !== download.size))) {
    throw new Error("Download is incomplete.");
  }
  const hash = [...await value.writer.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
  await value.writer.flush(false, download.modifiedMs);
  const file = resolveDocument(runtime, value.documentId);
  await saveDocumentBaseline(file.bytes, { path: file.path, folderKey: runtime.folderKeys.get(file.folder.storageId)!,
    randomBytes: runtime.options.randomBytes, baseline: { hash, sizeBytes: download.size, modifiedMs: download.modifiedMs } });
  await value.writer.close(); runtime.handles.delete(id);
};

const setSyncBaselineAction = async (
  runtime: DocumentRuntime,
  id: string,
  baseline: NonNullable<CachedFileRecord["syncBaseline"]>,
): Promise<void> => {
  const file = resolveDocument(runtime, id);
  await saveDocumentBaseline(file.bytes, { path: file.path, folderKey: runtime.folderKeys.get(file.folder.storageId)!,
    randomBytes: runtime.options.randomBytes, baseline });
};

const clearSyncBaselineAction = async (runtime: DocumentRuntime, id: string): Promise<void> => {
  const file = resolveDocument(runtime, id);
  await deleteDocumentBaseline(file.bytes, file.path, runtime.folderKeys.get(file.folder.storageId)!);
};

const loadSyncBaselineAction = async (
  runtime: DocumentRuntime,
  id: string,
): Promise<NonNullable<CachedFileRecord["syncBaseline"]> | undefined> => {
  const file = resolveDocument(runtime, id);
  return loadDocumentBaseline(file.bytes, runtime.folderKeys.get(file.folder.storageId)!, file.path);
};

const digestHandleAction = async (runtime: DocumentRuntime, id: number): Promise<string> => {
  const value = requireHandle(runtime, id);
  if (!value.writer) throw new Error("Not a writable document.");
  return [...await value.writer.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

const digestRangesAction = async (
  runtime: DocumentRuntime,
  id: number,
  source: "cached" | "partial",
  ranges: readonly { offset: number; size: number }[],
) => {
  assertRanges(ranges);
  const value = requireHandle(runtime, id), file = source === "cached" ? value.reader : value.writer;
  if (!file) return [];
  const size = typeof file.size === "number" ? file.size : await file.size();
  const results: Array<{ offset: number; size: number; hash: Uint8Array }> = [];
  for (const range of ranges) {
    if (range.offset + range.size > size) continue;
    const hash = sha256.create();
    for (let done = 0; done < range.size; done += 131072) {
      const data = await file.readRange(range.offset + done, Math.min(131072, range.size - done));
      try { hash.update(data); } finally { data.fill(0); }
    }
    results.push({ ...range, hash: hash.digest() });
  }
  return results;
};

const copyRangesAction = async (
  runtime: DocumentRuntime,
  id: number,
  ranges: readonly { offset: number; size: number }[],
): Promise<void> => {
  assertRanges(ranges);
  const value = requireHandle(runtime, id);
  if (!value.download || !value.reader) throw new Error("Cached source is unavailable.");
  for (const range of ranges) {
    if (range.offset + range.size > value.reader.size) throw new Error("Cached range is unavailable.");
    for (let done = 0; done < range.size; done += 131072) {
      const data = await value.reader.readRange(range.offset + done, Math.min(131072, range.size - done));
      try { await writeToHandle(runtime, id, range.offset + done, data); } finally { data.fill(0); }
    }
  }
};

const openHandleAction = async (runtime: DocumentRuntime, id: string, mode: string): Promise<number> => {
  if (runtime.handles.size >= 64) throw new Error("Too many open documents.");
  if (!["r", "w", "wt", "wa", "rw", "rwt"].includes(mode)) throw new Error("Unsupported document mode.");
  const file = resolveDocument(runtime, id);
  if ((await documentStat(runtime, id)).directory) throw new Error("Cannot open a directory.");
  const value: DocumentHandle = { documentId: id, dirty: false, append: mode === "wa" };
  if (mode === "r") value.reader = await createReplicaFileSource(file.replica, file.path);
  else {
    value.dirty = ["w", "wt", "rwt"].includes(mode);
    value.writer = await openWritableDraft(runtime, id, value.dirty);
  }
  if (mode === "r") await touchCachedFile(runtime, file.folder, file.path);
  const idNumber = ++runtime.nextHandle; runtime.handles.set(idNumber, value); return idNumber;
};

const flushHandleAction = async (runtime: DocumentRuntime, id: number): Promise<void> => {
  const value = requireHandle(runtime, id); if (!value.writer || !value.dirty) return;
  if (value.download) throw new Error("Use download completion to publish this handle.");
  try {
    await value.writer.flush(); value.dirty = false;
  } catch (error) {
    runtime.handles.delete(id);
    await value.writer.close();
    runtime.recoveryIssues.set(resolveDocument(runtime, value.documentId).folder.storageId,
      ["An encrypted edit needs recovery. Lock and unlock the vault to recover it; its data has been retained."]);
    throw error;
  }
};

const releaseHandleAction = async (runtime: DocumentRuntime, id: number, abort = false): Promise<void> => {
  const value = requireHandle(runtime, id); runtime.handles.delete(id);
  if (abort || value.download) { await value.writer?.discard(); return; }
  try { if (value.dirty) await value.writer!.flush(); }
  catch (error) {
    runtime.recoveryIssues.set(resolveDocument(runtime, value.documentId).folder.storageId,
      ["An encrypted edit needs recovery. Lock and unlock the vault to recover it; its data has been retained."]);
    throw error;
  }
  finally { await value.writer?.close(); }
};

const collectVersion = async (
  runtime: DocumentRuntime,
  storageId: string,
  path: string,
  versionId: string,
  versions: Array<{ id: string; modifiedMs: number; sizeBytes: number }>,
): Promise<void> => {
  try {
    const archived = await openArchivedSource(runtime, storageId, path, versionId);
    try {
      versions.push({ id: versionId,
        modifiedMs: Number(archived.metadata.fileInfo.modified_s ?? 0) * 1000 +
          Number(archived.metadata.fileInfo.modified_ns ?? 0) / 1000000,
        sizeBytes: Number(archived.metadata.fileInfo.size ?? 0) });
    } finally { archived.metadata.fileKey.fill(0); }
  } catch (error) {
    if (!(error instanceof Error && /unavailable/.test(error.message))) throw error;
  }
};

const listVersionsAction = async (runtime: DocumentRuntime, id: string) => {
  const { folder, path, bytes } = resolveDocument(runtime, id);
  if (!path) throw new Error("Choose a file to view its versions.");
  const roots = await bytes.listDirectory(".stversions");
  const versions: Array<{ id: string; modifiedMs: number; sizeBytes: number }> = [];
  for (const root of roots) {
    if (root.type !== "directory" || !/^(?:\d{13}-)?[a-f0-9]{32}$/.test(root.path.slice(".stversions/".length))) continue;
    await collectVersion(runtime, folder.storageId, path, root.path.slice(".stversions/".length), versions);
  }
  return versions.sort((left, right) => right.modifiedMs - left.modifiedMs);
};

const restoreVersionAction = async (runtime: DocumentRuntime, id: string, versionId: string) => {
  const { folder, replica, path } = resolveDocument(runtime, id);
  if (!path) throw new Error("Choose a file to restore.");
  const archived = await openArchivedSource(runtime, folder.storageId, path, versionId);
  try {
    const current = (await replica.scan()).find(file => file.name === path);
    const restored = await replica.edit!({ method: "write", folderId: folder.id, path,
      expectedVersion: current?.version ?? null, modifiedMs: Date.now(), source: {
        size: Number(archived.metadata.fileInfo.size ?? 0),
        readRange: (offset, size) => readEncryptedDiskRange(archived.source, archived.metadata, offset, size),
      } });
    return { modifiedMs: Number(restored.modified_s ?? 0) * 1000 + Number(restored.modified_ns ?? 0) / 1000000,
      sizeBytes: Number(restored.size ?? 0) };
  } finally { archived.metadata.fileKey.fill(0); }
};

const collectCacheCandidates = async (
  runtime: DocumentRuntime,
  settings: Awaited<ReturnType<Vault["profileSettings"]>>,
  folder: FolderRegistration,
  candidates: CacheCandidate[],
): Promise<void> => {
  const replica = runtime.registry!.getReplica(folder.id)!;
  const bytes = runtime.storage.get(folder.storageId)!, key = runtime.folderKeys.get(folder.storageId)!;
  const access = await loadCacheAccess(bytes, key);
  const folderSettings = settings.folders[folder.id] ?? defaultFolderSettings();
  for (const info of await replica.scan()) {
    if (info.deleted || info.invalid || Number(info.type ?? 0) !== 0 || isInternalReplicaPath(info.name)) continue;
    const baseline = await loadDocumentBaseline(bytes, key, info.name);
    const selected = classifyFavoritePath({ folderId: folder.id, path: info.name, kind: "file" },
      folderSettings.favorites, folderSettings.exclusions, folderSettings.ignorePatterns);
    const unchanged = baseline !== undefined && baseline.sizeBytes === Number(info.size ?? 0) &&
      await hashReplicaFile(replica, info.name) === baseline.hash;
    candidates.push({ key: cachedFileKey(folder.id, info.name), folder, path: info.name,
      sizeBytes: Number(info.size ?? 0), lastAccessedMs: access[info.name] ??
        Number(info.modified_s ?? 0) * 1000, protected: selected.status === "favorite" || !unchanged });
  }
};

const enforceCacheQuotaAction = async (runtime: DocumentRuntime) => {
  if (runtime.vault.status().phase !== "unlocked" || !runtime.registry) {
    throw new Error("Document vault is locked.");
  }
  const settings = await effectiveProfileSettings(runtime);
  const quotaBytes = cacheQuotaBytes(await runtime.options.availableBytes(), settings.profile.cache);
  const candidates: CacheCandidate[] = [];
  for (const folder of runtime.registry.getState().filter(value => value.downloads)) {
    await collectCacheCandidates(runtime, settings, folder, candidates);
  }
  const evicted = planCacheEvictions(candidates, quotaBytes);
  for (const key of evicted) {
    const candidate = candidates.find(value => value.key === key)!;
    await removeReplicaPaths(runtime.registry.getReplica(candidate.folder.id)!, candidate.folder.id, [candidate.path]);
  }
  return { quotaBytes, cachedBytes: candidates.reduce((total, value) => total + value.sizeBytes, 0),
    protectedBytes: candidates.filter(value => value.protected).reduce((total, value) => total + value.sizeBytes, 0), evicted };
};

const createLifecycleActions = (runtime: DocumentRuntime) => ({
  initialize: () => runQueued(runtime, () => initializeFilesystem(runtime)),
  status: () => runQueued(runtime, async () => {
    if (runtime.vault.status().phase === "unlocked" && runtime.settingsFolder &&
      await runtime.vault.spaceDeviceMembership()) {
      await syncSharedFolderCredentials(runtime, await sharedSettingsContext(runtime));
    }
    return documentStatus(runtime);
  }),
  close: () => closeFilesystem(runtime),
});

const sharedSettingsContext = async (runtime: DocumentRuntime, requireActive = false) => {
  const membership = await reconcileSpaceDeviceMembership(runtime);
  if (!membership || !runtime.settingsFolder) throw new Error("Trusted personal-space settings are unavailable.");
  if (requireActive && (!membership.localDeviceId || !membership.devices.some(device =>
    device.id === membership.localDeviceId && device.state === "active"))) {
    throw new Error("An active enrolled device is required to change shared settings.");
  }
  const journal = createPersonalSpaceSettingsJournal(runtime.settingsFolder.replica, runtime.settingsFolder.id);
  const changes = await journal.load();
  const result = await materializePersonalSpaceSettings(crypto.subtle, membership.trust, changes);
  return { membership, journal, changes, result };
};

const syncSharedFolderCredentials = async (runtime: DocumentRuntime,
  context: Awaited<ReturnType<typeof sharedSettingsContext>>) => {
  if (!context.result.settings) return;
  for (const [id, folder] of Object.entries(context.result.settings.folders)) {
    if (!folder.credential) continue;
    const existing = await runtime.vault.folderPassword(id);
    if (existing && existing !== folder.credential.password) {
      throw new Error("A shared folder credential conflicts with this device's existing folder; no data was replaced.");
    }
    if (existing !== null && runtime.registry?.getState().some(value => value.id === id)) continue;
    await registerFolderAction(runtime, { id, ...folder.credential }, false);
  }
};

const publishSharedFolderCredential = async (runtime: DocumentRuntime, id: string, label: string) => {
  if (!runtime.settingsFolder || !await runtime.vault.spaceDeviceMembership()) return;
  const context = await sharedSettingsContext(runtime, true);
  if (context.result.conflicts.length) throw new Error("Resolve shared-settings conflicts before sharing a folder.");
  const password = await runtime.vault.folderPassword(id);
  if (!password) throw new Error("Registered folder credentials are unavailable.");
  const credential = { label, password };
  const prior = context.result.settings?.folders[id]?.credential;
  if (prior) {
    if (prior.password !== password) throw new Error("A different shared folder credential already exists.");
    return;
  }
  await appendSharedEdit(runtime, context, {
    path: ["folders", id, "credential"], parents: [], value: credential,
  });
};

type ReleaseRequest = { mode: "dangerous"; confirmedText: string } |
  { mode: "safe"; sessions: readonly Pick<SyncpeerSessionHandle, "remoteDeviceId" | "remoteFs" | "isClosed">[] };

const observeOnlineHolders = async (runtime: DocumentRuntime, folderId: string,
  policy: FolderRetentionPolicy, context: Awaited<ReturnType<typeof sharedSettingsContext>>,
  sessions: Extract<ReleaseRequest, { mode: "safe" }>["sessions"], manifestDigest: string) => {
  const observations: Array<{ holderId: string; session: typeof sessions[number];
    completion: Awaited<ReturnType<Vault["signReplicaCompletion"]>> }> = [];
  const failures: string[] = [];
  for (const holder of policy.holders.filter(value => value.id !== context.membership.localDeviceId)) {
    const peerId = holder.kind === "syncpeer"
      ? context.membership.devices.find(device => device.id === holder.id && device.state === "active")?.syncthingId
      : holder.id;
    const session = peerId && sessions.find(value => !value.isClosed() && sameDeviceId(value.remoteDeviceId, peerId));
    if (!session) { failures.push("a named holder is not connected with its authenticated identity"); continue; }
    try {
      if (await verifyRemoteReplicaManifest(session.remoteFs, folderId) !== manifestDigest || session.isClosed()) {
        failures.push("a connected holder's complete folder manifest differs from this device");
        continue;
      }
    } catch {
      failures.push("a connected holder could not provide every verified file block");
      continue;
    }
    const completedAtMs = Date.now();
    const completion = await runtime.vault.signReplicaCompletion({ folderId,
      holderId: holder.id, holderKind: holder.kind, manifestDigest,
      policyRevision: policy.revision, completedAtMs, liveUntilMs: completedAtMs + 5 * 60_000 });
    observations.push({ holderId: holder.id, session, completion });
  }
  return { observations, failures };
};

const prepareSafeRelease = async (runtime: DocumentRuntime, folderId: string,
  policy: FolderRetentionPolicy, context: Awaited<ReturnType<typeof sharedSettingsContext>>,
  replica: LocalFolderReplica | undefined, files: Awaited<ReturnType<LocalFolderReplica["scan"]>>,
  sessions: Extract<ReleaseRequest, { mode: "safe" }>["sessions"], manifestDigest: string): Promise<LocalReleaseRecord> => {
  const localId = context.membership.localDeviceId;
  if (!replica || !localId || !policy.holders.some(holder => holder.kind === "syncpeer" && holder.id === localId)) {
    throw new Error("Add this device as a complete-copy holder before a safe release.");
  }
  await verifyLocalReplicaManifest(replica, files);
  const { observations, failures } = await observeOnlineHolders(runtime, folderId, policy, context, sessions, manifestDigest);
  if (observations.filter(value => !value.session.isClosed()).length < policy.minimumCopies) {
    throw new Error(`Safe release needs more online verified complete copies: ${failures.join("; ") || "none were verified"}.`);
  }
  const current = await sharedSettingsContext(runtime, true);
  if (await verifyLocalReplicaManifest(replica, files) !== manifestDigest || !current.result.settings ||
    JSON.stringify(folderRetentionPolicyFromSettings(current.result.settings, folderId)) !== JSON.stringify(policy)) {
    throw new Error("Folder or trusted settings changed during release verification.");
  }
  const proposal = await runtime.vault.signRetentionReleaseProposal({ folderId,
    releaseHolderId: localId, policyRevision: policy.revision,
    rosterHead: policy.rosterHead, manifestDigest });
  const completions = [await runtime.vault.signReplicaCompletion({ folderId,
    holderId: localId, holderKind: "syncpeer", manifestDigest,
    policyRevision: policy.revision, completedAtMs: Date.now() }), ...observations.map(value => value.completion)];
  await authorizeReplicaRelease(crypto.subtle, { policy, currentManifestDigest: manifestDigest,
    proposal, completions, onlineHolderIds: [localId, ...observations.filter(value => !value.session.isClosed())
      .map(value => value.holderId)], trust: current.membership.trust, nowMs: Date.now() });
  return { kind: "safe", proposal, completions, decidedAtMs: Date.now() };
};

const releaseLocalCopyAction = async (runtime: DocumentRuntime, folderId: string,
  request: ReleaseRequest) => {
  if (request.mode === "dangerous" && request.confirmedText !== "RELEASE LOCAL COPY") {
    throw new Error("Type RELEASE LOCAL COPY to confirm the dangerous local release.");
  }
  const registry = requireUnlockedRegistry(runtime);
  const folder = registry.getState().find(value => value.id === folderId && value.downloads);
  if (!folder) throw new Error("This folder has no local copy to release.");
  if ([...runtime.handles.values()].some(handle => JSON.parse(handle.documentId)[0] === folder.storageId)) {
    throw new Error("Close this folder's open documents before releasing its local copy.");
  }
  const context = await sharedSettingsContext(runtime, true);
  const policy = context.result.settings
    ? folderRetentionPolicyFromSettings(context.result.settings, folderId)
    : defaultFolderRetentionPolicy(folderId, context.membership.trust.knownHead);
  const replica = registry.getReplica(folderId);
  let files: Awaited<ReturnType<LocalFolderReplica["scan"]>> = [];
  let manifestDigest = "unavailable";
  try {
    if (replica) {
      files = (await replica.scan()).filter(file => !isInternalReplicaPath(file.name));
      manifestDigest = folderManifestDigestFromBep(files);
    }
  } catch (error) { if (request.mode === "safe") throw error; }
  let record: LocalReleaseRecord;
  if (request.mode === "dangerous") {
    const exception = await runtime.vault.signDangerousLocalRelease({ folderId,
      policyRevision: policy.revision, rosterHead: policy.rosterHead,
      manifestDigest, createdAtMs: Date.now(), confirmedText: request.confirmedText });
    record = { kind: "dangerous", exception };
  } else record = await prepareSafeRelease(runtime, folderId, policy, context, replica, files,
    request.sessions, manifestDigest);
  await registry.commitBrowseOnlyRelease(folderId, record);
  const storage = await runtime.options.openStorage(folder.storageId);
  try { await purgePrivateReplicaContents(storage); }
  finally { await storage.close(); }
  await runtime.vault.completeLocalRelease(folderId);
  return record;
};

const appendSharedEdit = async (runtime: DocumentRuntime,
  context: Awaited<ReturnType<typeof sharedSettingsContext>>, change: Omit<PersonalSpaceChange, "id" | "deviceId">) => {
  const random = await runtime.options.randomBytes(16);
  if (random.length !== 16) throw new Error("Invalid shared setting random source.");
  const draft: PersonalSpaceChange = { id: Array.from(random, byte => byte.toString(16).padStart(2, "0")).join(""),
    deviceId: context.membership.localDeviceId!, ...change };
  const edit = await runtime.vault.signPersonalSpaceChange(draft);
  const next = await materializePersonalSpaceSettings(crypto.subtle, context.membership.trust,
    [...context.changes, edit]);
  await context.journal.append(edit);
  return next;
};

const effectiveProfileSettings = async (runtime: DocumentRuntime): Promise<SyncpeerProfileSettings> => {
  const base = await runtime.vault.profileSettings();
  if (!runtime.settingsFolder) return base;
  if (!await runtime.vault.spaceDeviceMembership()) return base;
  const { membership, result } = await sharedSettingsContext(runtime);
  if (!membership.localDeviceId || !result.settings) return base;
  const ids = new Set([...Object.keys(base.folders), ...Object.keys(result.settings.folders)]);
  const folders = Object.fromEntries([...ids].map(id => {
    const local = base.folders[id] ?? defaultFolderSettings();
    const selection = result.settings!.folders[id]?.devices[membership.localDeviceId!];
    return [id, { ...local, favorites: selection?.favorites ?? local.favorites,
      exclusions: selection?.exclusions ?? local.exclusions }];
  }));
  return { ...base, folders };
};

const saveEffectiveProfileSettings = async (runtime: DocumentRuntime, next: SyncpeerProfileSettings) => {
  const previous = await effectiveProfileSettings(runtime);
  const membership = await reconcileSpaceDeviceMembership(runtime);
  if (membership?.localDeviceId) {
    for (const id of new Set([...Object.keys(previous.folders), ...Object.keys(next.folders)])) {
      const old = previous.folders[id] ?? defaultFolderSettings();
      const current = next.folders[id] ?? defaultFolderSettings();
      const oldSelection = { favorites: old.favorites, exclusions: old.exclusions };
      const selection = { favorites: current.favorites, exclusions: current.exclusions };
      if (JSON.stringify(selection) === JSON.stringify(oldSelection)) continue;
      const context = await sharedSettingsContext(runtime, true);
      if (context.result.conflicts.length) throw new Error("Resolve shared-settings conflicts before changing favorites.");
      const path = ["folders", id, "devices", membership.localDeviceId];
      const prior = resolvePersonalSpaceChanges(context.changes).values.find(item =>
        JSON.stringify(item.path) === JSON.stringify(path));
      await appendSharedEdit(runtime, context, { path, parents: prior?.heads ?? [], value: selection });
    }
  }
  await runtime.vault.saveProfileSettings(next);
};

const createSettingsActions = (runtime: DocumentRuntime) => ({
  connectionPasswords: () => runQueued(runtime, () => runtime.vault.connectionPasswords()),
  saveConnectionPasswords: (passwords: Record<string, string>) =>
    runQueued(runtime, () => runtime.vault.saveConnectionPasswords(passwords)),
  mergeConnectionPasswords: (passwords: Record<string, string>) =>
    runQueued(runtime, () => runtime.vault.mergeConnectionPasswords(passwords)),
  profileSettings: () => runQueued(runtime, () => effectiveProfileSettings(runtime)),
  saveProfileSettings: (settings: Parameters<Vault["saveProfileSettings"]>[0]) =>
    runQueued(runtime, () => saveEffectiveProfileSettings(runtime, settings)),
  personalSpaceChanges: () => runQueued(runtime, () => {
    if (!runtime.settingsFolder) throw new Error("Personal-space settings storage is unavailable.");
    return createPersonalSpaceSettingsJournal(runtime.settingsFolder.replica, runtime.settingsFolder.id).load();
  }),
  sharedPersonalSpaceSettings: () => runQueued(runtime, async () => {
    return (await sharedSettingsContext(runtime)).result;
  }),
  savePersonalSpaceSetting: (path: string[], value: unknown) => runQueued(runtime, async () => {
    const context = await sharedSettingsContext(runtime, true);
    if (context.result.conflicts.length) throw new Error("Resolve shared-settings conflicts before changing settings.");
    const prior = resolvePersonalSpaceChanges(context.changes).values.find(item =>
      JSON.stringify(item.path) === JSON.stringify(path));
    return appendSharedEdit(runtime, context, { path, parents: prior?.heads ?? [], value });
  }),
  resolvePersonalSpaceConflict: (path: string[], selectedHead: string) => runQueued(runtime, async () => {
    const context = await sharedSettingsContext(runtime, true);
    const conflict = context.result.conflicts.find(item => JSON.stringify(item.path) === JSON.stringify(path));
    const chosen = conflict?.changes.find(item => item.id === selectedHead);
    if (!conflict || !chosen) throw new Error("Selected shared-settings conflict head was not found.");
    return appendSharedEdit(runtime, context, { path, parents: conflict.heads,
      ...(chosen.deleted ? { deleted: true as const } : { value: chosen.value }) });
  }),
  appendPersonalSpaceChange: (change: PersonalSpaceChange) => runQueued(runtime, async () => {
    if (!runtime.settingsFolder) throw new Error("Personal-space settings storage is unavailable.");
    const signed = await runtime.vault.signPersonalSpaceChange(change);
    return createPersonalSpaceSettingsJournal(runtime.settingsFolder.replica, runtime.settingsFolder.id).append(signed);
  }),
  exportRecoveryBackup: (password: string) => runQueued(runtime, () => runtime.vault.exportRecoveryBackup(password)),
  exportPairingTransfer: (localSyncthingId: string, joiningDevice: OwnedSpaceDevice) => runQueued(runtime, async () => {
    const transfer = await runtime.vault.exportPairingTransfer(localSyncthingId, joiningDevice);
    await reconcileSpaceDeviceMembership(runtime);
    return transfer;
  }),
  importPairingTransfer: (transfer: Parameters<Vault["importPairingTransfer"]>[0], identity: OwnedDeviceIdentity,
    password: string, remember = true) => runQueued(runtime, () => unlockAfterVaultChange(runtime,
      () => runtime.vault.importPairingTransfer(transfer, identity, password, remember))),
  ownedDevices: () => runQueued(runtime, async () => {
    const membership = await reconcileSpaceDeviceMembership(runtime);
    return { localDeviceId: membership?.localDeviceId ?? null, devices: membership?.devices ?? [] };
  }),
  revokeOwnedDevice: (deviceId: string) => runQueued(runtime, async () => {
    await runtime.vault.revokeOwnedDevice(deviceId);
    await reconcileSpaceDeviceMembership(runtime);
  }),
  restoreRecoveryBackup: (backup: Parameters<Vault["restoreRecoveryBackup"]>[0], recoveryPassword: string, password: string) =>
    runQueued(runtime, () => unlockAfterVaultChange(runtime, () => runtime.vault.restoreRecoveryBackup(backup, recoveryPassword, password))),
  uiState: () => runQueued(runtime, () => runtime.vault.uiState()),
  saveUiState: (value: unknown) => runQueued(runtime, () => runtime.vault.saveUiState(value)),
  rememberFolder: (folder: { id: string; label: string }) =>
    runQueued(runtime, () => rememberFolderAction(runtime, folder)),
  recoverOwnedDevice: (syncthingId: string, kit: Parameters<Vault["recoverOwnedDevice"]>[1], password: string) =>
    runQueued(runtime, async () => {
      await reconcileSpaceDeviceMembership(runtime);
      const trust = await runtime.vault.recoverOwnedDevice(syncthingId, kit, password);
      await reconcileSpaceDeviceMembership(runtime);
      return trust;
    }),
  createVault: (password: string, remember = false, localDeviceId?: string, recoveryKey?: string) => runQueued(runtime, async () => {
    return unlockAfterVaultChange(runtime,
      () => runtime.vault.create(password, remember, localDeviceId, recoveryKey));
  }),
  unlock: (password: string) =>
    runQueued(runtime, () => unlockAfterVaultChange(runtime, () => runtime.vault.unlock(password))),
  unlockRemembered: () =>
    runQueued(runtime, () => unlockAfterVaultChange(runtime, () => runtime.vault.unlockRemembered())),
  changeMasterPassword: (password: string) =>
    runQueued(runtime, async () => { await runtime.vault.changeMasterPassword(password); return documentStatus(runtime); }),
  lock: () => runQueued(runtime, async () => { await runtime.vault.lock(); return documentStatus(runtime); }),
});

const createFolderActions = (runtime: DocumentRuntime) => ({
  releaseLocalCopy: (folderId: string, request: ReleaseRequest) =>
    runQueued(runtime, () => releaseLocalCopyAction(runtime, folderId, request)),
  localReleaseHistory: () => runQueued(runtime, () => runtime.vault.localReleaseHistory()),
  register: (folder: { id: string; label: string; password?: string }) =>
    runQueued(runtime, () => registerFolderAction(runtime, folder)),
  attachDownloads: (id: string) => runQueued(runtime, () => attachDownloadsAction(runtime, id)),
  detachDownloads: (id: string) => runQueued(runtime, () => detachDownloadsAction(runtime, id)),
  sessionSharedFolders: (remoteDeviceId: string) => runQueued(runtime, async () => {
    if (!remoteDeviceId) return [];
    requireUnlockedRegistry(runtime);
    const personalSpaceFolder = await runtime.vault.personalSpaceFolder();
    if (personalSpaceFolder && runtime.settingsFolder?.id !== personalSpaceFolder.id) {
      throw new Error("Personal-space settings storage is unavailable.");
    }
    // A not-yet-enrolled vault has no space device membership even if its encrypted
    // personal-space storage already exists. Explicit root favorites can still
    // be shared with the authenticated ordinary Syncthing peer.
    const context = await runtime.vault.spaceDeviceMembership()
      ? await sharedSettingsContext(runtime) : null;
    if (context) await syncSharedFolderCredentials(runtime, context);
    const registry = requireUnlockedRegistry(runtime);
    const settings = await effectiveProfileSettings(runtime);
    const shared = context?.result.settings;
    const owned = context && settingsFolderDevices(context.membership.devices)
      .some(id => sameDeviceId(id, remoteDeviceId));
    const selected = new Set(Object.entries(settings.folders)
      .filter(([, folder]) => !folder.paused &&
        folder.favorites.some(favorite => favorite.kind === "folder" && favorite.path === ""))
      .filter(([folderId]) => !context || shared && resolveFolderShareDevices(
        shared.folders[folderId]?.shareTargets ?? [{ kind: "personal-space" }],
        context.membership.devices).some(id => sameDeviceId(id, remoteDeviceId)))
      .map(([folderId]) => folderId));
    const documents = await Promise.all(registry.getState().filter(folder => folder.downloads && selected.has(folder.id))
      .map(async folder => {
      const replica = registry.getReplica(folder.id);
      if (!replica) throw new Error("Document folder is not open.");
      const password = await runtime.vault.folderPassword(folder.id);
      if (!password) throw new Error("Registered folder credentials are unavailable.");
      return {
        id: folder.id,
        label: folder.label,
        replica,
        encryption: { mode: "encrypted" as const, password },
      };
    }));
    return [...(personalSpaceFolder && owned ? [{ id: personalSpaceFolder.id,
      label: "Syncpeer personal-space settings", replica: runtime.settingsFolder!.replica,
      internal: true, encryption: { mode: "encrypted" as const,
        password: personalSpaceFolder.password } }] : []), ...documents];
  }),
  favoriteSyncState: (folderId: string) => runQueued(runtime, async () => {
    const { bytes, key } = favoriteStateTarget(runtime, folderId);
    return loadFavoriteSyncState(bytes, key);
  }),
  saveFavoriteSyncEntries: (folderId: string, entries: Record<string, FavoriteSyncEntry>) =>
    runQueued(runtime, async () => {
      const { bytes, key } = favoriteStateTarget(runtime, folderId);
      await saveFavoriteSyncEntries(bytes, { folderKey: key, randomBytes: runtime.options.randomBytes }, entries);
    }),
  clearFavoriteRenames: (folderId: string, paths: string[]) => runQueued(runtime, async () => {
    const { bytes, key } = favoriteStateTarget(runtime, folderId);
    await clearFavoriteRenames(bytes, { folderKey: key, randomBytes: runtime.options.randomBytes }, paths);
  }),
  clearFavoriteSyncEntry: (folderId: string, path: string) => runQueued(runtime, async () => {
    const { bytes, key } = favoriteStateTarget(runtime, folderId);
    await removeFavoriteSyncEntry(bytes, { folderKey: key, randomBytes: runtime.options.randomBytes }, path);
  }),
  recordFavoriteResolution: (folderId: string, path: string, resolution: "keep-local" | "keep-remote") =>
    runQueued(runtime, async () => {
      const { bytes, key } = favoriteStateTarget(runtime, folderId);
      const state = await loadFavoriteSyncState(bytes, key);
      const entries = { ...state.entries, [path]: { phase: "conflict" as const, attempts: 0,
        updatedAtMs: Date.now(), nextAttemptMs: 0, resolution } };
      await saveFavoriteSyncEntries(bytes, { folderKey: key, randomBytes: runtime.options.randomBytes }, entries);
    }),
  loadDirectorySnapshot: (folderId: string, sourceDeviceId: string, path: string) =>
    runQueued(runtime, () => loadDirectorySnapshotAction(runtime, folderId, sourceDeviceId, path)),
  saveDirectorySnapshot: (folderId: string, sourceDeviceId: string, path: string, snapshot: StoredDirectorySnapshot) =>
    runQueued(runtime, () => saveDirectorySnapshotAction(runtime, folderId, sourceDeviceId, path, snapshot)),
});

const createDirectoryActions = (runtime: DocumentRuntime) => ({
  cachedFiles: (folderId?: string) => runQueued(runtime, () => cachedFilesAction(runtime, folderId)),
  digestCachedFiles: (files: readonly { folderId: string; path: string }[]) =>
    runQueued(runtime, () => digestCachedFilesAction(runtime, files)),
  cachedStatuses: (folderId: string, paths: string[]) => runQueued(runtime, () => cachedStatusesAction(runtime, folderId, paths)),
  remove: (id: string) => runQueued(runtime, () => removeDocumentAction(runtime, id)),
  rename: (id: string, name: string) => runQueued(runtime, () => renameDocumentAction(runtime, id, name)),
  stat: (id: string) => runQueued(runtime, () => statById(runtime, id)),
  list: (id: string) => runQueued(runtime, () => listEntriesAction(runtime, id)),
  create: (parentId: string, name: string, directory: boolean) =>
    runQueued(runtime, () => createEntryAction(runtime, parentId, name, directory)),
});

const createHandleActions = (runtime: DocumentRuntime) => ({
  beginDownload: (folderId: string, path: string, size: number, modifiedMs: number,
    expectedLocalHash?: string | null, metadata: DownloadMetadata = { encrypted: false }) =>
    runQueued(runtime, () => beginDownloadAction(runtime, folderId, path, size, modifiedMs, expectedLocalHash, metadata)),
  downloadRanges: (id: number) => runQueued(runtime, () => downloadRangesAction(runtime, id)),
  suspendDownload: (id: number) => runQueued(runtime, () => suspendDownloadAction(runtime, id)),
  finishDownload: (id: number) => runQueued(runtime, () => finishDownloadAction(runtime, id)),
  setSyncBaseline: (id: string, baseline: NonNullable<CachedFileRecord["syncBaseline"]>) =>
    runQueued(runtime, () => setSyncBaselineAction(runtime, id, baseline)),
  clearSyncBaseline: (id: string) => runQueued(runtime, () => clearSyncBaselineAction(runtime, id)),
  syncBaseline: (id: string) => runQueued(runtime, () => loadSyncBaselineAction(runtime, id)),
  digest: (id: number) => runQueued(runtime, () => digestHandleAction(runtime, id)),
  digestRanges: (id: number, source: "cached" | "partial", ranges: readonly { offset: number; size: number }[]) =>
    runQueued(runtime, () => digestRangesAction(runtime, id, source, ranges)),
  copyRanges: (id: number, ranges: readonly { offset: number; size: number }[]) =>
    runQueued(runtime, () => copyRangesAction(runtime, id, ranges)),
  open: (id: string, mode: string) => runQueued(runtime, () => openHandleAction(runtime, id, mode)),
  size: (id: number) => runQueued(runtime, async () => {
    const value = requireHandle(runtime, id);
    return value.writer ? value.writer.size() : value.reader!.size;
  }),
  read: (id: number, offset: number, size: number) => runQueued(runtime, async () => {
    const value = requireHandle(runtime, id);
    return (value.writer ?? value.reader!).readRange(offset, size);
  }),
  write: (id: number, offset: number, bytes: Uint8Array) => runQueued(runtime, () => writeToHandle(runtime, id, offset, bytes)),
  flush: (id: number) => runQueued(runtime, () => flushHandleAction(runtime, id)),
  release: (id: number, abort = false) => runQueued(runtime, () => releaseHandleAction(runtime, id, abort)),
});

const createVersionActions = (runtime: DocumentRuntime) => ({
  versions: (id: string) => runQueued(runtime, () => listVersionsAction(runtime, id)),
  restoreVersion: (id: string, versionId: string) => runQueued(runtime, () => restoreVersionAction(runtime, id, versionId)),
});

const createCacheActions = (runtime: DocumentRuntime) => ({
  enforceCacheQuota: () => runQueued(runtime, () => enforceCacheQuotaAction(runtime)),
});

export const createDocumentFilesystem = (options: DocumentFilesystemOptions) => {
  const runtime: DocumentRuntime = {
    options,
    configs: undefined as unknown as ReturnType<typeof createFolderRegistryStorage>,
    storage: new Map(),
    folderKeys: new Map(),
    handles: new Map(),
    recoveryIssues: new Map(),
    vault: undefined as unknown as Vault,
    registry: undefined,
    nextHandle: 0,
    closed: false,
    queue: Promise.resolve(),
    closeTask: undefined,
  };
  runtime.vault = createCredentialVault({
    profileId: options.profileId,
    randomBytes: options.randomBytes,
    storage: createCredentialVaultStorage(options.profile, options.profile),
    rememberedSecret: options.rememberedSecret,
    bootstrapStorage: createPersonalSpaceBootstrapStorage(options.profile, options.profile),
    ...(options.kdf ? { kdf: options.kdf } : {}),
    revokeAccess: () => revokeAccess(runtime),
  });
  runtime.configs = createFolderRegistryStorage(options.profile, runtime.vault);
  return {
    ...createLifecycleActions(runtime),
    ...createSettingsActions(runtime),
    ...createFolderActions(runtime),
    ...createDirectoryActions(runtime),
    ...createHandleActions(runtime),
    ...createVersionActions(runtime),
    ...createCacheActions(runtime),
  };
};

export type DocumentFilesystem = ReturnType<typeof createDocumentFilesystem>;
