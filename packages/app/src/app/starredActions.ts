import {
  createSha256DownloadSink,
  collectFavoriteFiles,
  DownloadInterruptedError,
  cachedFileKey,
  type CachedFileRecord,
  type FavoriteRecord,
  type FileDownloadSink,
  type FileEntry,
  normalizePath,
  type SyncpeerBrowserClient,
} from "@syncpeer/core/browser";
import { reportActionError } from "./actionErrors.ts";
import { remoteFavoriteNeedsDownload } from "./favoriteSyncPolicies.ts";
import {
  digestBytesHex,
  elapsedMsSince,
  splitPath,
} from "./actionSupport.ts";
import { updateCachedKey } from "./downloadPolicies.ts";
import { pushSessionLog, type AppState } from "./state.ts";
import type { TransferRuntime } from "./transferRuntime.ts";

type StarredActionArgs = {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly transfers: TransferRuntime;
};

export const createStarredActions = (args: StarredActionArgs) => ({
  syncStarredFiles: () => syncStarredFiles(args),
  loadFavoriteSyncStates: () => loadFavoriteSyncStates(args),
  retryFavorite: (favorite: Pick<FavoriteRecord, "folderId" | "path">) =>
    retryFavorite(args, favorite),
  resolveFavoriteConflict: (
    favorite: Pick<FavoriteRecord, "folderId" | "path">,
    resolution: "keep-local" | "keep-remote",
  ) => resolveFavoriteConflict(args, favorite, resolution),
});

type StarredSyncTarget = {
  folderId: string;
  path: string;
  name: string;
};

type StarredSyncBaseline = NonNullable<AppState["sync"]["starredFileSyncState"][string]>;

type StarredLocalState = {
  localBytes: Uint8Array | null;
  localHash: string;
  localChanged: boolean;
  nativeLocalHash: string | null | undefined;
};

class StarredSyncRun {
  private readonly state: AppState;
  private readonly client: SyncpeerBrowserClient;
  private readonly transfers: TransferRuntime;
  private remoteFs!: NonNullable<AppState["session"]["remoteFs"]>;
  private starredFiles: StarredSyncTarget[] = [];
  private nestedByKey = new Map<string, FileEntry>();
  private cachedByKey = new Map<string, CachedFileRecord>();
  private nativeDigestByKey = new Map<string, string | null>();
  private dirCache = new Map<string, FileEntry[]>();
  private readonly syncController = new AbortController();
  private uploaded = 0;
  private downloaded = 0;
  private startedAtMs = 0;

  constructor({ state, client, transfers }: StarredActionArgs) {
    this.state = state;
    this.client = client;
    this.transfers = transfers;
  }

  async run(): Promise<void> {
    if (this.state.sync.isSyncingStarredFiles) return;
    if (!this.state.ui.isAppVisible) return;
    if (!this.state.session.isConnected || !this.state.session.remoteFs) return;
    if (this.state.session.isConnecting || this.state.session.isRefreshing ||
      this.state.session.isLoadingDirectory) return;
    if (this.state.favorites.items.length === 0) return;

    this.state.sync.isSyncingStarredFiles = true;
    this.startedAtMs = Date.now();
    try {
      this.remoteFs = this.state.session.remoteFs;
      await this.prepare();
      for (const favorite of this.starredFiles) {
        if (this.syncController.signal.aborted) break;
        await this.syncOne(favorite);
      }
      this.logSummary();
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        reportActionError(this.state, "starred.sync.failed", error, {
          durationMs: elapsedMsSince(this.startedAtMs),
        });
      }
    } finally {
      this.state.sync.isSyncingStarredFiles = false;
    }
  }

  private async prepare(): Promise<void> {
    const folderIds = [...new Set(this.state.favorites.items.map(item => item.folderId))]
      .filter(folderId => !this.state.favorites.pausedFolderIds.has(folderId));
    const activeFolderIds = new Set(folderIds);
    const nestedFiles = (await Promise.all(folderIds.map(async folderId =>
      (await collectFavoriteFiles({
        folderId,
        favorites: this.state.favorites.items,
        exclusions: this.state.favorites.exclusions,
        patterns: this.state.favorites.ignorePatternsByFolder[folderId],
        readDir: path => this.remoteFs.readDir(folderId, path),
      })).map(file => ({ folderId, file }))))).flat();
    this.nestedByKey = new Map(nestedFiles.map(({ folderId, file }) =>
      [`${folderId}:${normalizePath(file.path)}`, file]));
    this.starredFiles = [...new Map([
      ...this.state.favorites.items.filter(item => item.kind === "file" && activeFolderIds.has(item.folderId)),
      ...nestedFiles.map(({ folderId, file }) => ({ key: `file:${file.path}`, folderId,
        path: file.path, name: file.name, kind: "file" as const })),
    ].map(item => [`${item.folderId}:${item.path}`, item])).values()];
    if (this.starredFiles.length === 0) return;
    await this.loadCache();
  }

  private async loadCache(): Promise<void> {
    const cachedFiles = await this.client.listCachedFiles();
    this.cachedByKey = new Map(cachedFiles.map((item) => [item.key, item]));
    const digestTargets = [...new Map(this.starredFiles.map((file) => {
      const key = cachedFileKey(file.folderId, normalizePath(file.path));
      return [key, { folderId: file.folderId, path: normalizePath(file.path) }];
    })).values()].filter((file) => this.cachedByKey.has(cachedFileKey(file.folderId, file.path)));
    if (!this.client.digestCachedFiles || digestTargets.length === 0) return;
    for (const digest of await this.client.digestCachedFiles(digestTargets)) {
      this.nativeDigestByKey.set(cachedFileKey(digest.folderId, digest.path), digest.hash ?? null);
    }
  }

  private async readCachedBytes(
    cached: CachedFileRecord,
    folderId: string,
    path: string,
  ): Promise<Uint8Array | null> {
    try {
      if (cached.localPath) return await this.client.readBinaryFile(cached.localPath);
      if (this.client.readCachedFile) return await this.client.readCachedFile(folderId, path);
    } catch {
      // A disappeared cache entry is handled as unavailable below.
    }
    return null;
  }

  private async download(
    folderId: string,
    path: string,
    name: string,
    size: number,
    modifiedMs: number,
    expectedLocalHash?: string,
  ): Promise<string> {
    const id = `starred-download:${cachedFileKey(folderId, path)}`;
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    let activeSink: FileDownloadSink | null = null;
    await this.transfers.begin({
      id,
      direction: "download",
      label: name,
      completedBytes: 0,
      totalBytes: size,
      cancellable: true,
    }, () => this.syncController.abort());
    try {
      const onProgress = (progress: { downloadedBytes: number; totalBytes: number }) =>
        this.transfers.update(id, progress.downloadedBytes, progress.totalBytes);
      let localHash: string;
      if (this.remoteFs.readFileToSink && this.client.createFileDownloadSink) {
        const nativeSink = await this.client.createFileDownloadSink({
          folderId,
          path,
          name,
          modifiedMs,
          expectedLocalHash,
        });
        const hashingSink = createSha256DownloadSink(nativeSink);
        activeSink = hashingSink.sink;
        const result = await this.remoteFs.readFileToSink(
          folderId,
          path,
          hashingSink.sink,
          onProgress,
          this.syncController.signal,
        );
        localHash = hashingSink.digestHex();
        pushSessionLog(this.state, "info", "favorites.download.complete", "Favorite download completed", {
          totalBytes: result.totalBytes,
          networkBytes: result.networkBytes,
          reusedBytes: result.reusedBytes,
          resumedBytes: result.resumedBytes,
        });
      } else {
        const bytes = await this.remoteFs.readFileFully(
          folderId,
          path,
          onProgress,
          this.syncController.signal,
        );
        await this.client.cacheFile(folderId, path, name, bytes, modifiedMs);
        localHash = await digestBytesHex(bytes);
      }
      outcome = "completed";
      return localHash;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") outcome = "cancelled";
      if (activeSink && !(error instanceof DownloadInterruptedError)) await activeSink.abort(error);
      throw error;
    } finally {
      await this.transfers.finish(id, outcome);
    }
  }

  private async upload(
    folderId: string,
    path: string,
    name: string,
    bytes: Uint8Array,
    modifiedMs: number,
  ): Promise<void> {
    const id = `starred-upload:${cachedFileKey(folderId, path)}`;
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    await this.transfers.begin({
      id,
      direction: "upload",
      label: name,
      completedBytes: 0,
      totalBytes: bytes.length,
      cancellable: true,
    }, () => this.syncController.abort());
    try {
      await this.remoteFs.writeFileFully(folderId, path, bytes, {
        modifiedMs,
        signal: this.syncController.signal,
        onProgress: (progress) => this.transfers.update(
          id,
          progress.processedBytes,
          progress.totalBytes,
        ),
      });
      // Picker edits can continue while uploading. Acknowledge the sent snapshot
      // without rewriting newer local bytes in the service-owned document.
      const acknowledged = await this.client.acknowledgeCachedSync?.(folderId, path, {
        hash: await digestBytesHex(bytes), sizeBytes: bytes.length, modifiedMs,
      });
      if (!acknowledged) await this.client.cacheFile(folderId, path, name, bytes, modifiedMs);
      outcome = "completed";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") outcome = "cancelled";
      throw error;
    } finally {
      await this.transfers.finish(id, outcome);
    }
  }

  private async syncOne(favorite: StarredSyncTarget): Promise<void> {
    const targetPath = normalizePath(favorite.path);
    if (!targetPath) return;
    const { parent, name } = splitPath(targetPath);
    if (!name) return;
    const remoteEntry = await this.remoteEntry(favorite.folderId, targetPath, parent);
    if (!remoteEntry) return;
    const key = cachedFileKey(favorite.folderId, targetPath);
    const cached = this.cachedByKey.get(key);
    if (!cached) {
      await this.downloadMissing(favorite, key, targetPath, remoteEntry);
      return;
    }
    await this.syncExisting(favorite, key, targetPath, cached, remoteEntry);
  }

  private async remoteEntry(
    folderId: string,
    targetPath: string,
    parent: string,
  ): Promise<FileEntry | undefined> {
    const dirKey = `${folderId}::${parent}`;
    if (!this.nestedByKey.has(`${folderId}:${targetPath}`) && !this.dirCache.has(dirKey)) {
      this.dirCache.set(dirKey, await this.remoteFs.readDir(folderId, parent));
    }
    return this.nestedByKey.get(`${folderId}:${targetPath}`) ?? this.dirCache
      .get(dirKey)
      ?.find((entry) => entry.type === "file" && normalizePath(entry.path) === targetPath);
  }

  private async downloadMissing(
    favorite: StarredSyncTarget,
    key: string,
    targetPath: string,
    remoteEntry: FileEntry,
  ): Promise<void> {
    const downloadedHash = await this.download(
      favorite.folderId,
      targetPath,
      favorite.name,
      remoteEntry.size,
      remoteEntry.modifiedMs || Date.now(),
    );
    this.state.sync.starredFileSyncState[key] = {
      lastLocalHash: downloadedHash,
      lastRemoteModifiedMs: remoteEntry.modifiedMs || Date.now(),
      lastRemoteSizeBytes: remoteEntry.size,
      lastSyncAtMs: Date.now(),
      lastDirection: "download",
    };
    updateCachedKey(this.state, favorite.folderId, targetPath, true);
    this.downloaded += 1;
  }

  private async syncExisting(
    favorite: StarredSyncTarget,
    key: string,
    targetPath: string,
    cached: CachedFileRecord,
    remoteEntry: FileEntry,
  ): Promise<void> {
    const remoteModifiedMs = remoteEntry.modifiedMs || 0;
    const previous = this.previousState(key, cached);
    if (cached.syncBaselineRequired && !previous) {
      throw new Error("This local document has no verified remote baseline. Upload or download it explicitly before enabling automatic updates.");
    }
    const local = await this.localState(cached, favorite.folderId, targetPath, key, previous);
    const remoteChanged = remoteFavoriteNeedsDownload(
      { sizeBytes: remoteEntry.size, modifiedMs: remoteModifiedMs },
      previous,
      cached,
    );
    if (remoteChanged) {
      await this.applyRemoteChange(favorite, key, targetPath, cached, remoteEntry, remoteModifiedMs, previous, local);
      return;
    }
    if (!previous) {
      this.recordBaseline(key, local.localHash, remoteModifiedMs, remoteEntry.size);
      return;
    }
    if (local.localChanged && local.localBytes) {
      await this.applyLocalChange(favorite, key, targetPath, remoteModifiedMs, remoteEntry.size, local);
      return;
    }
    this.recordUnchanged(key, local.localHash, remoteModifiedMs, remoteEntry.size, previous);
  }

  private previousState(key: string, cached: CachedFileRecord): StarredSyncBaseline | undefined {
    return this.state.sync.starredFileSyncState[key] ?? (cached.syncBaseline ? {
      lastLocalHash: cached.syncBaseline.hash,
      lastRemoteModifiedMs: cached.syncBaseline.modifiedMs,
      lastRemoteSizeBytes: cached.syncBaseline.sizeBytes,
      lastSyncAtMs: cached.cachedAtMs,
      lastDirection: "baseline" as const,
    } : undefined);
  }

  private async localState(
    cached: CachedFileRecord,
    folderId: string,
    targetPath: string,
    key: string,
    previous: StarredSyncBaseline | undefined,
  ): Promise<StarredLocalState> {
    const nativeLocalHash = this.nativeDigestByKey.get(key);
    let localBytes: Uint8Array | null = null;
    let localHash: string;
    if (nativeLocalHash) {
      localHash = nativeLocalHash;
      if (previous && localHash !== previous.lastLocalHash) {
        localBytes = await this.readCachedBytes(cached, folderId, targetPath);
        if (!localBytes) {
          throw new Error(`Changed cached file could not be read: ${targetPath}`);
        }
      }
    } else {
      localBytes = await this.readCachedBytes(cached, folderId, targetPath);
      localHash = localBytes ? await digestBytesHex(localBytes) : previous?.lastLocalHash ?? "";
    }
    return {
      localBytes,
      localHash,
      nativeLocalHash,
      localChanged: Boolean(localBytes && previous) && localHash !== previous!.lastLocalHash,
    };
  }

  private async applyRemoteChange(
    favorite: StarredSyncTarget,
    key: string,
    targetPath: string,
    cached: CachedFileRecord,
    remoteEntry: FileEntry,
    remoteModifiedMs: number,
    previous: StarredSyncBaseline | undefined,
    local: StarredLocalState,
  ): Promise<void> {
    const localUnchanged = Boolean(previous && local.localHash === previous.lastLocalHash &&
      (local.nativeLocalHash || local.localBytes));
    if (!localUnchanged) {
      throw new Error("The local document could not be verified unchanged against its remote baseline. Local edits were preserved; resolve the conflict before downloading a replacement.");
    }
    const downloadedHash = await this.download(
      favorite.folderId,
      targetPath,
      favorite.name,
      remoteEntry.size,
      remoteModifiedMs || Date.now(),
      cached.syncBaselineRequired ? previous?.lastLocalHash : undefined,
    );
    this.state.sync.starredFileSyncState[key] = {
      lastLocalHash: downloadedHash,
      lastRemoteModifiedMs: remoteModifiedMs || Date.now(),
      lastRemoteSizeBytes: remoteEntry.size,
      lastSyncAtMs: Date.now(),
      lastDirection: "download",
    };
    updateCachedKey(this.state, favorite.folderId, targetPath, true);
    this.downloaded += 1;
  }

  private async applyLocalChange(
    favorite: StarredSyncTarget,
    key: string,
    targetPath: string,
    remoteModifiedMs: number,
    remoteSize: number,
    local: StarredLocalState,
  ): Promise<void> {
    const uploadModifiedMs = Date.now();
    await this.upload(
      favorite.folderId,
      targetPath,
      favorite.name,
      local.localBytes!,
      uploadModifiedMs,
    );
    this.state.sync.starredFileSyncState[key] = {
      lastLocalHash: local.localHash,
      lastRemoteModifiedMs: uploadModifiedMs,
      lastRemoteSizeBytes: local.localBytes!.length,
      lastSyncAtMs: Date.now(),
      lastDirection: "upload",
    };
    this.uploaded += 1;
  }

  private recordBaseline(
    key: string,
    localHash: string,
    remoteModifiedMs: number,
    remoteSize: number,
  ): void {
    this.state.sync.starredFileSyncState[key] = {
      lastLocalHash: localHash,
      lastRemoteModifiedMs: remoteModifiedMs,
      lastRemoteSizeBytes: remoteSize,
      lastSyncAtMs: Date.now(),
      lastDirection: "baseline",
    };
  }

  private recordUnchanged(
    key: string,
    localHash: string,
    remoteModifiedMs: number,
    remoteSize: number,
    previous: StarredSyncBaseline,
  ): void {
    this.state.sync.starredFileSyncState[key] = {
      ...previous,
      lastLocalHash: localHash,
      lastRemoteModifiedMs: remoteModifiedMs,
      lastRemoteSizeBytes: remoteSize,
      lastSyncAtMs: previous.lastSyncAtMs,
    };
  }

  private logSummary(): void {
    if (this.uploaded === 0 && this.downloaded === 0) return;
    pushSessionLog(
      this.state,
      "info",
      "starred.sync.complete",
      `Starred sync finished: uploaded=${this.uploaded}, downloaded=${this.downloaded}.`,
      {
        uploaded: this.uploaded,
        downloaded: this.downloaded,
        durationMs: elapsedMsSince(this.startedAtMs),
        fileCount: this.starredFiles.length,
      },
    );
  }
}

const syncStarredFiles = async (args: StarredActionArgs) => new StarredSyncRun(args).run();

const loadFavoriteSyncStates = async ({ state, client }: StarredActionArgs) => {
  if (!client.listFavoriteSyncStates) return;
  const folderIds = [...new Set(state.favorites.items.map(item => item.folderId))];
  if (folderIds.length === 0) {
    state.sync.favoriteSyncStates = {};
    return;
  }
  state.sync.isLoadingFavoriteSyncStates = true;
  try {
    const states = await client.listFavoriteSyncStates(folderIds);
    state.sync.favoriteSyncStates = Object.fromEntries(states.flatMap(snapshot =>
      snapshot.entries.map(entry => [`${snapshot.folderId}:${entry.path}`, entry])));
  } catch (error) {
    reportActionError(state, "favorite.sync_state.failed", error);
  } finally {
    state.sync.isLoadingFavoriteSyncStates = false;
  }
};

const retryFavorite = async (
  args: StarredActionArgs,
  favorite: Pick<FavoriteRecord, "folderId" | "path">,
) => {
  const { state, client } = args;
  if (!client.retryFavoriteSync) return;
  state.sync.isRetryingFavorite = true;
  try {
    await client.retryFavoriteSync(favorite.folderId, normalizePath(favorite.path));
    delete state.sync.favoriteSyncStates[`${favorite.folderId}:${normalizePath(favorite.path)}`];
    await syncStarredFiles(args);
    await loadFavoriteSyncStates(args);
  } catch (error) {
    reportActionError(state, "favorite.retry.failed", error, { key: `${favorite.folderId}:${favorite.path}` });
  } finally {
    state.sync.isRetryingFavorite = false;
  }
};

const resolveFavoriteConflict = async (
  args: StarredActionArgs,
  favorite: Pick<FavoriteRecord, "folderId" | "path">,
  resolution: "keep-local" | "keep-remote",
) => {
  const { state, client } = args;
  if (!client.resolveFavoriteConflict) return;
  state.sync.isResolvingFavorite = true;
  try {
    await client.resolveFavoriteConflict(favorite.folderId, normalizePath(favorite.path), resolution);
    await syncStarredFiles(args);
    await loadFavoriteSyncStates(args);
  } catch (error) {
    reportActionError(state, "favorite.conflict.failed", error, { key: `${favorite.folderId}:${favorite.path}` });
  } finally {
    state.sync.isResolvingFavorite = false;
  }
};
