import { sha256 } from "@noble/hashes/sha2.js";
import type { CachedFileRecord, FavoriteRecord, FavoriteSyncStateRecord,
  SyncpeerPlatformAdapter } from "../ui/browserClient.js";
import type { FileDownloadSink } from "../transfer/stream.js";
import { sameDownloadMetadata } from "../transfer/stream.js";
import type { FolderRegistration } from "./folderRegistry.js";
import { assertReplicaPath } from "./replicaPaths.js";
import type { FolderInfo } from "../core/model/remoteFs.js";
import { defaultFolderSettings, defaultProfileSettings, type SyncpeerProfileSettings } from "./profileSettings.js";
import type { OwnedSpaceDevice } from "./personalSpaceSharing.js";

/** Route prepared folders to the service owner, never mirror two writable copies.
 * Migration changes ownership only after bytes and cleanup have been verified.
 */
export function createDocumentCache(options: {
  enabled: () => boolean;
  request: <T>(input: Record<string, unknown>) => Promise<T>;
  legacy: SyncpeerPlatformAdapter;
  openLegacySource: (file: CachedFileRecord) => Promise<{
    size: number; readRange: (offset: number, size: number) => Promise<Uint8Array>;
    verify: () => Promise<void>; close: () => Promise<void>;
  }>;
  show: (id: string) => Promise<void>;
}) {
  const active = new Map<string, number>(), migrating = new Set<string>();
  type CacheStatus = { vault: { phase: string }; folders: FolderRegistration[] };
  const cacheStatus = () => options.request<CacheStatus>({ operation: "cacheRegistrations" });
  const registrations = async () => options.enabled() ? (await cacheStatus()).folders : [];
  const owner = async (folderId: string) => {
    if (migrating.has(folderId)) throw new Error("This folder is being moved to encrypted document storage. Retry when migration finishes.");
    if (!options.enabled()) return undefined;
    const status = await cacheStatus();
    // An uninitialized vault still needs to expose existing legacy files; lock never does.
    if (status.vault.phase === "uninitialized") return undefined;
    if (status.vault.phase !== "unlocked") {
      throw new Error("Encrypted folder storage is locked. Unlock the vault before downloading.");
    }
    return status.folders.find(folder => folder.id === folderId && folder.downloads);
  };
  const documentId = (folder: FolderRegistration, path: string) => JSON.stringify([folder.storageId, path]);
  const track = (folderId: string) => {
    if (migrating.has(folderId)) throw new Error("Folder migration is in progress.");
    active.set(folderId, (active.get(folderId) ?? 0) + 1);
    let released = false;
    return () => { if (!released) { released = true; active.set(folderId, active.get(folderId)! - 1); } };
  };
  const request = options.request;
  const loadProfileSettings = async () => {
    if (!options.enabled()) return options.legacy.loadProfileSettings?.() ?? defaultProfileSettings();
    const status = await cacheStatus();
    return status.vault.phase === "uninitialized"
      ? defaultProfileSettings()
      : request<SyncpeerProfileSettings>({ operation: "profileSettings" });
  };
  const saveProfileSettings = async (settings: SyncpeerProfileSettings) => {
    if (options.enabled()) {
      await request({ operation: "saveProfileSettings", settings });
      await request({ operation: "enforceCacheQuota" });
    }
    else if (options.legacy.saveProfileSettings) await options.legacy.saveProfileSettings(settings);
    else throw new Error("Encrypted profile settings are unavailable.");
  };
  const listFavorites = async () => Object.values((await loadProfileSettings()).folders)
    .flatMap(folder => folder.favorites)
    .sort((left, right) => left.name.localeCompare(right.name));
  const updateFavorites = async (transform: (favorites: FavoriteRecord[]) => FavoriteRecord[]) => {
    const settings = await loadProfileSettings();
    const favorites = transform(Object.values(settings.folders).flatMap(folder => folder.favorites));
    const folderIds = new Set([...Object.keys(settings.folders), ...favorites.map(item => item.folderId)]);
    settings.folders = Object.fromEntries([...folderIds].map(folderId => {
      const current = settings.folders[folderId] ?? defaultFolderSettings();
      return [folderId, { ...current, favorites: favorites.filter(item => item.folderId === folderId) }];
    }));
    await saveProfileSettings(settings);
    return favorites.sort((left, right) => left.name.localeCompare(right.name));
  };
  let favoritesMigrated = false;
  const listMigratedFavorites = async () => {
    const secure = await listFavorites();
    if (favoritesMigrated || secure.length || !options.legacy.listFavorites) {
      favoritesMigrated = true; return secure;
    }
    const legacy = await options.legacy.listFavorites();
    favoritesMigrated = true;
    if (!legacy.length) return secure;
    const migrated = await updateFavorites(() => legacy);
    if (options.legacy.removeFavorite) {
      for (const favorite of legacy) await options.legacy.removeFavorite(favorite.key);
    }
    return migrated;
  };
  const legacyFiles = async (folderId: string) =>
    (await options.legacy.listCachedFiles?.() ?? []).filter(file => file.folderId === folderId);
  const removeLegacyFile = async (file: CachedFileRecord) => {
    if (!options.legacy.removeCachedFile) {
      throw new Error("The old local copy cannot be removed safely; migration was not completed.");
    }
    if (!await options.legacy.removeCachedFile(file.folderId, file.path)) {
      throw new Error("The old local copy could not be removed; migration was not completed.");
    }
    if ((await legacyFiles(file.folderId)).some(value => value.folderId === file.folderId && value.path === file.path)) {
      throw new Error("The old local copy is still present; migration was not completed.");
    }
  };
  const readSourceBytes = async (id: string) => {
    const file = await source(id);
    try {
      const bytes = new Uint8Array(file.size);
      for (let offset = 0; offset < file.size; offset += 131072) {
        const chunk = await file.readRange(offset, Math.min(131072, file.size - offset));
        try { bytes.set(chunk, offset); } finally { chunk.fill(0); }
      }
      return bytes;
    } finally { await file.close(); }
  };
  const digestReader = async (reader: { size: number; readRange: (offset: number, size: number) => Promise<Uint8Array> }) => {
    const hash = sha256.create();
    for (let offset = 0; offset < reader.size; offset += 131072) {
      const chunk = await reader.readRange(offset, Math.min(131072, reader.size - offset));
      try { hash.update(chunk); } finally { chunk.fill(0); }
    }
    return [...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
  };
  const source = async (id: string) => {
    const handle = await request<number>({ operation: "open", id, mode: "r" });
    return { size: await request<number>({ operation: "size", handle }),
      readRange: async (offset: number, size: number) => new Uint8Array(await request<number[]>({ operation: "read", handle, offset, size })),
      close: () => request<void>({ operation: "release", handle }) };
  };
  const sink = (folderId: string, path: string, modifiedMs = 0, expectedLocalHash?: string | null): FileDownloadSink => {
    let handle: number | undefined;
    let metadata: Parameters<FileDownloadSink["begin"]>[0] | undefined;
    let completedRanges: Array<{ offset: number; size: number }> = [];
    const rememberRange = (offset: number, size: number) => {
      const ranges = [...completedRanges.map(range => ({ offset: range.offset, end: range.offset + range.size })),
        { offset, end: offset + size }].sort((left, right) => left.offset - right.offset);
      completedRanges = ranges.reduce<Array<{ offset: number; size: number }>>((result, range) => {
        const previous = result.at(-1);
        if (previous && range.offset <= previous.offset + previous.size) {
          previous.size = Math.max(previous.offset + previous.size, range.end) - previous.offset;
        } else result.push({ offset: range.offset, size: range.end - range.offset });
        return result;
      }, []);
    };
    const digestRanges = async (source: "cached" | "partial", ranges: readonly { offset: number; size: number }[]) => {
      const result: Array<{ offset: number; size: number; hash: Uint8Array }> = [];
      for (let offset = 0; offset < ranges.length; offset += 256) {
        const batch = await request<Array<{ offset: number; size: number; hash: number[] }>>({
          operation: "digestRanges", handle, source, ranges: ranges.slice(offset, offset + 256),
        });
        result.push(...batch.map(range => ({ ...range, hash: new Uint8Array(range.hash) })));
      }
      return result;
    };
    return {
      digestCachedRanges: ranges => digestRanges("cached", ranges),
      digestPartialRanges: ranges => digestRanges("partial", ranges),
      copyCachedRanges: async ranges => {
        for (let offset = 0; offset < ranges.length; offset += 256) {
          await request({ operation: "copyRanges", handle, ranges: ranges.slice(offset, offset + 256) });
        }
      },
      begin: async value => {
        if (handle !== undefined) {
          if (!metadata || !sameDownloadMetadata(metadata, value)) throw new Error("Download metadata changed.");
          return;
        }
        handle = await request<number>({ operation: "beginDownload", folderId, path, size: value.sizeBytes, modifiedMs,
          expectedLocalHash, encrypted: value.encrypted, sourceDeviceId: value.sourceDeviceId, contentId: value.contentId });
        completedRanges = await request<Array<{ offset: number; size: number }>>({ operation: "downloadRanges", handle });
        metadata = value;
      },
      write: async (offset, bytes) => {
        if (handle === undefined) throw new Error("Download has not started.");
        for (let done = 0; done < bytes.length; done += 131072) {
          const chunk = bytes.subarray(done, done + 131072);
          await request({ operation: "write", handle, offset: offset + done, bytes: Array.from(chunk) });
          rememberRange(offset + done, chunk.length);
        }
      },
      hasRange: (offset, size) => completedRanges.some(range => offset >= range.offset && offset + size <= range.offset + range.size),
      digestFile: () => request<string>({ operation: "digest", handle }),
      commit: async () => {
        if (handle === undefined) throw new Error("Download has not started.");
        await request({ operation: "finishDownload", handle }); handle = undefined;
      },
      abort: async () => {
        if (handle !== undefined) { await request({ operation: "release", handle, abort: true }); handle = undefined; }
      },
      suspend: async () => {
        if (handle !== undefined) { await request({ operation: "suspendDownload", handle }); handle = undefined; }
      },
    };
  };
  const createFileDownloadSink: NonNullable<SyncpeerPlatformAdapter["createFileDownloadSink"]> = async args => {
    await folderQueue;
    const release = track(args.folderId);
    let destination: FileDownloadSink;
    try {
      const folder = await owner(args.folderId);
      if (folder) destination = sink(args.folderId, args.path, args.modifiedMs, args.expectedLocalHash);
      else {
        if (options.enabled()) throw new Error("Encrypted folder storage is not ready. Unlock the folder before downloading.");
        if (!options.legacy.createFileDownloadSink) throw new Error("Download storage is unavailable.");
        destination = await options.legacy.createFileDownloadSink(args);
      }
    } catch (error) { release(); throw error; }
    return { ...destination,
      commit: async () => {
        try {
          await destination.commit();
          if (options.enabled()) await request({ operation: "enforceCacheQuota" });
        } finally { release(); }
      },
      abort: async error => { try { await destination.abort(error); } finally { release(); } },
      ...(destination.suspend ? { suspend: async () => { try { await destination.suspend!(); } finally { release(); } } } : {}),
    };
  };
  const listCachedFiles = async () => {
    const attached = (await registrations()).filter(folder => folder.downloads);
    const legacy = await options.legacy.listCachedFiles?.() ?? [];
    if (!attached.length) return legacy;
    return legacy.filter(file => !attached.some(folder => folder.id === file.folderId))
      .concat(await request<CachedFileRecord[]>({ operation: "cachedFiles" }));
  };
  const show = async (folderId: string, path: string, parent: boolean) => {
    const folder = await owner(folderId);
    if (!folder) {
      const method = parent ? options.legacy.openCachedFileDirectory : options.legacy.openCachedFile;
      if (!method) throw new Error("Opening cached documents is unavailable.");
      await method(folderId, path); return;
    }
    await options.show(documentId(folder, parent ? path.split("/").slice(0, -1).join("/") : path));
  };
  const platformAdapter: SyncpeerPlatformAdapter = { ...options.legacy, createFileDownloadSink, listCachedFiles,
    exportPairingTransfer: (localDeviceId, joiningDevice) => request({ operation: "exportPairingTransfer",
      localDeviceId, joiningDevice }),
    importPairingTransfer: async (transfer, identity, password, remember) => {
      await request({ operation: "importPairingTransfer", transfer, identity, password, remember });
    },
    ownedDevices: async () => (await request<{ devices: OwnedSpaceDevice[] }>({ operation: "ownedDevices" })).devices,
    revokeOwnedDevice: deviceId => request({ operation: "revokeOwnedDevice", deviceId }),
    sessionSharedFolders: async remoteDeviceId => {
      if (!options.enabled() || (await cacheStatus()).vault.phase !== "unlocked") return [];
      return request({ operation: "sessionSharedFolders", remoteDeviceId });
    },
    loadProfileSettings,
    saveProfileSettings,
    loadDirectorySnapshot: (folderId, sourceDeviceId, path) => request({
      operation: "loadDirectorySnapshot", folderId, sourceDeviceId, path,
    }),
    saveDirectorySnapshot: (folderId, sourceDeviceId, path, snapshot) => request({
      operation: "saveDirectorySnapshot", folderId, sourceDeviceId, path, snapshot,
    }),
    enforceCacheQuota: () => request({ operation: "enforceCacheQuota" }),
    listDocumentVersions: async (folderId, path) => {
      const folder = await owner(folderId);
      if (!folder) throw new Error("Encrypted version history is unavailable for this folder.");
      return request({ operation: "versions", id: documentId(folder, path) });
    },
    restoreDocumentVersion: async (folderId, path, versionId) => {
      const folder = await owner(folderId);
      if (!folder) throw new Error("Encrypted version history is unavailable for this folder.");
      await request({ operation: "restoreVersion", id: documentId(folder, path), versionId });
    },
    listFavoriteSyncStates: async folderIds => {
      const states = [];
      for (const folderId of folderIds) {
        if (!await owner(folderId)) continue;
        const state = await request<{ entries: Record<string, Omit<FavoriteSyncStateRecord, "path">> }>(
          { operation: "favoriteSyncState", folderId });
        states.push({ folderId,
          entries: Object.entries(state.entries).map(([path, entry]) => ({ path, ...entry })) });
      }
      return states;
    },
    retryFavoriteSync: async (folderId, path) => {
      if (!await owner(folderId)) throw new Error("Encrypted folder storage is not ready.");
      await request({ operation: "clearFavoriteSyncEntry", folderId, path });
    },
    resolveFavoriteConflict: async (folderId, path, resolution) => {
      if (!await owner(folderId)) throw new Error("Encrypted folder storage is not ready.");
      await request({ operation: "recordFavoriteResolution", folderId, path, resolution });
    },
    listFavorites: () => options.enabled() ? listMigratedFavorites() : options.legacy.listFavorites?.() ?? Promise.resolve([]),
    upsertFavorite: favorite => options.enabled()
      ? updateFavorites(favorites => [...favorites.filter(item => item.key !== favorite.key), favorite])
      : options.legacy.upsertFavorite?.(favorite) ?? Promise.reject(new Error("Favorite storage is unavailable.")),
    removeFavorite: key => options.enabled()
      ? updateFavorites(favorites => favorites.filter(item => item.key !== key))
      : options.legacy.removeFavorite?.(key) ?? Promise.reject(new Error("Favorite storage is unavailable.")),
    listLocalDirectory: async (folderId, path) => {
      const folder = (await registrations()).find(folder => folder.id === folderId);
      if (!folder) return await options.legacy.listLocalDirectory?.(folderId, path) ?? null;
      if (path) assertReplicaPath(path);
      const entries = await request<Array<{ name: string; directory: boolean; size: number; modifiedMs: number }>>({
        operation: "list", id: documentId(folder, path),
      });
      return entries.map(entry => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name,
        type: entry.directory ? "directory" as const : "file" as const, size: entry.size, modifiedMs: entry.modifiedMs }));
    },
    acknowledgeCachedSync: async (folderId, path, baseline) => {
      const folder = await owner(folderId);
      if (!folder) return false;
      await request({ operation: "setSyncBaseline", id: documentId(folder, path), ...baseline });
      return true;
    },
    cacheFile: async (folderId, path, name, bytes, modifiedMs) => {
      await folderQueue;
      const release = track(folderId);
      try {
        if (!await owner(folderId)) {
          if (options.enabled()) throw new Error("Encrypted folder storage is not ready. Unlock the folder before downloading.");
          if (!options.legacy.cacheFile) throw new Error("Cache is unavailable.");
          await options.legacy.cacheFile(folderId, path, name, bytes, modifiedMs); return;
        }
        const target = sink(folderId, path, modifiedMs);
        try { await target.begin({ folderId, path, sizeBytes: bytes.length, encrypted: false });
          await target.write(0, bytes); await target.commit();
          await request({ operation: "enforceCacheQuota" }); }
        catch (error) { await target.abort(error); throw error; }
      } finally { release(); }
    },
    getCachedStatuses: async (folderId, paths) => {
      if (!await owner(folderId)) return await options.legacy.getCachedStatuses?.(folderId, paths) ?? [];
      return request({ operation: "cachedStatuses", folderId, paths });
    },
    readBinaryFile: async path => {
      if (!path.startsWith("syncpeer-document:")) {
        if (!options.legacy.readBinaryFile) throw new Error("File reads are unavailable.");
        return options.legacy.readBinaryFile(path);
      }
      const file = await source(path.slice("syncpeer-document:".length));
      try {
        const bytes = new Uint8Array(file.size);
        for (let offset = 0; offset < file.size; offset += 131072) {
          const chunk = await file.readRange(offset, Math.min(131072, file.size - offset));
          try { bytes.set(chunk, offset); } finally { chunk.fill(0); }
        }
        return bytes;
      } finally { await file.close(); }
    },
    openCachedFile: (folderId, path) => show(folderId, path, false),
    openCachedFileDirectory: (folderId, path) => show(folderId, path, true),
    openCachedDirectory: async (folderId, path) => {
      const folder = await owner(folderId);
      if (folder) await options.show(documentId(folder, path));
      else await options.legacy.openCachedDirectory?.(folderId, path);
    },
    removeCachedFile: async (folderId, path) => {
      const folder = await owner(folderId);
      return folder ? request<boolean>({ operation: "remove", id: documentId(folder, path) })
        : await options.legacy.removeCachedFile?.(folderId, path) ?? false;
    },
    clearCache: async () => {
      if ((await registrations()).some(folder => folder.downloads)) throw new Error("Encrypted documents may contain local edits. Remove individual downloads instead; preserved migration backups are not cleared automatically.");
      await options.legacy.clearCache?.();
    },
  };
  const connectFolder = async (folder: { id: string; label: string; password?: string }) => {
    if (!options.enabled()) throw new Error("Document storage is unavailable.");
    if (migrating.has(folder.id) || active.get(folder.id)) throw new Error("Wait for this folder’s transfers to finish before moving it.");
    migrating.add(folder.id);
    try {
      let registered = (await registrations()).find(value => value.id === folder.id);
      await request({ operation: "register", ...folder });
      if (registered?.downloads) return;
      registered = (await registrations()).find(value => value.id === folder.id)!;
      const files = await legacyFiles(folder.id);
      const existing = await request<CachedFileRecord[]>({ operation: "folderFiles", folderId: folder.id });
      for (const file of files) {
        assertReplicaPath(file.path);
        const original = await options.openLegacySource(file);
        const target = sink(folder.id, file.path, file.modifiedMs ?? file.cachedAtMs,
          existing.some(value => value.path === file.path) ? undefined : null);
        try {
          if (original.size !== file.sizeBytes) throw new Error("Cached file changed. Refresh downloads before migration.");
          await target.begin({ folderId: folder.id, path: file.path, sizeBytes: original.size, encrypted: false });
          const hash = sha256.create();
          for (let offset = 0; offset < original.size; offset += 131072) {
            const data = await original.readRange(offset, Math.min(131072, original.size - offset));
            try { hash.update(data); await target.write(offset, data); } finally { data.fill(0); }
          }
          const expected = [...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (await target.digestFile!() !== expected) throw new Error("Document migration verification failed.");
          await original.verify();
          if (existing.some(value => value.path === file.path)) {
            const current = await source(documentId(registered, file.path)), currentHash = sha256.create();
            try {
              for (let offset = 0; offset < current.size; offset += 131072) {
                const data = await current.readRange(offset, Math.min(131072, current.size - offset));
                try { currentHash.update(data); } finally { data.fill(0); }
              }
              if (current.size !== original.size || [...currentHash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("") !== expected) {
                throw new Error("A document already contains different data. Migration left both copies unchanged.");
              }
            } finally { await current.close(); }
            await request({ operation: "setSyncBaseline", id: documentId(registered, file.path), hash: expected,
              sizeBytes: original.size, modifiedMs: file.modifiedMs ?? file.cachedAtMs });
            await target.abort(new Error("Already imported"));
          } else await target.commit();
          await removeLegacyFile(file);
        } catch (error) { await target.abort(error); throw error; }
        finally { await original.close(); }
      }
      await request({ operation: "attachDownloads", id: folder.id });
    } finally { migrating.delete(folder.id); }
  };
  const disconnectFolder = async (folderId: string) => {
    if (!options.enabled()) throw new Error("Document storage is unavailable.");
    if (migrating.has(folderId) || active.get(folderId)) throw new Error("Wait for this folder’s transfers to finish before moving it.");
    const registered = (await registrations()).find(value => value.id === folderId && value.downloads);
    if (!registered) throw new Error("Encrypted folder storage is not attached.");
    if (!options.legacy.cacheFile || !options.legacy.listCachedFiles || !options.legacy.removeCachedFile) {
      throw new Error("Plain local storage is unavailable; migration was not completed.");
    }
    migrating.add(folderId);
    try {
      const encrypted = await request<CachedFileRecord[]>({ operation: "folderFiles", folderId });
      const staged: Array<{ file: CachedFileRecord; bytes: Uint8Array; hash: string }> = [];
      try {
        for (const file of encrypted) {
          if (!file.localPath?.startsWith("syncpeer-document:")) throw new Error("Encrypted document path is unavailable.");
          const bytes = await readSourceBytes(file.localPath.slice("syncpeer-document:".length));
          try {
            const hash = await digestReader({ size: bytes.length, readRange: async (offset, size) => bytes.slice(offset, offset + size) });
            await options.legacy.cacheFile(folderId, file.path, file.name, bytes, file.modifiedMs ?? file.cachedAtMs);
            staged.push({ file, bytes, hash });
          } finally { bytes.fill(0); }
        }
        for (const stagedFile of staged) {
          const copy = (await legacyFiles(folderId)).find(value => value.path === stagedFile.file.path);
          if (!copy) throw new Error("Plain local copy was not created; migration was not completed.");
          const original = await options.openLegacySource(copy);
          try {
            if (original.size !== stagedFile.file.sizeBytes || await digestReader(original) !== stagedFile.hash) {
              throw new Error("Plain local copy failed verification; encrypted data was retained.");
            }
          } finally { await original.close(); }
        }
        await request({ operation: "clearFolderContents", folderId });
        await request({ operation: "detachDownloads", id: folderId });
      } finally { staged.forEach(value => value.bytes.fill(0)); }
    } finally { migrating.delete(folderId); }
  };
  let folderQueue = Promise.resolve();
  const observed = new Map<string, string>();
  const syncFolders = (folders: FolderInfo[], passwords: Record<string, string>) => {
    const task = folderQueue.then(async () => {
      if (!options.enabled()) return [];
      // Discovery must finish even if preparing one folder's contents later fails.
      for (const folder of folders) {
        await request({ operation: "rememberFolder", id: folder.id, label: folder.label || folder.id });
      }
      for (const folder of folders) {
        const signature = JSON.stringify([folder.label, folder.encrypted, folder.needsPassword, passwords[folder.id]]);
        if (observed.get(folder.id) === signature) continue;
        if (!folder.needsPassword && (!folder.encrypted || passwords[folder.id])) {
          await connectFolder({ id: folder.id, label: folder.label || folder.id, password: passwords[folder.id] });
        }
        observed.set(folder.id, signature);
      }
      return registrations();
    });
    folderQueue = task.then(() => {}, () => {});
    return task;
  };
  return { platformAdapter, connectFolder, disconnectFolder, syncFolders };
}
