import { sha256 } from "@noble/hashes/sha2.js";
import type { CachedFileRecord, CachedFileStatus, FavoriteRecord, FavoriteSyncStateRecord,
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
type DocumentCacheOptions = {
  enabled: () => boolean;
  request: <T>(input: Record<string, unknown>) => Promise<T>;
  legacy: SyncpeerPlatformAdapter;
  openLegacySource: (file: CachedFileRecord) => Promise<{
    size: number; readRange: (offset: number, size: number) => Promise<Uint8Array>;
    verify: () => Promise<void>; close: () => Promise<void>;
  }>;
  show: (id: string) => Promise<void>;
};

type CacheStatus = { vault: { phase: string }; folders: FolderRegistration[] };

class DocumentCache {
  private readonly options: DocumentCacheOptions;
  private readonly active = new Map<string, number>();
  private readonly migrating = new Map<string, Promise<void>>();
  private readonly observed = new Map<string, string>();
  private favoritesMigrated = false;
  private folderQueue = Promise.resolve();

  constructor(options: DocumentCacheOptions) {
    this.options = options;
  }

  private request<T>(input: Record<string, unknown>) {
    return this.options.request<T>(input);
  }

  private cacheStatus() {
    return this.request<CacheStatus>({ operation: "cacheRegistrations" });
  }

  private async registrations() {
    return this.options.enabled() ? (await this.cacheStatus()).folders : [];
  }

  private async waitForMigration(folderId: string) {
    while (this.migrating.has(folderId)) await this.migrating.get(folderId);
  }

  private async owner(folderId: string) {
    while (true) {
      await this.waitForMigration(folderId);
      if (!this.options.enabled()) return undefined;
      const status = await this.cacheStatus();
      if (this.migrating.has(folderId)) continue;
      // An uninitialized vault still needs to expose existing legacy files; lock never does.
      if (status.vault.phase === "uninitialized") return undefined;
      if (status.vault.phase !== "unlocked") {
        throw new Error("Encrypted folder storage is locked. Unlock the vault before downloading.");
      }
      return status.folders.find(folder => folder.id === folderId && folder.downloads);
    }
  }

  private documentId(folder: FolderRegistration, path: string) {
    return JSON.stringify([folder.storageId, path]);
  }

  private async track(folderId: string) {
    while (this.migrating.has(folderId)) await this.migrating.get(folderId);
    this.active.set(folderId, (this.active.get(folderId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(folderId, this.active.get(folderId)! - 1);
    };
  }

  private async loadProfileSettings() {
    if (!this.options.enabled()) return this.options.legacy.loadProfileSettings?.() ?? defaultProfileSettings();
    const status = await this.cacheStatus();
    return status.vault.phase === "uninitialized"
      ? defaultProfileSettings()
      : this.request<SyncpeerProfileSettings>({ operation: "profileSettings" });
  }

  private async saveProfileSettings(settings: SyncpeerProfileSettings) {
    if (this.options.enabled()) {
      await this.request({ operation: "saveProfileSettings", settings });
      await this.request({ operation: "enforceCacheQuota" });
    } else if (this.options.legacy.saveProfileSettings) {
      await this.options.legacy.saveProfileSettings(settings);
    } else throw new Error("Encrypted profile settings are unavailable.");
  }

  private async listFavorites() {
    return Object.values((await this.loadProfileSettings()).folders)
      .flatMap(folder => folder.favorites)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async updateFavorites(transform: (favorites: FavoriteRecord[]) => FavoriteRecord[]) {
    const settings = await this.loadProfileSettings();
    const favorites = transform(Object.values(settings.folders).flatMap(folder => folder.favorites));
    const folderIds = new Set([...Object.keys(settings.folders), ...favorites.map(item => item.folderId)]);
    settings.folders = Object.fromEntries([...folderIds].map(folderId => {
      const current = settings.folders[folderId] ?? defaultFolderSettings();
      return [folderId, { ...current, favorites: favorites.filter(item => item.folderId === folderId) }];
    }));
    await this.saveProfileSettings(settings);
    return favorites.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async listMigratedFavorites() {
    const secure = await this.listFavorites();
    if (this.favoritesMigrated || secure.length || !this.options.legacy.listFavorites) {
      this.favoritesMigrated = true;
      return secure;
    }
    const legacy = await this.options.legacy.listFavorites();
    this.favoritesMigrated = true;
    if (!legacy.length) return secure;
    const migrated = await this.updateFavorites(() => legacy);
    if (this.options.legacy.removeFavorite) {
      for (const favorite of legacy) await this.options.legacy.removeFavorite(favorite.key);
    }
    return migrated;
  }

  private async legacyFiles(folderId: string) {
    return (await this.options.legacy.listCachedFiles?.() ?? []).filter(file => file.folderId === folderId);
  }

  private async removeLegacyFile(file: CachedFileRecord) {
    if (!this.options.legacy.removeCachedFile) {
      throw new Error("The old local copy cannot be removed safely; migration was not completed.");
    }
    if (!await this.options.legacy.removeCachedFile(file.folderId, file.path)) {
      throw new Error("The old local copy could not be removed; migration was not completed.");
    }
    if ((await this.legacyFiles(file.folderId)).some(value => value.folderId === file.folderId && value.path === file.path)) {
      throw new Error("The old local copy is still present; migration was not completed.");
    }
  }

  private async readSourceBytes(id: string) {
    const file = await this.source(id);
    try {
      const bytes = new Uint8Array(file.size);
      for (let offset = 0; offset < file.size; offset += 131072) {
        const chunk = await file.readRange(offset, Math.min(131072, file.size - offset));
        try {
          bytes.set(chunk, offset);
        } finally {
          chunk.fill(0);
        }
      }
      return bytes;
    } finally {
      await file.close();
    }
  }

  private async digestReader(reader: { size: number; readRange: (offset: number, size: number) => Promise<Uint8Array> }) {
    const hash = sha256.create();
    for (let offset = 0; offset < reader.size; offset += 131072) {
      const chunk = await reader.readRange(offset, Math.min(131072, reader.size - offset));
      try {
        hash.update(chunk);
      } finally {
        chunk.fill(0);
      }
    }
    return [...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async source(id: string) {
    const handle = await this.request<number>({ operation: "open", id, mode: "r" });
    return {
      size: await this.request<number>({ operation: "size", handle }),
      readRange: async (offset: number, size: number) =>
        new Uint8Array(await this.request<number[]>({ operation: "read", handle, offset, size })),
      close: () => this.request<void>({ operation: "release", handle }),
    };
  }

  private sink(
    folderId: string,
    path: string,
    modifiedMs = 0,
    expectedLocalHash?: string | null,
  ): FileDownloadSink {
    let handle: number | undefined;
    let aborting = false;
    let metadata: Parameters<FileDownloadSink["begin"]>[0] | undefined;
    let completedRanges: Array<{ offset: number; size: number }> = [];
    const pendingWrites: Array<{ offset: number; bytes: Uint8Array; resolve: () => void;
      reject: (error: unknown) => void }> = [];
    let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushingWrites: Promise<void> | undefined;
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
    const scheduleFlush = () => {
      if (pendingFlushTimer !== undefined) return;
      pendingFlushTimer = setTimeout(() => {
        pendingFlushTimer = undefined;
        void flushPendingWrites().catch(() => {});
      }, 4);
    };
    const flushPendingWrites = async (): Promise<void> => {
      if (flushingWrites) {
        await flushingWrites.catch(() => {});
        if (pendingWrites.length) await flushPendingWrites();
        return;
      }
      if (pendingFlushTimer !== undefined) {
        clearTimeout(pendingFlushTimer);
        pendingFlushTimer = undefined;
      }
      const batch = pendingWrites.splice(0, 8);
      if (!batch.length) return;
      const task = (async () => {
        try {
          if (handle === undefined) throw new Error("Download has not started.");
          await this.request({ operation: "writeBatch", handle, writes: batch.map(({ offset, bytes }) => ({
            offset, bytes: Array.from(bytes),
          })) });
          batch.forEach(write => { rememberRange(write.offset, write.bytes.length); write.resolve(); });
        } catch (error) {
          batch.forEach(write => write.reject(error));
          throw error;
        } finally {
          batch.forEach(write => write.bytes.fill(0));
        }
      })();
      flushingWrites = task;
      try {
        await task;
      } finally {
        if (flushingWrites === task) flushingWrites = undefined;
        if (pendingWrites.length >= 8) void flushPendingWrites().catch(() => {});
        else if (pendingWrites.length) scheduleFlush();
      }
    };
    const enqueueWrite = (offset: number, bytes: Uint8Array) => new Promise<void>((resolve, reject) => {
      pendingWrites.push({ offset, bytes: bytes.slice(), resolve, reject });
      if (pendingWrites.length >= 8) void flushPendingWrites().catch(() => {});
      else scheduleFlush();
    });
    const cancelPendingWrites = (error: unknown) => {
      if (pendingFlushTimer !== undefined) clearTimeout(pendingFlushTimer);
      pendingFlushTimer = undefined;
      for (const write of pendingWrites.splice(0)) {
        write.bytes.fill(0);
        write.reject(error);
      }
    };
    const digestRanges = async (source: "cached" | "partial", ranges: readonly { offset: number; size: number }[]) => {
      const result: Array<{ offset: number; size: number; hash: Uint8Array }> = [];
      for (let offset = 0; offset < ranges.length; offset += 256) {
        const batch = await this.request<Array<{ offset: number; size: number; hash: number[] }>>({
          operation: "digestRanges", handle, source, ranges: ranges.slice(offset, offset + 256),
        });
        result.push(...batch.map(range => ({ ...range, hash: new Uint8Array(range.hash) })));
      }
      return result;
    };
    return {
      commitVerifiesBlocks: true,
      digestCachedRanges: ranges => digestRanges("cached", ranges),
      digestPartialRanges: async ranges => { await flushPendingWrites(); return digestRanges("partial", ranges); },
      copyCachedRanges: async ranges => {
        await flushPendingWrites();
        for (let offset = 0; offset < ranges.length; offset += 256) {
          await this.request({ operation: "copyRanges", handle, ranges: ranges.slice(offset, offset + 256) });
        }
      },
      begin: async value => {
        if (handle !== undefined) {
          if (!metadata || !sameDownloadMetadata(metadata, value)) throw new Error("Download metadata changed.");
          return;
        }
        handle = await this.request<number>({ operation: "beginDownload", folderId, path, size: value.sizeBytes, modifiedMs,
          expectedLocalHash, encrypted: value.encrypted, sourceDeviceId: value.sourceDeviceId, contentId: value.contentId,
          ...(value.blocks ? { blocks: value.blocks.map(block => ({
            offset: block.offset, size: block.size, hash: Array.from(block.hash),
          })) } : {}) });
        completedRanges = await this.request<Array<{ offset: number; size: number }>>({ operation: "downloadRanges", handle });
        metadata = value;
      },
      write: async (offset, bytes) => {
        if (handle === undefined || aborting) throw new Error("Download is not writable.");
        for (let done = 0; done < bytes.length;) {
          const batch: Promise<void>[] = [];
          for (let count = 0; count < 8 && done < bytes.length; count += 1) {
            const chunk = bytes.subarray(done, done + 131072);
            batch.push(enqueueWrite(offset + done, chunk));
            done += chunk.length;
          }
          await Promise.all(batch);
        }
      },
      hasRange: (offset, size) => completedRanges.some(range => offset >= range.offset && offset + size <= range.offset + range.size),
      digestFile: async () => { await flushPendingWrites(); return this.request<string>({ operation: "digest", handle }); },
      commit: async () => {
        if (handle === undefined) throw new Error("Download has not started.");
        await flushPendingWrites();
        await this.request({ operation: "finishDownload", handle });
        handle = undefined;
      },
      abort: async error => {
        aborting = true;
        cancelPendingWrites(error ?? new Error("Download aborted."));
        if (flushingWrites) await flushingWrites.catch(() => {});
        if (handle !== undefined) {
          await this.request({ operation: "release", handle, abort: true });
          handle = undefined;
        }
      },
      suspend: async () => {
        await flushPendingWrites();
        if (handle !== undefined) {
          await this.request({ operation: "suspendDownload", handle });
          handle = undefined;
        }
      },
    };
  }

  private async createFileDownloadSink(args: Parameters<NonNullable<SyncpeerPlatformAdapter["createFileDownloadSink"]>>[0]) {
    await this.folderQueue;
    const release = await this.track(args.folderId);
    let destination: FileDownloadSink;
    try {
      const folder = await this.owner(args.folderId);
      if (folder) destination = this.sink(args.folderId, args.path, args.modifiedMs, args.expectedLocalHash);
      else {
        if (this.options.enabled()) throw new Error("Encrypted folder storage is not ready. Unlock the folder before downloading.");
        if (!this.options.legacy.createFileDownloadSink) throw new Error("Download storage is unavailable.");
        destination = await this.options.legacy.createFileDownloadSink(args);
      }
    } catch (error) {
      release();
      throw error;
    }
    return this.releaseDownloadSink(destination, release);
  }

  private releaseDownloadSink(destination: FileDownloadSink, release: () => void): FileDownloadSink {
    return { ...destination,
      commit: async () => {
        try {
          await destination.commit();
          if (this.options.enabled()) await this.request({ operation: "enforceCacheQuota" });
        } finally {
          release();
        }
      },
      abort: async (error: unknown) => {
        try {
          await destination.abort(error);
        } finally {
          release();
        }
      },
      ...(destination.suspend ? { suspend: async () => {
        try {
          await destination.suspend!();
        } finally {
          release();
        }
      } } : {}),
    };
  }

  private async listCachedFiles() {
    const attached = (await this.registrations()).filter(folder => folder.downloads);
    const legacy = await this.options.legacy.listCachedFiles?.() ?? [];
    if (!attached.length) return legacy;
    return legacy.filter(file => !attached.some(folder => folder.id === file.folderId))
      .concat(await this.request<CachedFileRecord[]>({ operation: "cachedFiles" }));
  }

  private async digestCachedFiles(files: readonly { folderId: string; path: string }[]) {
    const encryptedFiles: Array<{ folderId: string; path: string }> = [];
    const legacy: Array<{ folderId: string; path: string }> = [];
    for (const file of files) {
      const folder = await this.owner(file.folderId);
      if (!folder) {
        legacy.push(file);
        continue;
      }
      encryptedFiles.push(file);
    }
    const current = encryptedFiles.length ? await this.request<Array<{ folderId: string; path: string; hash: string }>>(
      { operation: "digestCachedFiles", files: encryptedFiles }) : [];
    const old = legacy.length ? await this.options.legacy.digestCachedFiles?.(legacy) ?? [] : [];
    const encrypted = new Map(current.map(file => [JSON.stringify([file.folderId, file.path]), file.hash]));
    const legacyByKey = new Map(old.map(file => [JSON.stringify([file.folderId, file.path]), file.hash]));
    return files.map(file => ({ ...file, hash: encrypted.get(JSON.stringify([file.folderId, file.path]))
      ?? legacyByKey.get(JSON.stringify([file.folderId, file.path])) }));
  }

  private async show(folderId: string, path: string, parent: boolean) {
    const folder = await this.owner(folderId);
    if (!folder) {
      const method = parent ? this.options.legacy.openCachedFileDirectory : this.options.legacy.openCachedFile;
      if (!method) throw new Error("Opening cached documents is unavailable.");
      await method(folderId, path);
      return;
    }
    await this.options.show(this.documentId(folder, parent ? path.split("/").slice(0, -1).join("/") : path));
  }

  private adapterSharing(): Pick<SyncpeerPlatformAdapter,
    "exportPairingTransfer" | "importPairingTransfer" | "ownedDevices" | "revokeOwnedDevice" | "sessionSharedFolders"> {
    return {
      exportPairingTransfer: (localDeviceId, joiningDevice) => this.request({
        operation: "exportPairingTransfer", localDeviceId, joiningDevice,
      }),
      importPairingTransfer: async (transfer, identity, password, remember) => {
        await this.request({ operation: "importPairingTransfer", transfer, identity, password, remember });
      },
      ownedDevices: async () => (await this.request<{ devices: OwnedSpaceDevice[] }>({ operation: "ownedDevices" })).devices,
      revokeOwnedDevice: deviceId => this.request({ operation: "revokeOwnedDevice", deviceId }),
      sessionSharedFolders: async remoteDeviceId => {
        if (!this.options.enabled() || (await this.cacheStatus()).vault.phase !== "unlocked") return [];
        return this.request({ operation: "sessionSharedFolders", remoteDeviceId });
      },
    };
  }

  private adapterProfile(): Pick<SyncpeerPlatformAdapter,
    "loadProfileSettings" | "saveProfileSettings" | "loadDirectorySnapshot" | "saveDirectorySnapshot" |
    "enforceCacheQuota" | "listFavorites" | "upsertFavorite" | "removeFavorite" | "listLocalDirectory" |
    "acknowledgeCachedSync"> {
    return {
      loadProfileSettings: () => this.loadProfileSettings(),
      saveProfileSettings: settings => this.saveProfileSettings(settings),
      loadDirectorySnapshot: (folderId, sourceDeviceId, path) => this.request({
        operation: "loadDirectorySnapshot", folderId, sourceDeviceId, path,
      }),
      saveDirectorySnapshot: (folderId, sourceDeviceId, path, snapshot) => this.request({
        operation: "saveDirectorySnapshot", folderId, sourceDeviceId, path, snapshot,
      }),
      enforceCacheQuota: () => this.request({ operation: "enforceCacheQuota" }),
      listFavorites: () => this.options.enabled() ? this.listMigratedFavorites() : this.options.legacy.listFavorites?.() ?? Promise.resolve([]),
      upsertFavorite: favorite => this.options.enabled()
        ? this.updateFavorites(favorites => [...favorites.filter(item => item.key !== favorite.key), favorite])
        : this.options.legacy.upsertFavorite?.(favorite) ?? Promise.reject(new Error("Favorite storage is unavailable.")),
      removeFavorite: key => this.options.enabled()
        ? this.updateFavorites(favorites => favorites.filter(item => item.key !== key))
        : this.options.legacy.removeFavorite?.(key) ?? Promise.reject(new Error("Favorite storage is unavailable.")),
      listLocalDirectory: async (folderId, path) => {
        const folder = (await this.registrations()).find(value => value.id === folderId);
        if (!folder) return await this.options.legacy.listLocalDirectory?.(folderId, path) ?? null;
        if (path) assertReplicaPath(path);
        const entries = await this.request<Array<{ name: string; directory: boolean; size: number; modifiedMs: number }>>({
          operation: "list", id: this.documentId(folder, path),
        });
        return entries.map(entry => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name,
          type: entry.directory ? "directory" as const : "file" as const, size: entry.size, modifiedMs: entry.modifiedMs }));
      },
      acknowledgeCachedSync: async (folderId, path, baseline) => {
        const folder = await this.owner(folderId);
        if (!folder) return false;
        await this.request({ operation: "setSyncBaseline", id: this.documentId(folder, path), ...baseline });
        return true;
      },
    };
  }

  private adapterVersions(): Pick<SyncpeerPlatformAdapter,
    "listDocumentVersions" | "restoreDocumentVersion" | "listFavoriteSyncStates" |
    "retryFavoriteSync" | "resolveFavoriteConflict"> {
    return {
      listDocumentVersions: async (folderId, path) => {
        const folder = await this.owner(folderId);
        if (!folder) throw new Error("Encrypted version history is unavailable for this folder.");
        return this.request({ operation: "versions", id: this.documentId(folder, path) });
      },
      restoreDocumentVersion: async (folderId, path, versionId) => {
        const folder = await this.owner(folderId);
        if (!folder) throw new Error("Encrypted version history is unavailable for this folder.");
        await this.request({ operation: "restoreVersion", id: this.documentId(folder, path), versionId });
      },
      listFavoriteSyncStates: async folderIds => {
        const states = [];
        for (const folderId of folderIds) {
          if (!await this.owner(folderId)) continue;
          const state = await this.request<{ entries: Record<string, Omit<FavoriteSyncStateRecord, "path">> }>(
            { operation: "favoriteSyncState", folderId });
          states.push({ folderId,
            entries: Object.entries(state.entries).map(([path, entry]) => ({ path, ...entry })) });
        }
        return states;
      },
      retryFavoriteSync: async (folderId, path) => {
        if (!await this.owner(folderId)) throw new Error("Encrypted folder storage is not ready.");
        await this.request({ operation: "clearFavoriteSyncEntry", folderId, path });
      },
      resolveFavoriteConflict: async (folderId, path, resolution) => {
        if (!await this.owner(folderId)) throw new Error("Encrypted folder storage is not ready.");
        await this.request({ operation: "recordFavoriteResolution", folderId, path, resolution });
      },
    };
  }

  private cacheFile(
    folderId: string,
    path: string,
    name: string,
    bytes: Uint8Array,
    modifiedMs?: number,
  ) {
    return this.folderQueue.then(async () => {
      const release = await this.track(folderId);
      try {
        if (!await this.owner(folderId)) {
          if (this.options.enabled()) throw new Error("Encrypted folder storage is not ready. Unlock the folder before downloading.");
          if (!this.options.legacy.cacheFile) throw new Error("Cache is unavailable.");
          await this.options.legacy.cacheFile(folderId, path, name, bytes, modifiedMs);
          return;
        }
        const target = this.sink(folderId, path, modifiedMs);
        try {
          await target.begin({ folderId, path, sizeBytes: bytes.length, encrypted: false });
          await target.write(0, bytes);
          await target.commit();
          await this.request({ operation: "enforceCacheQuota" });
        } catch (error) {
          await target.abort(error);
          throw error;
        }
      } finally {
        release();
      }
    });
  }

  private async getCachedStatuses(folderId: string, paths: string[]) {
    if (!await this.owner(folderId)) return await this.options.legacy.getCachedStatuses?.(folderId, paths) ?? [];
    return this.request<CachedFileStatus[]>({ operation: "cachedStatuses", folderId, paths });
  }

  private async readBinaryFile(path: string) {
    if (!path.startsWith("syncpeer-document:")) {
      if (!this.options.legacy.readBinaryFile) throw new Error("File reads are unavailable.");
      return this.options.legacy.readBinaryFile(path);
    }
    const file = await this.source(path.slice("syncpeer-document:".length));
    try {
      const bytes = new Uint8Array(file.size);
      for (let offset = 0; offset < file.size; offset += 131072) {
        const chunk = await file.readRange(offset, Math.min(131072, file.size - offset));
        try {
          bytes.set(chunk, offset);
        } finally {
          chunk.fill(0);
        }
      }
      return bytes;
    } finally {
      await file.close();
    }
  }

  private async openCachedDirectory(folderId: string, path: string) {
    const folder = await this.owner(folderId);
    if (folder) await this.options.show(this.documentId(folder, path));
    else await this.options.legacy.openCachedDirectory?.(folderId, path);
  }

  private async removeCachedFile(folderId: string, path: string) {
    const folder = await this.owner(folderId);
    return folder ? this.request<boolean>({ operation: "remove", id: this.documentId(folder, path) })
      : await this.options.legacy.removeCachedFile?.(folderId, path) ?? false;
  }

  private async clearCache() {
    if ((await this.registrations()).some(folder => folder.downloads)) {
      throw new Error("Encrypted documents may contain local edits. Remove individual downloads instead; preserved migration backups are not cleared automatically.");
    }
    await this.options.legacy.clearCache?.();
  }

  private adapterTransfer(): Pick<SyncpeerPlatformAdapter,
    "createFileDownloadSink" | "listCachedFiles" | "digestCachedFiles" | "cacheFile" |
    "getCachedStatuses" | "readBinaryFile" | "openCachedFile" | "openCachedFileDirectory" |
    "openCachedDirectory" | "removeCachedFile" | "clearCache"> {
    return {
      createFileDownloadSink: async args => this.createFileDownloadSink(args),
      listCachedFiles: () => this.listCachedFiles(),
      digestCachedFiles: files => this.digestCachedFiles(files),
      cacheFile: (folderId, path, name, bytes, modifiedMs) =>
        this.cacheFile(folderId, path, name, bytes, modifiedMs),
      getCachedStatuses: (folderId, paths) => this.getCachedStatuses(folderId, paths),
      readBinaryFile: path => this.readBinaryFile(path),
      openCachedFile: (folderId, path) => this.show(folderId, path, false),
      openCachedFileDirectory: (folderId, path) => this.show(folderId, path, true),
      openCachedDirectory: (folderId, path) => this.openCachedDirectory(folderId, path),
      removeCachedFile: (folderId, path) => this.removeCachedFile(folderId, path),
      clearCache: () => this.clearCache(),
    };
  }

  private platformAdapter(): SyncpeerPlatformAdapter {
    return {
      ...this.options.legacy,
      ...this.adapterSharing(),
      ...this.adapterProfile(),
      ...this.adapterVersions(),
      ...this.adapterTransfer(),
    };
  }

  private async connectFolder(folder: { id: string; label: string; password?: string }) {
    if (!this.options.enabled()) throw new Error("Document storage is unavailable.");
    if (this.migrating.has(folder.id) || this.active.get(folder.id)) {
      throw new Error("Wait for this folder’s transfers to finish before moving it.");
    }
    const migration = this.migrateFolder(folder);
    this.migrating.set(folder.id, migration);
    try {
      await migration;
    } finally {
      if (this.migrating.get(folder.id) === migration) this.migrating.delete(folder.id);
    }
  }

  private async migrateFolder(folder: { id: string; label: string; password?: string }): Promise<void> {
    let registered = (await this.registrations()).find(value => value.id === folder.id);
    await this.request({ operation: "register", ...folder });
    if (registered?.downloads) return;
    registered = (await this.registrations()).find(value => value.id === folder.id)!;
    const files = await this.legacyFiles(folder.id);
    const existing = await this.request<CachedFileRecord[]>({ operation: "folderFiles", folderId: folder.id });
    for (const file of files) await this.migrateLegacyFile(folder.id, registered, file, existing);
    await this.request({ operation: "attachDownloads", id: folder.id });
  }

  private async migrateLegacyFile(
    folderId: string,
    registered: FolderRegistration,
    file: CachedFileRecord,
    existing: CachedFileRecord[],
  ): Promise<void> {
    assertReplicaPath(file.path);
    const original = await this.options.openLegacySource(file);
    const alreadyImported = existing.some(value => value.path === file.path);
    const target = this.sink(folderId, file.path, file.modifiedMs ?? file.cachedAtMs,
      alreadyImported ? undefined : null);
    try {
      if (original.size !== file.sizeBytes) throw new Error("Cached file changed. Refresh downloads before migration.");
      await target.begin({ folderId, path: file.path, sizeBytes: original.size, encrypted: false });
      const expected = await this.copyLegacyBytes(original, target);
      if (await target.digestFile!() !== expected) throw new Error("Document migration verification failed.");
      await original.verify();
      if (alreadyImported) await this.verifyExistingDocument(registered, file, original.size, expected, target);
      else await target.commit();
      await this.removeLegacyFile(file);
    } catch (error) {
      await target.abort(error);
      throw error;
    } finally {
      await original.close();
    }
  }

  private async copyLegacyBytes(
    original: Awaited<ReturnType<DocumentCacheOptions["openLegacySource"]>>,
    target: FileDownloadSink,
  ): Promise<string> {
    const hash = sha256.create();
    for (let offset = 0; offset < original.size; offset += 131072) {
      const data = await original.readRange(offset, Math.min(131072, original.size - offset));
      try {
        hash.update(data);
        await target.write(offset, data);
      } finally {
        data.fill(0);
      }
    }
    return [...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private async verifyExistingDocument(
    registered: FolderRegistration,
    file: CachedFileRecord,
    originalSize: number,
    expected: string,
    target: FileDownloadSink,
  ): Promise<void> {
    const current = await this.source(this.documentId(registered, file.path));
    try {
      if (current.size !== originalSize || await this.digestReader(current) !== expected) {
        throw new Error("A document already contains different data. Migration left both copies unchanged.");
      }
    } finally {
      await current.close();
    }
    await this.request({ operation: "setSyncBaseline", id: this.documentId(registered, file.path), hash: expected,
      sizeBytes: originalSize, modifiedMs: file.modifiedMs ?? file.cachedAtMs });
    await target.abort(new Error("Already imported"));
  }

  private async migrateToLegacy(folderId: string, cacheFile: NonNullable<SyncpeerPlatformAdapter["cacheFile"]>) {
    const encrypted = await this.request<CachedFileRecord[]>({ operation: "folderFiles", folderId });
    const staged: Array<{ file: CachedFileRecord; bytes: Uint8Array; hash: string }> = [];
    try {
      for (const file of encrypted) {
        if (!file.localPath?.startsWith("syncpeer-document:")) throw new Error("Encrypted document path is unavailable.");
        const bytes = await this.readSourceBytes(file.localPath.slice("syncpeer-document:".length));
        try {
          const hash = await this.digestReader({ size: bytes.length, readRange: async (offset, size) => bytes.slice(offset, offset + size) });
          await cacheFile(folderId, file.path, file.name, bytes, file.modifiedMs ?? file.cachedAtMs);
          staged.push({ file, bytes, hash });
        } finally {
          bytes.fill(0);
        }
      }
      for (const stagedFile of staged) {
        const copy = (await this.legacyFiles(folderId)).find(value => value.path === stagedFile.file.path);
        if (!copy) throw new Error("Plain local copy was not created; migration was not completed.");
        const original = await this.options.openLegacySource(copy);
        try {
          if (original.size !== stagedFile.file.sizeBytes || await this.digestReader(original) !== stagedFile.hash) {
            throw new Error("Plain local copy failed verification; encrypted data was retained.");
          }
        } finally {
          await original.close();
        }
      }
      await this.request({ operation: "detachDownloads", id: folderId });
    } finally {
      staged.forEach(value => value.bytes.fill(0));
    }
  }

  private async disconnectFolder(folderId: string) {
    if (!this.options.enabled()) throw new Error("Document storage is unavailable.");
    if (this.migrating.has(folderId) || this.active.get(folderId)) {
      throw new Error("Wait for this folder’s transfers to finish before moving it.");
    }
    const registered = (await this.registrations()).find(value => value.id === folderId && value.downloads);
    if (!registered) throw new Error("Encrypted folder storage is not attached.");
    const cacheFile = this.options.legacy.cacheFile;
    if (!cacheFile || !this.options.legacy.listCachedFiles || !this.options.legacy.removeCachedFile) {
      throw new Error("Plain local storage is unavailable; migration was not completed.");
    }
    const migration = Promise.resolve().then(() => this.migrateToLegacy(folderId, cacheFile));
    this.migrating.set(folderId, migration);
    try {
      await migration;
    } finally {
      if (this.migrating.get(folderId) === migration) this.migrating.delete(folderId);
    }
  }

  private async syncFolders(folders: FolderInfo[], passwords: Record<string, string>) {
    const task = this.folderQueue.then(async () => {
      if (!this.options.enabled()) return [];
      // Discovery must finish even if preparing one folder's contents later fails.
      for (const folder of folders) {
        await this.request({ operation: "rememberFolder", id: folder.id, label: folder.label || folder.id });
      }
      for (const folder of folders) {
        const signature = JSON.stringify([folder.label, folder.encrypted, folder.needsPassword, passwords[folder.id]]);
        if (this.observed.get(folder.id) === signature) continue;
        if ((await this.registrations()).some(value => value.id === folder.id && value.browseOnly)) {
          this.observed.set(folder.id, signature);
          continue;
        }
        if (!folder.needsPassword && (!folder.encrypted || passwords[folder.id])) {
          await this.connectFolder({ id: folder.id, label: folder.label || folder.id, password: passwords[folder.id] });
        }
        this.observed.set(folder.id, signature);
      }
      return this.registrations();
    });
    this.folderQueue = task.then(() => {}, () => {});
    return task;
  }

  api() {
    return {
      platformAdapter: this.platformAdapter(),
      connectFolder: (folder: { id: string; label: string; password?: string }) => this.connectFolder(folder),
      disconnectFolder: (folderId: string) => this.disconnectFolder(folderId),
      syncFolders: (folders: FolderInfo[], passwords: Record<string, string>) =>
        this.syncFolders(folders, passwords),
    };
  }
}

export function createDocumentCache(options: DocumentCacheOptions) {
  return new DocumentCache(options).api();
}
