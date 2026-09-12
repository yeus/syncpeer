import {
  favoriteKey,
  cachedFileKey,
  normalizePath,
  resolveDirectoryPath,
  type BreadcrumbSegment,
  type FavoriteRecord,
  type FileEntrySortMode,
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import { reportActionError } from "./actionErrors.ts";
import {
  applySessionState,
  connectionDetails,
  directoryTotalPages,
  folderIsLocked,
  type AppState,
} from "./state.ts";
import {
  clearDirectoryView,
  loadDirectorySideEffects,
  restoreAfterTransportFailure,
  sortByName,
} from "./actionSupport.ts";
import { refreshCachedStatuses, refreshFolderRootCachedStatuses } from "./cacheStatusActions.ts";
import { restoreOfflineDirectory } from "./syncPolicies.ts";
import { updateCachedKey } from "./downloadPolicies.ts";

export const createDirectoryActions = (args: {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly refreshActiveView: () => Promise<void>;
  readonly syncStarredFiles: () => Promise<void>;
}) => {
  const { state, client, sessionStore, refreshActiveView, syncStarredFiles } = args;

  const openLocation = async (
    folderId: string,
    path: string,
    errorEvent: string,
    details: unknown,
    missingOfflineMessage = "This folder has not been browsed on this device yet.",
  ): Promise<boolean> => {
    if (folderIsLocked(state, folderId)) return false;
    const normalizedPath = normalizePath(path);
    state.ui.uploadMessage = "";
    if (!state.session.isConnected || !state.session.remoteFs) {
      if (!restoreOfflineDirectory(state, folderId, normalizedPath)) {
        state.ui.recentError = missingOfflineMessage;
        return false;
      }
      return true;
    }
    try {
      await sessionStore.actions.goToPath(
        folderId,
        normalizedPath,
        connectionDetails(state),
      );
      applySessionState(state, sessionStore.getState());
      await loadDirectorySideEffects(state, client);
      return true;
    } catch (error) {
      reportActionError(state, errorEvent, error, details);
      restoreAfterTransportFailure(state, error);
      return false;
    }
  };

  const openFolderRoot = async (folderId: string) => {
    if (folderIsLocked(state, folderId)) return;
    state.activeTab = "folders";
    await openLocation(folderId, "", "folder.open_root.failed", { folderId });
  };

  const openDirectory = async (path: string) => {
    if (!state.session.currentFolderId) return;
    const nextPath = resolveDirectoryPath(state.session.currentPath, path);
    await openLocation(
      state.session.currentFolderId,
      nextPath,
      "folder.open_path.failed",
      { path: nextPath },
      "This directory has not been browsed on this device yet.",
    );
  };

  const goToBreadcrumb = async (segment: BreadcrumbSegment) => {
    if (segment.ellipsis) return;
    await openLocation(
      segment.targetFolderId,
      segment.targetPath,
      "folder.go_to_breadcrumb.failed",
      segment,
      "This directory has not been browsed on this device yet.",
    );
  };

  const goToRootView = async () => {
    state.ui.uploadMessage = "";
    if (!state.session.isConnected || !state.session.remoteFs) {
      clearDirectoryView(state);
      return;
    }
    await sessionStore.actions.goToRoot();
    applySessionState(state, sessionStore.getState());
    state.session.directoryPage = 1;
    await refreshActiveView();
  };

  const setDirectoryPage = (page: number) => {
  const maxPage = directoryTotalPages(state);
  const nextPage = Math.min(maxPage, Math.max(1, Math.floor(page)));
  state.session.directoryPage = nextPage;
};

  const setDirectoryPageSize = (pageSize: number) => {
  if (!Number.isFinite(pageSize)) return;
  const normalized = Math.min(2000, Math.max(10, Math.floor(pageSize)));
  state.ui.directoryPageSize = normalized;
  state.session.directoryPage = 1;
};

  const setDirectorySortMode = (sortMode: FileEntrySortMode) => {
  state.ui.directorySortMode = sortMode;
  state.session.directoryPage = 1;
};

  const setDirectoryNameFilter = (nameFilter: string) => {
  state.ui.directoryNameFilter = nameFilter;
  state.session.directoryPage = 1;
};

const toggleFavorite = async (
  folderId: string,
  path: string,
  name: string,
  kind: "folder" | "file",
) => {
  const key = favoriteKey(folderId, path, kind);
  const exists = state.favorites.items.some((item) => item.key === key);
  const previous = state.favorites.items;
  state.favorites.items = exists
    ? previous.filter((item) => item.key !== key)
    : sortByName([
        ...previous,
        { key, folderId, path: normalizePath(path), name, kind },
      ]);
  try {
    if (exists) {
      await client.removeFavorite(key);
    } else {
      await client.upsertFavorite({
        key,
        folderId,
        path: normalizePath(path),
        name,
        kind,
      });
      if (kind === "file") {
        await refreshCachedStatuses(state, client, folderId, [path]);
        await syncStarredFiles();
      }
    }
  } catch (error) {
    state.favorites.items = previous;
    reportActionError(state, exists ? "favorite.remove.failed" : "favorite.upsert.failed", error, { key });
  }
};

const removeFavorite = async (favorite: AppState["favorites"]["items"][number]) => {
  const previous = state.favorites.items;
  state.favorites.items = previous.filter((item) => item.key !== favorite.key);
  try {
    await client.removeFavorite(favorite.key);
  } catch (error) {
    state.favorites.items = previous;
    reportActionError(state, "favorite.remove.failed", error, { key: favorite.key });
  }
};

const openFavorite = async (favorite: Pick<FavoriteRecord, "folderId" | "path" | "kind">) => {
  if (!state.session.isConnected) return;
  state.activeTab = "folders";
  await openLocation(
    favorite.folderId,
    favorite.kind === "folder"
      ? favorite.path
      : normalizePath(favorite.path.split("/").slice(0, -1).join("/")),
    "favorite.open.failed",
    favorite,
  );
};

const openDownloadedFilesPanel = async () => {
  if (state.favorites.isLoadingDownloadedFiles) return;
  state.favorites.isLoadingDownloadedFiles = true;
  try {
    state.favorites.downloadedFiles = await client.listCachedFiles();
    state.favorites.showDownloadedFiles = true;
  } catch (error) {
    reportActionError(state, "list_cached_files.failed", error);
  } finally {
    state.favorites.isLoadingDownloadedFiles = false;
  }
};

const clearAllCache = async () => {
  if (state.favorites.isClearingCache || state.favorites.isRemovingCachedFile) return;
  state.favorites.isClearingCache = true;
  try {
    await client.clearCache();
    state.favorites.cachedFileKeys = new Set();
    state.favorites.downloadedFiles = [];
  } catch (error) {
    reportActionError(state, "clear_cache.failed", error);
  } finally {
    state.favorites.isClearingCache = false;
  }
};

const removeCachedFile = async (folderId: string, path: string) => {
  if (state.favorites.isRemovingCachedFile || state.favorites.isClearingCache) return;
  state.favorites.isRemovingCachedFile = true;
  try {
    await client.removeCachedFile(folderId, path);
    updateCachedKey(state, folderId, path, false);
    await refreshFolderRootCachedStatuses(state, client, [folderId]);
    state.favorites.downloadedFiles = state.favorites.downloadedFiles.filter(
      (file) => file.key !== cachedFileKey(folderId, path),
    );
  } catch (error) {
    reportActionError(state, "remove_cached_file.failed", error, { folderId, path });
  } finally {
    state.favorites.isRemovingCachedFile = false;
  }
};

const openCachedTarget = async (
  event: string,
  runner: () => Promise<void>,
  details?: unknown,
) => {
  if (state.favorites.isOpeningCachedFile) return;
  state.favorites.isOpeningCachedFile = true;
  try {
    await runner();
  } catch (error) {
    reportActionError(state, event, error, details);
  } finally {
    state.favorites.isOpeningCachedFile = false;
  }
};

const openCachedFile = (folderId: string, path: string) =>
  openCachedTarget("open_cached_file.failed", () => client.openCachedFile(folderId, path), {
    folderId,
    path,
  });

const openCachedFileDirectory = (folderId: string, path: string) =>
  openCachedTarget(
    "open_cached_file_directory.failed",
    () => client.openCachedFileDirectory(folderId, path),
    { folderId, path },
  );

const openCachedDirectory = (folderId: string, path: string) =>
  openCachedTarget(
    "open_cached_directory.failed",
    () => client.openCachedDirectory(folderId, path),
    { folderId, path },
  );


  return {
    openLocation,
    openFolderRoot,
    openDirectory,
    goToBreadcrumb,
    goToRootView,
    setDirectoryPage,
    setDirectoryPageSize,
    setDirectorySortMode,
    setDirectoryNameFilter,
    toggleFavorite,
    removeFavorite,
    openFavorite,
    openDownloadedFilesPanel,
    clearAllCache,
    removeCachedFile,
    openCachedFile,
    openCachedFileDirectory,
    openCachedDirectory,
  };
};
