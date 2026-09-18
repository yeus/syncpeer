import {
  createSha256DownloadSink,
  collectFavoriteFiles,
  DownloadInterruptedError,
  cachedFileKey,
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

export const createStarredActions = (args: {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly transfers: TransferRuntime;
}) => {
  const { state, client, transfers } = args;
  const {
    begin: beginManagedTransfer,
    update: updateManagedTransfer,
    finish: finishManagedTransfer,
  } = transfers;

const syncStarredFiles = async () => {
  if (state.sync.isSyncingStarredFiles) return;
  if (!state.ui.isAppVisible) return;
  if (!state.session.isConnected || !state.session.remoteFs) return;
  if (
    state.session.isConnecting ||
    state.session.isRefreshing ||
    state.session.isLoadingDirectory
  ) {
    return;
  }
  if (state.favorites.items.length === 0) return;

  state.sync.isSyncingStarredFiles = true;
  const startedAtMs = Date.now();
  let uploaded = 0;
  let downloaded = 0;

  try {
    const remoteFs = state.session.remoteFs;
    const folderIds = [...new Set(state.favorites.items.map(item => item.folderId))]
      .filter(folderId => !state.favorites.pausedFolderIds.has(folderId));
    const activeFolderIds = new Set(folderIds);
    const nestedFiles = (await Promise.all(folderIds.map(async folderId =>
      (await collectFavoriteFiles({
        folderId,
        favorites: state.favorites.items,
        exclusions: state.favorites.exclusions,
        patterns: state.favorites.ignorePatternsByFolder[folderId],
        readDir: path => remoteFs.readDir(folderId, path),
      })).map(file => ({ folderId, file }))))).flat();
    const nestedByKey = new Map(nestedFiles.map(({ folderId, file }) =>
      [`${folderId}:${normalizePath(file.path)}`, file]));
    const starredFiles = [...new Map([
      ...state.favorites.items.filter(item => item.kind === "file" && activeFolderIds.has(item.folderId)),
      ...nestedFiles.map(({ folderId, file }) => ({ key: `file:${file.path}`, folderId,
        path: file.path, name: file.name, kind: "file" as const })),
    ].map(item => [`${item.folderId}:${item.path}`, item])).values()];
    if (starredFiles.length === 0) return;
    const cachedFiles = await client.listCachedFiles();
    const cachedByKey = new Map(cachedFiles.map((item) => [item.key, item]));
    const digestTargets = [...new Map(starredFiles.map((file) => {
      const key = cachedFileKey(file.folderId, normalizePath(file.path));
      return [key, { folderId: file.folderId, path: normalizePath(file.path) }];
    })).values()].filter((file) => cachedByKey.has(cachedFileKey(file.folderId, file.path)));
    const nativeDigestByKey = new Map<string, string | null>();
    if (client.digestCachedFiles && digestTargets.length > 0) {
      for (const digest of await client.digestCachedFiles(digestTargets)) {
        nativeDigestByKey.set(cachedFileKey(digest.folderId, digest.path), digest.hash ?? null);
      }
    }
    const dirCache = new Map<string, FileEntry[]>();
    const syncController = new AbortController();
    const readCachedBytes = async (cached: typeof cachedFiles[number], folderId: string, path: string) => {
      try {
        if (cached.localPath) return await client.readBinaryFile(cached.localPath);
        if (client.readCachedFile) return await client.readCachedFile(folderId, path);
      } catch {
        // A disappeared cache entry is handled as unavailable below.
      }
      return null;
    };

    const downloadStarredFile = async (
      folderId: string,
      path: string,
      name: string,
      size: number,
      modifiedMs: number,
      expectedLocalHash?: string,
    ): Promise<string> => {
      const id = `starred-download:${cachedFileKey(folderId, path)}`;
      let outcome: "completed" | "failed" | "cancelled" = "failed";
      let activeSink: FileDownloadSink | null = null;
      await beginManagedTransfer({
        id,
        direction: "download",
        label: name,
        completedBytes: 0,
        totalBytes: size,
        cancellable: true,
      }, () => syncController.abort());
      try {
        const onProgress = (progress: { downloadedBytes: number; totalBytes: number }) =>
          updateManagedTransfer(id, progress.downloadedBytes, progress.totalBytes);
        let localHash: string;
        if (remoteFs.readFileToSink && client.createFileDownloadSink) {
          const nativeSink = await client.createFileDownloadSink({
            folderId,
            path,
            name,
            modifiedMs,
            expectedLocalHash,
          });
          const hashingSink = createSha256DownloadSink(nativeSink);
          activeSink = hashingSink.sink;
          const result = await remoteFs.readFileToSink(
            folderId,
            path,
            hashingSink.sink,
            onProgress,
            syncController.signal,
          );
          localHash = hashingSink.digestHex();
          pushSessionLog(state, "info", "favorites.download.complete", "Favorite download completed", {
            totalBytes: result.totalBytes,
            networkBytes: result.networkBytes,
            reusedBytes: result.reusedBytes,
            resumedBytes: result.resumedBytes,
          });
        } else {
          const bytes = await remoteFs.readFileFully(
            folderId,
            path,
            onProgress,
            syncController.signal,
          );
          await client.cacheFile(folderId, path, name, bytes, modifiedMs);
          localHash = await digestBytesHex(bytes);
        }
        outcome = "completed";
        return localHash;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") outcome = "cancelled";
        if (activeSink && !(error instanceof DownloadInterruptedError)) await activeSink.abort(error);
        throw error;
      } finally {
        await finishManagedTransfer(id, outcome);
      }
    };

    const uploadStarredFile = async (
      folderId: string,
      path: string,
      name: string,
      bytes: Uint8Array,
      modifiedMs: number,
    ) => {
      const id = `starred-upload:${cachedFileKey(folderId, path)}`;
      let outcome: "completed" | "failed" | "cancelled" = "failed";
      await beginManagedTransfer({
        id,
        direction: "upload",
        label: name,
        completedBytes: 0,
        totalBytes: bytes.length,
        cancellable: true,
      }, () => syncController.abort());
      try {
        await remoteFs.writeFileFully(folderId, path, bytes, {
          modifiedMs,
          signal: syncController.signal,
          onProgress: (progress) => updateManagedTransfer(
            id,
            progress.processedBytes,
            progress.totalBytes,
          ),
        });
        // Picker edits can continue while uploading. Acknowledge the sent snapshot
        // without rewriting newer local bytes in the service-owned document.
        const acknowledged = await client.acknowledgeCachedSync?.(folderId, path, {
          hash: await digestBytesHex(bytes), sizeBytes: bytes.length, modifiedMs,
        });
        if (!acknowledged) await client.cacheFile(folderId, path, name, bytes, modifiedMs);
        outcome = "completed";
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") outcome = "cancelled";
        throw error;
      } finally {
        await finishManagedTransfer(id, outcome);
      }
    };

    for (const favorite of starredFiles) {
      if (syncController.signal.aborted) break;
      const targetPath = normalizePath(favorite.path);
      if (!targetPath) continue;
      const { parent, name } = splitPath(targetPath);
      if (!name) continue;
      const dirKey = `${favorite.folderId}::${parent}`;
      if (!nestedByKey.has(`${favorite.folderId}:${targetPath}`) && !dirCache.has(dirKey)) {
        dirCache.set(dirKey, await remoteFs.readDir(favorite.folderId, parent));
      }
      const remoteEntry = nestedByKey.get(`${favorite.folderId}:${targetPath}`) ?? dirCache
        .get(dirKey)
        ?.find((entry) => entry.type === "file" && normalizePath(entry.path) === targetPath);
      if (!remoteEntry) continue;

      const key = cachedFileKey(favorite.folderId, targetPath);
      const cached = cachedByKey.get(key);

      if (!cached) {
        const localHash = await downloadStarredFile(
          favorite.folderId,
          targetPath,
          favorite.name,
          remoteEntry.size,
          remoteEntry.modifiedMs || Date.now(),
        );
        state.sync.starredFileSyncState[key] = {
          lastLocalHash: localHash,
          lastRemoteModifiedMs: remoteEntry.modifiedMs || Date.now(),
          lastRemoteSizeBytes: remoteEntry.size,
          lastSyncAtMs: Date.now(),
          lastDirection: "download",
        };
        updateCachedKey(state, favorite.folderId, targetPath, true);
        downloaded += 1;
        continue;
      }

      const remoteModifiedMs = remoteEntry.modifiedMs || 0;
      const previous = state.sync.starredFileSyncState[key] ?? (cached.syncBaseline ? {
        lastLocalHash: cached.syncBaseline.hash,
        lastRemoteModifiedMs: cached.syncBaseline.modifiedMs,
        lastRemoteSizeBytes: cached.syncBaseline.sizeBytes,
        lastSyncAtMs: cached.cachedAtMs,
        lastDirection: "baseline" as const,
      } : undefined);
      if (cached.syncBaselineRequired && !previous) {
        throw new Error("This local document has no verified remote baseline. Upload or download it explicitly before enabling automatic updates.");
      }
      const nativeLocalHash = nativeDigestByKey.get(key);
      let localBytes: Uint8Array | null = null;
      let localHash: string;
      if (nativeLocalHash !== undefined) {
        localHash = nativeLocalHash ?? previous?.lastLocalHash ?? "";
        if (previous && localHash !== previous.lastLocalHash) {
          localBytes = await readCachedBytes(cached, favorite.folderId, targetPath);
          if (!localBytes) {
            throw new Error(`Changed cached file could not be read: ${targetPath}`);
          }
        }
      } else {
        localBytes = await readCachedBytes(cached, favorite.folderId, targetPath);
        localHash = localBytes ? await digestBytesHex(localBytes) : previous?.lastLocalHash ?? "";
      }
      const localChanged = Boolean(localBytes && previous) && localHash !== previous!.lastLocalHash;
      const remoteChanged = remoteFavoriteNeedsDownload(
        { sizeBytes: remoteEntry.size, modifiedMs: remoteModifiedMs },
        previous,
        cached,
      );
      if (remoteChanged) {
        if (cached.syncBaseline && (!localBytes || localChanged)) {
          throw new Error("Both the document and remote file may have changed. Local edits were preserved; resolve the conflict before downloading a replacement.");
        }
        const localHash = await downloadStarredFile(
          favorite.folderId,
          targetPath,
          favorite.name,
          remoteEntry.size,
          remoteModifiedMs || Date.now(),
          cached.syncBaselineRequired ? previous?.lastLocalHash : undefined,
        );
        state.sync.starredFileSyncState[key] = {
          lastLocalHash: localHash,
          lastRemoteModifiedMs: remoteModifiedMs || Date.now(),
          lastRemoteSizeBytes: remoteEntry.size,
          lastSyncAtMs: Date.now(),
          lastDirection: "download",
        };
        updateCachedKey(state, favorite.folderId, targetPath, true);
        downloaded += 1;
        continue;
      }

      if (!previous) {
        const baselineHash = localBytes ? await digestBytesHex(localBytes) : "";
        state.sync.starredFileSyncState[key] = {
          lastLocalHash: baselineHash,
          lastRemoteModifiedMs: remoteModifiedMs,
          lastRemoteSizeBytes: remoteEntry.size,
          lastSyncAtMs: Date.now(),
          lastDirection: "baseline",
        };
        continue;
      }

      if (localChanged && localBytes) {
        const uploadModifiedMs = Date.now();
        await uploadStarredFile(
          favorite.folderId,
          targetPath,
          favorite.name,
          localBytes,
          uploadModifiedMs,
        );
        state.sync.starredFileSyncState[key] = {
          lastLocalHash: localHash,
          lastRemoteModifiedMs: uploadModifiedMs,
          lastRemoteSizeBytes: localBytes.length,
          lastSyncAtMs: Date.now(),
          lastDirection: "upload",
        };
        uploaded += 1;
        continue;
      }

      state.sync.starredFileSyncState[key] = {
        ...previous,
        lastLocalHash: localHash,
        lastRemoteModifiedMs: remoteModifiedMs,
        lastRemoteSizeBytes: remoteEntry.size,
        lastSyncAtMs: previous.lastSyncAtMs,
      };
    }

    if (uploaded > 0 || downloaded > 0) {
      pushSessionLog(
        state,
        "info",
        "starred.sync.complete",
        `Starred sync finished: uploaded=${uploaded}, downloaded=${downloaded}.`,
        {
          uploaded,
          downloaded,
          durationMs: elapsedMsSince(startedAtMs),
          fileCount: starredFiles.length,
        },
      );
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      reportActionError(state, "starred.sync.failed", error, {
        durationMs: elapsedMsSince(startedAtMs),
      });
    }
  } finally {
    state.sync.isSyncingStarredFiles = false;
  }
};


const loadFavoriteSyncStates = async () => {
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

const retryFavorite = async (favorite: Pick<FavoriteRecord, "folderId" | "path">) => {
  if (!client.retryFavoriteSync) return;
  state.sync.isRetryingFavorite = true;
  try {
    await client.retryFavoriteSync(favorite.folderId, normalizePath(favorite.path));
    delete state.sync.favoriteSyncStates[`${favorite.folderId}:${normalizePath(favorite.path)}`];
    await syncStarredFiles();
    await loadFavoriteSyncStates();
  } catch (error) {
    reportActionError(state, "favorite.retry.failed", error, { key: `${favorite.folderId}:${favorite.path}` });
  } finally {
    state.sync.isRetryingFavorite = false;
  }
};

const resolveFavoriteConflict = async (
  favorite: Pick<FavoriteRecord, "folderId" | "path">,
  resolution: "keep-local" | "keep-remote",
) => {
  if (!client.resolveFavoriteConflict) return;
  state.sync.isResolvingFavorite = true;
  try {
    await client.resolveFavoriteConflict(favorite.folderId, normalizePath(favorite.path), resolution);
    await syncStarredFiles();
    await loadFavoriteSyncStates();
  } catch (error) {
    reportActionError(state, "favorite.conflict.failed", error, { key: `${favorite.folderId}:${favorite.path}` });
  } finally {
    state.sync.isResolvingFavorite = false;
  }
};

  return { syncStarredFiles, loadFavoriteSyncStates, retryFavorite, resolveFavoriteConflict };
};
