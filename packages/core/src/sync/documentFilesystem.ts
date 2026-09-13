import { sha256 } from "@noble/hashes/sha2.js";
import { deriveUntrustedFolderCrypto, encryptUntrustedFilename } from "../core/model/untrusted.js";
import { createCredentialVault, type RememberedUnlockSecretStore } from "./credentialVault.js";
import { createCredentialVaultStorage } from "./credentialVaultStorage.js";
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
import { cachedFileKey } from "../ui/helpers.js";
import { loadDocumentBaseline, saveDocumentBaseline } from "./documentBaseline.js";
import { classifyFavoritePath } from "../ui/favoriteSelection.js";
import { defaultFolderSettings } from "./profileSettings.js";
import { planVersionRemovals } from "./folderSync.js";

/** Single owner used by the UI and native file providers; host adapters only move bytes. */
export function createDocumentFilesystem(options: {
  profileId: string;
  deviceCounterId: string;
  profile: Awaited<ReturnType<typeof createNativeFilesystem>>;
  openStorage: (id: string) => Promise<Awaited<ReturnType<typeof createNativeFilesystem>>>;
  rememberedSecret: RememberedUnlockSecretStore;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
}) {
  const configs = createFolderRegistryStorage(options.profile);
  const storage = new Map<string, Awaited<ReturnType<typeof options.openStorage>>>();
  const folderKeys = new Map<string, Uint8Array>();
  const handles = new Map<number, { documentId: string; reader?: Awaited<ReturnType<typeof createReplicaFileSource>>;
    writer?: Awaited<ReturnType<typeof openDocumentDraft>>; dirty: boolean; append?: boolean;
    download?: { size: number; modifiedMs: number; ranges: Array<{ offset: number; end: number }> } }>();
  const recoveryIssues = new Map<string, string[]>();
  let registry: ReturnType<typeof createFolderRegistry> | undefined;
  let nextHandle = 0, closed = false;
  let queue = Promise.resolve();
  let closeTask: Promise<void> | undefined;
  const run = <T>(fn: () => Promise<T>) => {
    const task = queue.then(() => { if (closed) throw new Error("Documents are closed."); return fn(); });
    queue = task.then(() => {}, () => {});
    return task;
  };
  const revoke = async () => {
    const pending = [...handles.values()]; handles.clear();
    const results = await Promise.allSettled(pending.map(handle => handle.writer?.close()));
    const registryResult = await Promise.allSettled([registry?.close()]);
    registry = undefined;
    // A failed controller/storage close must never retain unlocked folder keys.
    for (const key of folderKeys.values()) key.fill(0);
    folderKeys.clear();
    const storageResults = await Promise.allSettled([...storage.values()].map(bytes => bytes.close()));
    storage.clear();
    const errors = [...results, ...registryResult, ...storageResults].filter(result => result.status === "rejected");
    if (errors.length) throw new Error("Some document handles could not be closed.");
  };
  const vault = createCredentialVault({ profileId: options.profileId, randomBytes: options.randomBytes,
    storage: createCredentialVaultStorage(options.profile, options.profile), rememberedSecret: options.rememberedSecret,
    revokeAccess: revoke });
  const randomId = async () => [...await options.randomBytes(16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const versionId = async () => `${Date.now()}-${await randomId()}`;
  const versionTime = (path: string) => {
    const match = /^\.stversions\/(\d{13})-[a-f0-9]{32}$/.exec(path);
    return match ? Number(match[1]) : null;
  };
  const pruneVersions = async (bytes: Awaited<ReturnType<typeof options.openStorage>>, storedPath: string,
    versioning: "trash" | "simple" | "staggered") => {
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
  const openFolder = async (folder: FolderRegistration) => {
    const password = await vault.folderPassword(folder.id);
    if (!password) throw new Error("Folder credentials are unavailable.");
    const crypto = await deriveUntrustedFolderCrypto(folder.id, password);
    let bytes: Awaited<ReturnType<typeof options.openStorage>>;
    try { bytes = await options.openStorage(folder.storageId); }
    catch (error) { crypto.folderKey.fill(0); throw error; }
    try {
      await bytes.initializeReplica();
      await bytes.withLock(() => removeAbandonedEncryptedScratch(bytes));
      const encrypted = createEncryptedReplicaStorage(bytes, { folderKey: crypto.folderKey, randomBytes: options.randomBytes,
        withLock: bytes.withLock, checkHealth: bytes.checkHealth, archive: async (path, originalPath) => {
          const settings = await vault.profileSettings();
          const folderSettings = settings.folders[folder.id] ?? defaultFolderSettings();
          const selection = classifyFavoritePath({ folderId: folder.id, path: originalPath, kind: "file" },
            folderSettings.favorites, folderSettings.exclusions, folderSettings.ignorePatterns);
          if (selection.status !== "favorite" || settings.profile.versioning === "disabled") return;
          if (!await bytes.stat(".stversions")) await bytes.makeDirectory(".stversions");
          const versionRoot = ".stversions/" + await versionId();
          await bytes.makeDirectory(versionRoot);
          // The original ciphertext path is needed to decrypt archived metadata.
          await bytes.copy(path, versionRoot + "/" + path);
          await pruneVersions(bytes, path, settings.profile.versioning);
        } });
      const replica = createReplicaController(createFolderReplica(encrypted, options.deviceCounterId, sha256));
      await replica.scan();
      recoveryIssues.set(folder.storageId, await recoverDocumentDrafts(bytes, {
        folderId: folder.id, folderKey: crypto.folderKey, replica, randomBytes: options.randomBytes,
      }));
      storage.set(folder.storageId, bytes);
      folderKeys.set(folder.storageId, crypto.folderKey);
      return { replica, close: async () => {
        try { await bytes.close(); } finally {
          crypto.folderKey.fill(0); folderKeys.delete(folder.storageId); storage.delete(folder.storageId);
        }
      } };
    } catch (error) { crypto.folderKey.fill(0); await bytes.close(); throw error; }
  };
  const openRegistrations = async () => {
    registry ??= createFolderRegistry({ ...configs, open: openFolder });
    await registry.initialize();
    if (vault.status().phase === "unlocked") {
      for (const folder of registry.getState()) {
        if (await vault.folderPassword(folder.id)) await registry.open(folder.id);
      }
    }
  };
  const status = async () => ({ vault: vault.status(), folders: await configs.load(), recoveryIssues: [...recoveryIssues.values()].flat() });
  const resolve = (id: string) => {
    if (vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
    const decoded: unknown = JSON.parse(id);
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some(part => typeof part !== "string")) throw new Error("Invalid document ID.");
    const [storageId, path] = decoded as [string, string];
    if (path) { assertReplicaPath(path); if (isInternalReplicaPath(path)) throw new Error("Private document."); }
    const folder = registry?.getState().find(folder => folder.storageId === storageId);
    if (!folder) throw new Error("Document folder is unavailable.");
    const replica = registry!.getReplica(folder.id);
    if (!replica) throw new Error("Document folder is not open.");
    return { folder, replica, path, bytes: storage.get(storageId)! };
  };
  const entry = (folder: FolderRegistration, path: string, size: number, directory: boolean, modifiedMs = 0) => ({
    id: JSON.stringify([folder.storageId, path]), name: path ? path.split("/").at(-1)! : folder.label, size, directory, modifiedMs,
  });
  const archivedSource = async (storageId: string, path: string, versionId: string) => {
    if (!/^(?:\d{13}-)?[a-f0-9]{32}$/.test(versionId)) throw new Error("Invalid document version.");
    const bytes = storage.get(storageId)!;
    const key = folderKeys.get(storageId)!;
    const encrypted = await encryptUntrustedFilename(key, path);
    const archivePath = `.stversions/${versionId}/${encrypted}`;
    const stat = await bytes.stat(archivePath);
    if (!stat || stat.type !== "file") throw new Error("Document version is unavailable.");
    const source = { size: stat.size, readRange: (offset: number, size: number) => bytes.readRange(archivePath, offset, size) };
    const metadata = await loadEncryptedDiskMetadata(source, encrypted, key);
    if (metadata.fileInfo.name !== path) { metadata.fileKey.fill(0); throw new Error("Document version does not match this path."); }
    return { source, metadata };
  };
  const stat = async (id: string) => {
    const { folder, path, replica } = resolve(id);
    if (!path) return entry(folder, "", 0, true);
    const info = (await replica.scan()).find(file => file.name === path && !file.deleted && !file.invalid);
    if (!info || ![0, 1].includes(Number(info.type ?? 0))) throw new Error("Document is unavailable.");
    return entry(folder, path, Number(info.size ?? 0), info.type === 1, Number(info.modified_s ?? 0) * 1000);
  };
  const writable = async (id: string, truncate: boolean) => {
    const { folder, replica, path, bytes } = resolve(id);
    return openDocumentDraft(bytes, { folderId: folder.id, path, truncate, replica,
      folderKey: folderKeys.get(folder.storageId)!, randomBytes: options.randomBytes });
  };
  const handle = (id: number) => {
    const found = handles.get(id);
    if (!found) throw new Error("Document handle is closed.");
    return found;
  };
  const write = async (id: number, offset: number, bytes: Uint8Array) => {
    const value = handle(id); if (!value.writer) throw new Error("Document is read only.");
    if (value.download && offset + bytes.length > value.download.size) throw new Error("Download write exceeds expected size.");
    await value.writer.write(value.append ? await value.writer.size() : offset, bytes); value.dirty = true;
    if (value.download && bytes.length) {
      value.download.ranges = value.writer.downloadRanges();
    }
  };
  const checkRanges = (ranges: readonly { offset: number; size: number }[]) => {
    if (ranges.length > 256 || ranges.some(range => !Number.isSafeInteger(range.offset) || range.offset < 0 ||
      !Number.isSafeInteger(range.size) || range.size < 0 || !Number.isSafeInteger(range.offset + range.size))) throw new Error("Invalid document ranges.");
  };
  const removePaths = async (replica: LocalFolderReplica, folderId: string,
    paths: readonly string[]) => {
    for (const path of [...paths].sort((left, right) => right.length - left.length)) {
      const current = (await replica.scan()).find(value => value.name === path && !value.deleted);
      if (!current) continue;
      await replica.edit!({ method: "delete", folderId, path,
        modifiedMs: Date.now(), expectedVersion: current.version ?? {} });
    }
  };
  return {
    initialize: (automatic = false) => run(async () => {
      await options.profile.initializeReplica(); await vault.initialize();
      if (automatic && vault.status().phase === "uninitialized") await vault.createDeviceProtected();
      await openRegistrations(); return status();
    }),
    status: () => run(status),
    connectionPasswords: () => run(() => vault.connectionPasswords()),
    saveConnectionPasswords: (passwords: Record<string, string>) => run(() => vault.saveConnectionPasswords(passwords)),
    profileSettings: () => run(() => vault.profileSettings()),
    saveProfileSettings: (settings: Parameters<typeof vault.saveProfileSettings>[0]) =>
      run(() => vault.saveProfileSettings(settings)),
    rememberFolder: (folder: { id: string; label: string }) => run(async () => {
      if (!registry) throw new Error("Folder storage is unavailable.");
      if (!registry.getState().some(value => value.id === folder.id)) {
        await registry.add({ ...folder, storageId: await randomId() }, false);
      }
      return status();
    }),
    createVault: (password: string, remember = false) => run(async () => {
      await vault.create(password, remember); await openRegistrations(); return status();
    }),
    unlock: (password: string) => run(async () => { await vault.unlock(password); await openRegistrations(); return status(); }),
    unlockRemembered: () => run(async () => { await vault.unlockRemembered(); await openRegistrations(); return status(); }),
    changeMasterPassword: (password: string) => run(async () => { await vault.changeMasterPassword(password); return status(); }),
    lock: () => run(async () => { await vault.lock(); return status(); }),
    register: (folder: { id: string; label: string; password?: string }) => run(async () => {
      if (!registry) throw new Error("Folder storage is unavailable.");
      if (!folder.id.trim() || !folder.label.trim() || folder.id !== folder.id.trim() || folder.label !== folder.label.trim()) throw new Error("Invalid folder registration.");
      const existing = await vault.folderPassword(folder.id);
      if (existing === null) await vault.addFolder(folder.id, folder.password);
      else if (folder.password !== undefined && folder.password !== existing) throw new Error("Folder password changes require migration.");
      if (registry.getState().some(value => value.id === folder.id)) await registry.open(folder.id);
      else await registry.add({ id: folder.id, label: folder.label, storageId: await randomId() });
      return status();
    }),
    attachDownloads: (id: string) => run(async () => {
      if (vault.status().phase !== "unlocked" || !registry) throw new Error("Document vault is locked.");
      await registry.attachDownloads(id);
    }),
    detachDownloads: (id: string) => run(async () => {
      if (vault.status().phase !== "unlocked" || !registry) throw new Error("Document vault is locked.");
      await registry.detachDownloads(id);
      return status();
    }),
    clearFolderContents: (folderId: string) => run(async () => {
      if (vault.status().phase !== "unlocked" || !registry) throw new Error("Document vault is locked.");
      const folder = registry.getState().find(value => value.id === folderId);
      if (!folder) throw new Error("Document folder is unavailable.");
      const replica = registry.getReplica(folderId);
      if (!replica) throw new Error("Document folder is not open.");
      const paths = (await replica.scan())
        .filter(value => !value.deleted && !value.invalid && !isInternalReplicaPath(value.name))
        .map(value => value.name);
      await removePaths(replica, folderId, paths);
      return status();
    }),
    cachedFiles: (folderId?: string) => run(async (): Promise<CachedFileRecord[]> => {
      if (vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
      const files: CachedFileRecord[] = [];
      for (const folder of registry!.getState().filter(folder => folderId ? folder.id === folderId : folder.downloads)) {
        for (const info of await registry!.getReplica(folder.id)!.scan()) {
          if (info.deleted || info.invalid || Number(info.type ?? 0) !== 0) continue;
          const modifiedMs = Number(info.modified_s ?? 0) * 1000 + Number(info.modified_ns ?? 0) / 1000000;
          files.push({ key: cachedFileKey(folder.id, info.name), folderId: folder.id, path: info.name,
            name: info.name.split("/").at(-1)!, sizeBytes: Number(info.size ?? 0), modifiedMs, cachedAtMs: modifiedMs,
            localPath: "syncpeer-document:" + JSON.stringify([folder.storageId, info.name]),
            syncBaselineRequired: true,
            syncBaseline: await loadDocumentBaseline(storage.get(folder.storageId)!, folderKeys.get(folder.storageId)!, info.name) });
        }
      }
      return files;
    }),
    cachedStatuses: (folderId: string, paths: string[]) => run(async () => {
      if (vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
      const folder = registry!.getState().find(folder => folder.id === folderId && folder.downloads);
      if (!folder) throw new Error("Downloads are not attached.");
      const files = await registry!.getReplica(folderId)!.scan();
      return paths.map(path => {
        if (path) { assertReplicaPath(path); if (isInternalReplicaPath(path)) throw new Error("Private document."); }
        const file = files.find(file => file.name === path && !file.deleted && !file.invalid);
        const available = !path || !!file;
        return { path, available, localPath: available ? "syncpeer-document:" + JSON.stringify([folder.storageId, path]) : undefined,
          cachedAtMs: file ? Number(file.modified_s ?? 0) * 1000 : undefined };
      });
    }),
    versions: (id: string) => run(async () => {
      const { folder, path, bytes } = resolve(id);
      if (!path) throw new Error("Choose a file to view its versions.");
      const roots = await bytes.listDirectory(".stversions");
      const versions: Array<{ id: string; modifiedMs: number; sizeBytes: number }> = [];
      for (const root of roots) {
        if (root.type !== "directory" || !/^(?:\d{13}-)?[a-f0-9]{32}$/.test(root.path.slice(".stversions/".length))) continue;
        const versionId = root.path.slice(".stversions/".length);
        try {
          const archived = await archivedSource(folder.storageId, path, versionId);
          try {
            versions.push({ id: versionId,
              modifiedMs: Number(archived.metadata.fileInfo.modified_s ?? 0) * 1000 +
                Number(archived.metadata.fileInfo.modified_ns ?? 0) / 1000000,
              sizeBytes: Number(archived.metadata.fileInfo.size ?? 0) });
          } finally { archived.metadata.fileKey.fill(0); }
        } catch (error) {
          if (!(error instanceof Error && /unavailable/.test(error.message))) throw error;
        }
      }
      return versions.sort((left, right) => right.modifiedMs - left.modifiedMs);
    }),
    restoreVersion: (id: string, versionId: string) => run(async () => {
      const { folder, replica, path } = resolve(id);
      if (!path) throw new Error("Choose a file to restore.");
      const archived = await archivedSource(folder.storageId, path, versionId);
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
    }),
    beginDownload: (folderId: string, path: string, size: number, modifiedMs: number, expectedLocalHash?: string | null,
      metadata: { encrypted: boolean; sourceDeviceId?: string; contentId?: string } = { encrypted: false }) => run(async () => {
      if (vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
      if (handles.size >= 64) throw new Error("Too many open documents.");
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(modifiedMs) || modifiedMs < 0) throw new Error("Invalid download metadata.");
      assertReplicaPath(path);
      const folder = registry?.getState().find(folder => folder.id === folderId);
      if (!folder) throw new Error("Document folder is unavailable.");
      const documentId = JSON.stringify([folder.storageId, path]);
      const file = resolve(documentId);
      if (expectedLocalHash !== undefined) {
        const current = (await file.replica.scan()).find(info => info.name === path && !info.deleted);
        if (expectedLocalHash === null) {
          if (current) throw new Error("Local document changed before download began.");
        } else {
          if (!/^[a-f0-9]{64}$/.test(expectedLocalHash) || !current) throw new Error("Local document changed before download began.");
          const source = await createReplicaFileSource(file.replica, path), hash = sha256.create();
          for (let offset = 0; offset < source.size; offset += 131072) {
            const data = await source.readRange(offset, Math.min(131072, source.size - offset));
            try { hash.update(data); } finally { data.fill(0); }
          }
          if ([...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("") !== expectedLocalHash) throw new Error("Local document changed before download began.");
        }
      }
      const parts = path.split("/");
      for (let count = 1; count < parts.length; count++) {
        const parent = parts.slice(0, count).join("/");
        const old = (await file.replica.scan()).find(info => info.name === parent);
        if (!old || old.deleted) await file.replica.edit!({ method: "mkdir", folderId, path: parent,
          expectedVersion: old?.version ?? null, modifiedMs });
        else if (old.type !== 1) throw new Error("Download parent is not a directory.");
      }
      const writer = await openDocumentDownloadDraft(file.bytes, { folderId, path,
        replica: file.replica, folderKey: folderKeys.get(folder.storageId)!, randomBytes: options.randomBytes,
        download: { folderId, path, sizeBytes: size, modifiedMs, encrypted: metadata.encrypted,
          ...(metadata.sourceDeviceId ? { sourceDeviceId: metadata.sourceDeviceId } : {}),
          ...(metadata.contentId ? { contentId: metadata.contentId } : {}) } });
      const old = (await file.replica.scan()).find(info => info.name === path && !info.deleted);
      let reader: Awaited<ReturnType<typeof createReplicaFileSource>> | undefined;
      try { if (old) reader = await createReplicaFileSource(file.replica, path); }
      catch (error) { await writer.discard(); throw error; }
      const id = ++nextHandle;
      handles.set(id, { documentId, writer, reader, dirty: true,
        download: { size, modifiedMs, ranges: writer.downloadRanges() } });
      return id;
    }),
    downloadRanges: (id: number) => run(async () => {
      const value = handle(id);
      if (!value.download) throw new Error("Not a download handle.");
      return value.download.ranges.map(range => ({ offset: range.offset, size: range.end - range.offset }));
    }),
    suspendDownload: (id: number) => run(async () => {
      const value = handle(id);
      if (!value.download || !value.writer) throw new Error("Not a download handle.");
      handles.delete(id);
      await value.writer.close();
    }),
    finishDownload: (id: number) => run(async () => {
      const value = handle(id), download = value.download;
      if (!download || !value.writer) throw new Error("Not a download handle.");
      if (await value.writer.size() !== download.size || (download.size &&
        (download.ranges.length !== 1 || download.ranges[0].offset !== 0 || download.ranges[0].end !== download.size))) throw new Error("Download is incomplete.");
      const hash = [...await value.writer.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
      await value.writer.flush(false, download.modifiedMs);
      const file = resolve(value.documentId);
      await saveDocumentBaseline(file.bytes, { path: file.path, folderKey: folderKeys.get(file.folder.storageId)!,
        randomBytes: options.randomBytes, baseline: { hash, sizeBytes: download.size, modifiedMs: download.modifiedMs } });
      await value.writer.close(); handles.delete(id);
    }),
    setSyncBaseline: (id: string, baseline: NonNullable<CachedFileRecord["syncBaseline"]>) => run(async () => {
      const file = resolve(id);
      await saveDocumentBaseline(file.bytes, { path: file.path, folderKey: folderKeys.get(file.folder.storageId)!, randomBytes: options.randomBytes, baseline });
    }),
    digest: (id: number) => run(async () => {
      const value = handle(id);
      if (!value.writer) throw new Error("Not a writable document.");
      return [...await value.writer.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }),
    digestRanges: (id: number, source: "cached" | "partial", ranges: readonly { offset: number; size: number }[]) => run(async () => {
      checkRanges(ranges);
      const value = handle(id), file = source === "cached" ? value.reader : value.writer;
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
    }),
    copyRanges: (id: number, ranges: readonly { offset: number; size: number }[]) => run(async () => {
      checkRanges(ranges);
      const value = handle(id);
      if (!value.download || !value.reader) throw new Error("Cached source is unavailable.");
      for (const range of ranges) {
        if (range.offset + range.size > value.reader.size) throw new Error("Cached range is unavailable.");
        for (let done = 0; done < range.size; done += 131072) {
          const data = await value.reader.readRange(range.offset + done, Math.min(131072, range.size - done));
          try { await write(id, range.offset + done, data); } finally { data.fill(0); }
        }
      }
    }),
    remove: (id: string) => run(async () => {
      const file = resolve(id);
      const current = await file.replica.scan();
      const old = current.find(info => info.name === file.path && !info.deleted);
      if (!old) return false;
      const paths = old.type === 1
        ? current.filter(info => !info.deleted && (info.name === file.path || info.name.startsWith(file.path + "/")))
          .map(info => info.name)
        : [file.path];
      await removePaths(file.replica, file.folder.id, paths);
      return true;
    }),
    rename: (id: string, name: string) => run(async () => {
      assertReplicaPath(name);
      if (name.includes("/")) throw new Error("Expected one document name.");
      const file = resolve(id), current = await file.replica.scan();
      const old = current.find(info => info.name === file.path && !info.deleted);
      if (!old) throw new Error("Document is unavailable.");
      if (old.type === 1 && current.some(info => !info.deleted && info.name.startsWith(file.path + "/"))) {
        throw new Error("Non-empty directories cannot be renamed safely.");
      }
      const parent = file.path.split("/").slice(0, -1).join("/"), target = parent ? `${parent}/${name}` : name;
      if (target === file.path) return stat(id);
      const previousTarget = current.find(info => info.name === target);
      if (previousTarget && !previousTarget.deleted) throw new Error("A document with that name already exists.");
      const modifiedMs = Date.now();
      const created = old.type === 1
        ? await file.replica.edit!({ method: "mkdir", folderId: file.folder.id, path: target,
          modifiedMs, expectedVersion: previousTarget?.version ?? null })
        : await file.replica.edit!({ method: "write", folderId: file.folder.id, path: target, modifiedMs,
          expectedVersion: previousTarget?.version ?? null, source: await createReplicaFileSource(file.replica, file.path) });
      try {
        await file.replica.edit!({ method: "delete", folderId: file.folder.id, path: file.path,
          modifiedMs, expectedVersion: old.version ?? {} });
      } catch (error) {
        await file.replica.edit!({ method: "delete", folderId: file.folder.id, path: target,
          modifiedMs, expectedVersion: created.version ?? {} }).catch(() => {});
        throw error;
      }
      return stat(JSON.stringify([file.folder.storageId, target]));
    }),
    stat: (id: string) => run(async () => {
      const root = (await configs.load()).find(folder => id === JSON.stringify([folder.storageId, ""]));
      return root ? entry(root, "", 0, true) : stat(id);
    }),
    list: (id: string) => run(async () => {
      if (id === "syncpeer-root") return (await configs.load()).map(folder => entry(folder, "", 0, true));
      if (vault.status().phase !== "unlocked") throw new Error("Document vault is locked.");
      const root = registry!.getState().find(folder => id === JSON.stringify([folder.storageId, ""]));
      if (root && !registry!.getReplica(root.id)) return [];
      const { folder, path, replica } = resolve(id);
      if (!(await stat(id)).directory) throw new Error("Document is not a directory.");
      const prefix = path ? path + "/" : "";
      return (await replica.scan()).filter(file => !file.deleted && !file.invalid && [0, 1].includes(Number(file.type ?? 0)) &&
        file.name.startsWith(prefix) && !file.name.slice(prefix.length).includes("/") && file.name !== path)
        .map(file => entry(folder, file.name, Number(file.size ?? 0), file.type === 1, Number(file.modified_s ?? 0) * 1000));
    }),
    create: (parentId: string, name: string, directory: boolean) => run(async () => {
      assertReplicaPath(name); if (name.includes("/")) throw new Error("Expected one document name.");
      const parent = resolve(parentId), path = parent.path ? parent.path + "/" + name : name;
      if (!(await stat(parentId)).directory) throw new Error("Parent is not a directory.");
      await parent.replica.edit!({ folderId: parent.folder.id, path, modifiedMs: Date.now(), expectedVersion: null,
        ...(directory ? { method: "mkdir" as const } : { method: "write" as const, source: { size: 0, readRange: async () => new Uint8Array() } }) });
      return stat(JSON.stringify([parent.folder.storageId, path]));
    }),
    open: (id: string, mode: string) => run(async () => {
      if (handles.size >= 64) throw new Error("Too many open documents.");
      if (!["r", "w", "wt", "wa", "rw", "rwt"].includes(mode)) throw new Error("Unsupported document mode.");
      const file = resolve(id);
      if ((await stat(id)).directory) throw new Error("Cannot open a directory.");
      const value: ReturnType<typeof handle> = { documentId: id, dirty: false, append: mode === "wa" };
      if (mode === "r") value.reader = await createReplicaFileSource(file.replica, file.path);
      else {
        value.dirty = ["w", "wt", "rwt"].includes(mode);
        value.writer = await writable(id, value.dirty);
      }
      const idNumber = ++nextHandle; handles.set(idNumber, value); return idNumber;
    }),
    size: (id: number) => run(async () => { const value = handle(id); return value.writer ? value.writer.size() : value.reader!.size; }),
    read: (id: number, offset: number, size: number) => run(() => {
      const value = handle(id); return (value.writer ?? value.reader!).readRange(offset, size);
    }),
    write: (id: number, offset: number, bytes: Uint8Array) => run(() => write(id, offset, bytes)),
    flush: (id: number) => run(async () => {
      const value = handle(id); if (!value.writer || !value.dirty) return;
      if (value.download) throw new Error("Use download completion to publish this handle.");
      try {
        await value.writer.flush(); value.dirty = false;
      } catch (error) {
        handles.delete(id);
        await value.writer.close();
        recoveryIssues.set(resolve(value.documentId).folder.storageId, ["An encrypted edit needs recovery. Lock and unlock the vault to recover it; its data has been retained."]);
        throw error;
      }
    }),
    release: (id: number, abort = false) => run(async () => {
      const value = handle(id); handles.delete(id);
      if (abort || value.download) { await value.writer?.discard(); return; }
      try { if (value.dirty) await value.writer!.flush(); }
      catch (error) {
        recoveryIssues.set(resolve(value.documentId).folder.storageId, ["An encrypted edit needs recovery. Lock and unlock the vault to recover it; its data has been retained."]);
        throw error;
      }
      finally { await value.writer?.close(); }
    }),
    close: () => {
      closed = true;
      closeTask ??= queue.then(async () => { await vault.close(); await options.profile.close(); });
      return closeTask;
    },
  };
}
