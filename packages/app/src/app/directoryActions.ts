import {
  favoriteKey,
  classifyFavoritePath,
  defaultFolderSettings,
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
  activeSourceDeviceId,
  connectionDetails,
  directoryTotalPages,
  folderIsLocked,
  pushSessionLog,
  type AppState,
} from "./state.ts";
import {
  clearDirectoryView,
  loadDirectorySideEffects,
  restoreAfterTransportFailure,
  sortByName,
} from "./actionSupport.ts";
import { refreshCachedStatuses, refreshFolderRootCachedStatuses } from "./cacheStatusActions.ts";
import { applyOfflineDirectory, restoreOfflineDirectory } from "./syncPolicies.ts";
import { updateCachedKey } from "./downloadPolicies.ts";

type DirectoryActionArgs = {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly refreshActiveView: () => Promise<void>;
  readonly syncStarredFiles: () => Promise<void>;
};

class DirectoryActionsRuntime {
  constructor(
    private readonly state: AppState,
    private readonly client: SyncpeerBrowserClient,
    private readonly sessionStore: SyncpeerSessionStore,
    private readonly refreshActiveView: () => Promise<void>,
    private readonly syncStarredFiles: () => Promise<void>,
  ) {}

  private openLocation = async (
    folderId: string,
    path: string,
    errorEvent: string,
    details: unknown,
    missingOfflineMessage = "This folder has not been browsed on this device yet.",
  ): Promise<boolean> => {
    const normalizedPath = normalizePath(path);
    this.state.ui.uploadMessage = "";
    try {
      if (await this.tryLocalLocation(folderId, normalizedPath)) return true;
      if (folderIsLocked(this.state, folderId)) return false;
      if (!this.state.session.isConnected || !this.state.session.remoteFs) {
        return this.openOfflineLocation(folderId, normalizedPath, missingOfflineMessage);
      }
      await this.openRemoteLocation(folderId, normalizedPath);
      return true;
    } catch (error) {
      reportActionError(this.state, errorEvent, error, details);
      restoreAfterTransportFailure(this.state, error);
      return false;
    }
  };

  private tryLocalLocation = async (folderId: string, normalizedPath: string): Promise<boolean> => {
      const canUseLocal = !this.state.session.isConnected || folderIsLocked(this.state, folderId) ||
        !this.state.session.folders.some(folder => folder.id === folderId);
      if (!canUseLocal) return false;
      const local = await this.client.listLocalDirectory?.(folderId, normalizedPath);
      if (!local) return false;
      this.state.session.isLocalDirectory = true;
      this.state.session.directory = { ...this.state.session.directory, folderId, path: normalizedPath,
        entries: local, status: "ready", error: null, loadedAtMs: Date.now() };
      this.state.session.currentFolderId = folderId;
      this.state.session.currentPath = normalizedPath;
      this.state.session.entries = local;
      this.state.session.directoryPage = 1;
      await refreshCachedStatuses(this.state, this.client, folderId, local.map(entry => entry.path));
      return true;
    };

    private openOfflineLocation = async (
      folderId: string,
      normalizedPath: string,
      missingOfflineMessage: string,
    ): Promise<boolean> => {
      const encrypted = await this.client.loadDirectorySnapshot(
        folderId,
        activeSourceDeviceId(this.state),
        normalizedPath,
      );
      if (encrypted) applyOfflineDirectory(this.state, folderId, normalizedPath, encrypted);
      else if (!restoreOfflineDirectory(this.state, folderId, normalizedPath)) {
        this.state.ui.recentError = missingOfflineMessage;
        return false;
      }
      return true;
    };

    private openRemoteLocation = async (folderId: string, normalizedPath: string): Promise<void> => {
      this.state.session.isLocalDirectory = false;
      await this.sessionStore.actions.goToPath(folderId, normalizedPath, connectionDetails(this.state));
      applySessionState(this.state, this.sessionStore.getState());
      try {
        await loadDirectorySideEffects(this.state, this.client);
      } catch (error) {
        // The directory opened; caching its listing is best-effort and must not turn
        // a successful navigation into a failure banner.
        pushSessionLog(this.state, "warning", "folder.side_effects.failed",
          "Directory opened, but its offline listing could not be saved.",
          { message: error instanceof Error ? error.message : String(error) });
      }
    };

    private openFolderRoot = async (folderId: string) => {
      this.state.activeTab = "folders";
      await this.openLocation(folderId, "", "folder.open_root.failed", { folderId });
    };

    private openDirectory = async (path: string) => {
      if (!this.state.session.currentFolderId) return;
      const nextPath = resolveDirectoryPath(this.state.session.currentPath, path);
      await this.openLocation(
        this.state.session.currentFolderId,
        nextPath,
        "folder.open_path.failed",
        { path: nextPath },
        "This directory has not been browsed on this device yet.",
      );
    };

    private goToBreadcrumb = async (segment: BreadcrumbSegment) => {
      if (segment.ellipsis) return;
      await this.openLocation(
        segment.targetFolderId,
        segment.targetPath,
        "folder.go_to_breadcrumb.failed",
        segment,
        "This directory has not been browsed on this device yet.",
      );
    };

    private goToRootView = async () => {
      this.state.ui.uploadMessage = "";
      this.state.session.isLocalDirectory = false;
      if (!this.state.session.isConnected || !this.state.session.remoteFs) {
        clearDirectoryView(this.state);
        return;
      }
      await this.sessionStore.actions.goToRoot();
      applySessionState(this.state, this.sessionStore.getState());
      this.state.session.directoryPage = 1;
      await this.refreshActiveView();
    };

    private setDirectoryPage = (page: number) => {
    const maxPage = directoryTotalPages(this.state);
    const nextPage = Math.min(maxPage, Math.max(1, Math.floor(page)));
    this.state.session.directoryPage = nextPage;
  };

  private setDirectoryPageSize = (pageSize: number) => {
    if (!Number.isFinite(pageSize)) return;
    const normalized = Math.min(2000, Math.max(10, Math.floor(pageSize)));
    this.state.ui.directoryPageSize = normalized;
    this.state.session.directoryPage = 1;
  };

  private setDirectorySortMode = (sortMode: FileEntrySortMode) => {
    this.state.ui.directorySortMode = sortMode;
    this.state.session.directoryPage = 1;
  };

  private setDirectoryNameFilter = (nameFilter: string) => {
    this.state.ui.directoryNameFilter = nameFilter;
    this.state.session.directoryPage = 1;
  };

  private toggleFavorite = async (
    folderId: string,
    path: string,
    name: string,
    kind: "folder" | "file",
  ) => {
    const key = favoriteKey(folderId, path, kind);
    const exists = this.state.favorites.items.some((item) => item.key === key);
    const selection = classifyFavoritePath({ folderId, path, kind }, this.state.favorites.items,
      this.state.favorites.exclusions, this.state.favorites.ignorePatternsByFolder[folderId]);
    const previous = this.state.favorites.items;
    const previousExclusions = this.state.favorites.exclusions;
    if (!exists && selection.status === "favorite") {
      await this.excludeFavorite(folderId, path, kind, key, previousExclusions);
      return;
    }
    this.state.favorites.items = exists
      ? previous.filter((item) => item.key !== key)
      : sortByName([
          ...previous,
          { key, folderId, path: normalizePath(path), name, kind },
        ]);
    try {
      if (exists) {
        await this.client.removeFavorite(key);
      } else {
        await this.addFavorite(folderId, path, name, kind, key, previousExclusions);
      }
    } catch (error) {
      this.state.favorites.items = previous;
      this.state.favorites.exclusions = previousExclusions;
      reportActionError(this.state, exists ? "favorite.remove.failed" : "favorite.upsert.failed", error, { key });
    }
  };

  private excludeFavorite = async (
    folderId: string,
    path: string,
    kind: "folder" | "file",
    key: string,
    previousExclusions: typeof this.state.favorites.exclusions,
  ): Promise<void> => {
    const exclusion = { folderId, path: normalizePath(path), kind };
    this.state.favorites.exclusions = [...previousExclusions.filter(item =>
      item.folderId !== folderId || item.path !== exclusion.path || item.kind !== kind), exclusion];
    try {
      const settings = await this.client.loadProfileSettings();
      const folder = settings.folders[folderId] ?? defaultFolderSettings();
      settings.folders[folderId] = { ...folder, exclusions: this.state.favorites.exclusions
        .filter(item => item.folderId === folderId) };
      await this.client.saveProfileSettings(settings);
    } catch (error) {
      this.state.favorites.exclusions = previousExclusions;
      reportActionError(this.state, "favorite.exclude.failed", error, { key });
    }
  };

  private addFavorite = async (
    folderId: string,
    path: string,
    name: string,
    kind: "folder" | "file",
    key: string,
    previousExclusions: typeof this.state.favorites.exclusions,
  ): Promise<void> => {
    this.state.favorites.exclusions = previousExclusions.filter(item =>
      item.folderId !== folderId || item.path !== normalizePath(path) || item.kind !== kind);
    await this.client.upsertFavorite({
      key,
      folderId,
      path: normalizePath(path),
      name,
      kind,
    });
    if (kind === "file") await refreshCachedStatuses(this.state, this.client, folderId, [path]);
    await this.syncStarredFiles();
  };

  private removeFavorite = async (favorite: AppState["favorites"]["items"][number]) => {
    const previous = this.state.favorites.items;
    this.state.favorites.items = previous.filter((item) => item.key !== favorite.key);
    try {
      await this.client.removeFavorite(favorite.key);
    } catch (error) {
      this.state.favorites.items = previous;
      reportActionError(this.state, "favorite.remove.failed", error, { key: favorite.key });
    }
  };

  private openFavorite = async (favorite: Pick<FavoriteRecord, "folderId" | "path" | "kind">) => {
    if (!this.state.session.isConnected) return;
    this.state.activeTab = "folders";
    await this.openLocation(
      favorite.folderId,
      favorite.kind === "folder"
        ? favorite.path
        : normalizePath(favorite.path.split("/").slice(0, -1).join("/")),
      "favorite.open.failed",
      favorite,
    );
  };

  private openDownloadedFilesPanel = async () => {
    if (this.state.favorites.isLoadingDownloadedFiles) return;
    this.state.favorites.isLoadingDownloadedFiles = true;
    try {
      this.state.favorites.downloadedFiles = await this.client.listCachedFiles();
      this.state.favorites.showDownloadedFiles = true;
    } catch (error) {
      reportActionError(this.state, "list_cached_files.failed", error);
    } finally {
      this.state.favorites.isLoadingDownloadedFiles = false;
    }
  };

  private clearAllCache = async () => {
    if (this.state.favorites.isClearingCache || this.state.favorites.isRemovingCachedFile) return;
    this.state.favorites.isClearingCache = true;
    try {
      await this.client.clearCache();
      this.state.favorites.cachedFileKeys = new Set();
      this.state.favorites.downloadedFiles = [];
    } catch (error) {
      reportActionError(this.state, "clear_cache.failed", error);
    } finally {
      this.state.favorites.isClearingCache = false;
    }
  };

  private removeCachedFile = async (folderId: string, path: string) => {
    if (this.state.favorites.isRemovingCachedFile || this.state.favorites.isClearingCache) return;
    this.state.favorites.isRemovingCachedFile = true;
    try {
      await this.client.removeCachedFile(folderId, path);
      updateCachedKey(this.state, folderId, path, false);
      await refreshFolderRootCachedStatuses(this.state, this.client, [folderId]);
      this.state.favorites.downloadedFiles = this.state.favorites.downloadedFiles.filter(
        (file) => file.key !== cachedFileKey(folderId, path),
      );
    } catch (error) {
      reportActionError(this.state, "remove_cached_file.failed", error, { folderId, path });
    } finally {
      this.state.favorites.isRemovingCachedFile = false;
    }
  };

  private openCachedTarget = async (
  event: string,
  runner: () => Promise<void>,
  details?: unknown,
) => {
  if (this.state.favorites.isOpeningCachedFile) return;
  this.state.favorites.isOpeningCachedFile = true;
  try {
    await runner();
  } catch (error) {
    reportActionError(this.state, event, error, details);
  } finally {
    this.state.favorites.isOpeningCachedFile = false;
  }
};

  private openCachedFile = (folderId: string, path: string) =>
  this.openCachedTarget("open_cached_file.failed", () => this.client.openCachedFile(folderId, path), {
    folderId,
    path,
  });

  private openCachedFileDirectory = (folderId: string, path: string) =>
  this.openCachedTarget(
    "open_cached_file_directory.failed",
    () => this.client.openCachedFileDirectory(folderId, path),
    { folderId, path },
  );

  private openCachedDirectory = (folderId: string, path: string) =>
  this.openCachedTarget(
    "open_cached_directory.failed",
    () => this.client.openCachedDirectory(folderId, path),
    { folderId, path },
  );

  api() {
    return {
      openLocation: this.openLocation,
      openFolderRoot: this.openFolderRoot,
      openDirectory: this.openDirectory,
      goToBreadcrumb: this.goToBreadcrumb,
      goToRootView: this.goToRootView,
      setDirectoryPage: this.setDirectoryPage,
      setDirectoryPageSize: this.setDirectoryPageSize,
      setDirectorySortMode: this.setDirectorySortMode,
      setDirectoryNameFilter: this.setDirectoryNameFilter,
      toggleFavorite: this.toggleFavorite,
      removeFavorite: this.removeFavorite,
      openFavorite: this.openFavorite,
      openDownloadedFilesPanel: this.openDownloadedFilesPanel,
      clearAllCache: this.clearAllCache,
      removeCachedFile: this.removeCachedFile,
      openCachedFile: this.openCachedFile,
      openCachedFileDirectory: this.openCachedFileDirectory,
      openCachedDirectory: this.openCachedDirectory,
    };
  }
}

export const createDirectoryActions = (args: DirectoryActionArgs) =>
  new DirectoryActionsRuntime(
    args.state,
    args.client,
    args.sessionStore,
    args.refreshActiveView,
    args.syncStarredFiles,
  ).api();
