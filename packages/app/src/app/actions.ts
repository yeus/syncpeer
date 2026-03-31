import {
  cachedFileKey,
  favoriteKey,
  folderPasswordScopedKey,
  getDefaultDiscoveryServer,
  isValidSyncthingDeviceId,
  normalizeDeviceId,
  normalizeDiscoveryServer,
  normalizePath,
  resolveDirectoryPath,
  sameDeviceId,
  type BreadcrumbSegment,
} from "@syncpeer/core/browser";
import {
  FOLDER_PASSWORD_SCOPE_SEPARATOR,
  type CachedFileRecord,
  type FolderInfo,
  type RemoteDeviceInfo,
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import { reportUiError } from "../lib/tauriAdapters.js";
import { runFolderContentDiagnostics } from "../lib/folderDiagnostics.ts";
import {
  buildDiagnosticsRegistry,
  runDiagnosticsTests,
  type TaskyonTestFn,
} from "../../../shared/modules/diagnosticsRunner.ts";
import {
  activeFolderPasswordScopeDeviceId,
  activeFolderPasswords,
  activeSourceDeviceId,
  advertisedDevices,
  advertisedFolders,
  applySessionState,
  cacheFileKeyExists,
  connectionDetails,
  currentSourceDeviceId,
  downloadProgressText,
  favoriteEntryKey,
  folderIsLocked,
  folderState,
  folderVersionKeyFromState,
  formatBytes,
  formatModified,
  hasSuccessfulConnectionHistory,
  isIntroducerDevice,
  isSavedDeviceConnected,
  directoryTotalPages,
  persistState,
  pushSessionLog,
  rootFolderEntries,
  setError,
  shouldHintRemoteApprovalPending,
  type AppState,
  type OfflineFolderSnapshot,
} from "./state.ts";
import {
  suggestedClientName,
  temporarySavedDeviceName,
} from "./suggestedNames.ts";

const nowTime = () => new Date().toLocaleTimeString();

const updateCachedKey = (
  state: AppState,
  folderId: string,
  path: string,
  available: boolean,
) => {
  const next = new Set(state.favorites.cachedFileKeys);
  const key = cachedFileKey(folderId, path);
  if (available) next.add(key);
  else next.delete(key);
  state.favorites.cachedFileKeys = next;
};

const saveOfflineSnapshot = (
  state: AppState,
  sourceDeviceId: string,
  snapshot: {
    folders: FolderInfo[];
    remoteDevice: RemoteDeviceInfo | null;
    folderSyncStates: import("@syncpeer/core/browser").FolderSyncState[];
    connectedVia: string;
    transportKind: "direct-tcp" | "relay" | "";
  },
) => {
  const deviceId = normalizeDeviceId(sourceDeviceId);
  if (!deviceId) return;
  if (snapshot.folders.length === 0 && snapshot.folderSyncStates.length === 0) return;
  state.offline.snapshots = {
    ...state.offline.snapshots,
    [deviceId]: {
      deviceId,
      remoteDevice: snapshot.remoteDevice,
      folders: snapshot.folders,
      folderSyncStates: snapshot.folderSyncStates,
      connectedVia: snapshot.connectedVia,
      transportKind: snapshot.transportKind,
      lastSeenAtMs: Date.now(),
    },
  };
};

const clearDirectoryView = (state: AppState) => {
  state.session.currentFolderId = "";
  state.session.currentPath = "";
  state.session.entries = [];
  state.session.currentFolderVersionKey = "";
  state.session.directoryPage = 1;
};

const restoreOfflineSnapshot = (
  state: AppState,
  preferredDeviceId?: string,
  reason = "restore",
) => {
  const preferred = normalizeDeviceId(preferredDeviceId ?? activeSourceDeviceId(state));
  const snapshots = Object.values(state.offline.snapshots).sort(
    (left, right) => right.lastSeenAtMs - left.lastSeenAtMs,
  );
  const snapshot =
    (preferred ? state.offline.snapshots[preferred] : null) ?? snapshots[0];
  if (!snapshot) return false;
  state.session.folders = snapshot.folders;
  state.session.folderSyncStates = snapshot.folderSyncStates;
  state.session.remoteDevice = snapshot.remoteDevice;
  state.session.connectionPath = snapshot.connectedVia;
  state.session.connectionTransport = snapshot.transportKind;
  if (
    state.session.currentFolderId &&
    !snapshot.folders.some((folder) => folder.id === state.session.currentFolderId)
  ) {
    clearDirectoryView(state);
  }
  pushSessionLog(
    state,
    "info",
    "offline.snapshot.restored",
    `Restored offline snapshot (${reason}) for ${snapshot.deviceId}.`,
    { deviceId: snapshot.deviceId, folderCount: snapshot.folders.length },
  );
  return true;
};

const resetRuntimeState = (state: AppState) => {
  state.session.isConnected = false;
  state.session.remoteFs = null;
  state.session.entries = [];
  state.session.activeConnectDeviceId = "";
  state.session.connectedSourceDeviceId = "";
  state.session.hasNonEmptyOverviewInSession = false;
};

const setRemoteApprovalPending = (
  state: AppState,
  deviceId: string,
  pending: boolean,
) => {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) return;
  const next = new Set(state.approvals.remoteApprovalPendingIds);
  if (pending) next.add(normalized);
  else next.delete(normalized);
  state.approvals.remoteApprovalPendingIds = next;
};

const sortByName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((left, right) => left.name.localeCompare(right.name));

const suggestedSavedDeviceName = (state: AppState, deviceId: string) => {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) return "";
  const advertised = advertisedDevices(state).find((item) => sameDeviceId(item.id, normalized));
  if (advertised?.name.trim()) return advertised.name.trim();
  const existing = state.devices.savedDevices.find((item) => sameDeviceId(item.id, normalized));
  if (existing?.name.trim()) return existing.name.trim();
  return temporarySavedDeviceName(normalized);
};

const upsertSavedDevice = (
  state: AppState,
  deviceId: string,
  name?: string,
  options?: { customName?: boolean; isIntroducer?: boolean },
) => {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) return false;
  const existing = state.devices.savedDevices.find((item) => item.id === normalized);
  const nextEntry = {
    id: normalized,
    name: (name ?? "").trim() || temporarySavedDeviceName(normalized),
    createdAtMs: existing?.createdAtMs ?? Date.now(),
    isIntroducer: options?.isIntroducer ?? existing?.isIntroducer ?? false,
    customName: options?.customName ?? existing?.customName ?? false,
  };
  state.devices.savedDevices = sortByName(
    existing
      ? state.devices.savedDevices.map((item) =>
          item.id === normalized ? nextEntry : item,
        )
      : [...state.devices.savedDevices, nextEntry],
  );
  return true;
};

const syncConnectedDeviceSavedName = (
  state: AppState,
  deviceId: string,
  advertisedName?: string,
) => {
  const normalized = normalizeDeviceId(deviceId);
  const nextName = (advertisedName ?? "").trim();
  if (!normalized || !nextName) return;
  const existing = state.devices.savedDevices.find((item) =>
    sameDeviceId(item.id, normalized),
  );
  if (!existing || existing.customName || existing.name.trim() === nextName) return;
  upsertSavedDevice(state, normalized, nextName, { customName: false });
};

const applyAutoApprovals = (state: AppState) => {
  const sourceDeviceId = currentSourceDeviceId(state);
  const sourceIsIntroducer = isIntroducerDevice(state, sourceDeviceId);
  if (state.connection.autoAcceptNewDevices) {
    for (const device of advertisedDevices(state)) {
      if (device.accepted || !isValidSyncthingDeviceId(device.id)) continue;
      upsertSavedDevice(state, device.id, device.name);
    }
  }
  if (state.connection.autoAcceptIntroducedFolders && sourceIsIntroducer) {
    const next = new Set(state.approvals.syncApprovedFolderKeys);
    for (const folder of advertisedFolders(state)) {
      next.add(folder.key);
    }
    state.approvals.syncApprovedFolderKeys = next;
  }
};

const refreshCachedStatuses = async (
  state: AppState,
  client: SyncpeerBrowserClient,
  folderId: string,
  paths: string[],
) => {
  if (!folderId || paths.length === 0) return;
  const statuses = await client.getCachedStatuses(
    folderId,
    paths.map((item) => normalizePath(item)),
  );
  const next = new Set(state.favorites.cachedFileKeys);
  for (const status of statuses) {
    const key = cachedFileKey(folderId, status.path);
    if (status.available) next.add(key);
    else next.delete(key);
  }
  state.favorites.cachedFileKeys = next;
};

const refreshFolderRootCachedStatuses = async (
  state: AppState,
  client: SyncpeerBrowserClient,
  folderIds: string[],
) => {
  const uniqueIds = [...new Set(folderIds.map((item) => item.trim()).filter(Boolean))];
  const responses = await Promise.all(
    uniqueIds.map(async (folderId) => ({
      folderId,
      statuses: await client.getCachedStatuses(folderId, [""]),
    })),
  );
  const next = new Set(state.favorites.cachedFileKeys);
  for (const response of responses) {
    const available = response.statuses[0]?.available ?? false;
    const key = cachedFileKey(response.folderId, "");
    if (available) next.add(key);
    else next.delete(key);
  }
  state.favorites.cachedFileKeys = next;
};

const reportActionError = (
  state: AppState,
  event: string,
  error: unknown,
  details?: unknown,
) => {
  setError(state, event, error, details);
  reportUiError(event, error, details);
};

const copyText = async (text: string) => {
  if (!text.trim()) throw new Error("Nothing to copy.");
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API unavailable on this device");
  }
  await navigator.clipboard.writeText(text);
};

const ensureClientName = (state: AppState) => {
  const currentName = state.connection.deviceName.trim();
  if (currentName && currentName !== "syncpeer-ui") {
    state.connection.deviceName = currentName;
    return true;
  }
  const chosen =
    typeof window !== "undefined"
      ? window.prompt(
          "Name this Syncpeer client (shown to remote devices):",
          suggestedClientName(),
        )
      : suggestedClientName();
  if (chosen === null) {
    state.ui.recentError = "Connection cancelled. Client name is required.";
    return false;
  }
  const normalized = chosen.trim();
  if (!normalized) {
    state.ui.recentError = "Client name is required.";
    return false;
  }
  state.connection.deviceName = normalized;
  return true;
};

const remoteHasUnapprovedFolderShare = (
  folders: Array<{ localDevicePresentInFolder?: boolean }>,
) => folders.some((folder) => folder.localDevicePresentInFolder === false);

const validateConnection = (state: AppState) => {
  if (
    state.connection.discoveryMode === "global" &&
    !normalizeDeviceId(state.connection.remoteId) &&
    state.devices.selectedSavedDeviceId
  ) {
    state.connection.remoteId = state.devices.selectedSavedDeviceId;
  }
  if (
    state.connection.discoveryMode === "global" &&
    !normalizeDeviceId(state.connection.remoteId)
  ) {
    throw new Error(
      "Global discovery requires a Remote Device ID. Add/select a saved device first.",
    );
  }
  if (
    state.connection.discoveryMode === "global" &&
    !isValidSyncthingDeviceId(state.connection.remoteId)
  ) {
    throw new Error(
      "Remote Device ID looks invalid. Expected 52 or 56 base32 chars (A-Z, 2-7), usually shown as grouped with dashes.",
    );
  }
  if (state.connection.discoveryMode === "global") {
    state.connection.discoveryServer = normalizeDiscoveryServer(
      state.connection.discoveryServer,
    );
  }
  state.connection.remoteId = normalizeDeviceId(state.connection.remoteId);
};

const loadDirectorySideEffects = async (
  state: AppState,
  client: SyncpeerBrowserClient,
) => {
  if (!state.session.currentFolderId) return;
  await refreshCachedStatuses(
    state,
    client,
    state.session.currentFolderId,
    state.session.entries.map((entry) => entry.path),
  );
  state.session.currentFolderVersionKey = folderVersionKeyFromState(
    state,
    state.session.currentFolderId,
  );
  state.session.lastUpdatedAt = nowTime();
};

export const createAppActions = (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
  sessionStore: SyncpeerSessionStore;
}) => {
  const { state, client, sessionStore } = args;

  const connect = async (targetDeviceId?: string) => {
    state.ui.recentError = null;
    state.ui.uploadMessage = "";
    if (!ensureClientName(state)) {
      state.session.activeConnectDeviceId = "";
      return;
    }
    if (targetDeviceId) {
      state.devices.selectedSavedDeviceId = targetDeviceId;
      state.connection.remoteId = targetDeviceId;
      state.connection.discoveryMode = "global";
      state.connection.host = "";
      state.session.activeConnectDeviceId = targetDeviceId;
    }
    validateConnection(state);
    const attemptedDeviceId = normalizeDeviceId(
      targetDeviceId || state.connection.remoteId || state.devices.selectedSavedDeviceId,
    );
    restoreOfflineSnapshot(state, attemptedDeviceId, "connect_start");
    try {
      await sessionStore.actions.setFolderPasswords(activeFolderPasswords(state));
      await sessionStore.actions.connect(connectionDetails(state));
      const session = sessionStore.getState();
      applySessionState(state, session);
      await refreshFolderRootCachedStatuses(
        state,
        client,
        session.folders.map((folder) => folder.id),
      );
      const sourceDeviceId = normalizeDeviceId(
        session.remoteDevice?.id ?? state.connection.remoteId,
      );
      syncConnectedDeviceSavedName(
        state,
        sourceDeviceId,
        session.remoteDevice?.deviceName,
      );
      setRemoteApprovalPending(state, attemptedDeviceId, false);
      setRemoteApprovalPending(state, sourceDeviceId, false);
      if (remoteHasUnapprovedFolderShare(session.folders)) {
        setRemoteApprovalPending(state, sourceDeviceId, true);
      }
      if (
        state.approvals.pendingApprovalPromptDeviceId &&
        (sameDeviceId(state.approvals.pendingApprovalPromptDeviceId, attemptedDeviceId) ||
          sameDeviceId(state.approvals.pendingApprovalPromptDeviceId, sourceDeviceId))
      ) {
        state.approvals.pendingApprovalPromptDeviceId = "";
      }
      saveOfflineSnapshot(state, sourceDeviceId, {
        folders: session.folders,
        remoteDevice: session.remoteDevice,
        folderSyncStates: session.folderSyncStates,
        connectedVia: session.connectionPath,
        transportKind: session.connectionTransport,
      });
      applyAutoApprovals(state);
      state.session.lastUpdatedAt = nowTime();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.ui.recentError = message;
      if (
        attemptedDeviceId &&
        !hasSuccessfulConnectionHistory(state, attemptedDeviceId) &&
        shouldHintRemoteApprovalPending(message)
      ) {
        setRemoteApprovalPending(state, attemptedDeviceId, true);
        state.approvals.pendingApprovalPromptDeviceId = attemptedDeviceId;
      }
      reportUiError("connect.failed", error, connectionDetails(state));
      resetRuntimeState(state);
      restoreOfflineSnapshot(state, attemptedDeviceId, "connect_failed");
    } finally {
      state.session.activeConnectDeviceId = "";
    }
  };

  const refreshOverview = async () => {
    if (
      !state.session.isConnected ||
      !state.session.remoteFs ||
      state.session.isConnecting ||
      state.session.isRefreshing ||
      state.session.isLoadingDirectory
    ) {
      return;
    }
    try {
      await sessionStore.actions.refreshOverview(connectionDetails(state));
      const session = sessionStore.getState();
      applySessionState(state, session);
      await refreshFolderRootCachedStatuses(
        state,
        client,
        session.folders.map((folder) => folder.id),
      );
      const sourceDeviceId = normalizeDeviceId(
        session.remoteDevice?.id ?? state.connection.remoteId,
      );
      syncConnectedDeviceSavedName(
        state,
        sourceDeviceId,
        session.remoteDevice?.deviceName,
      );
      if (remoteHasUnapprovedFolderShare(session.folders)) {
        setRemoteApprovalPending(state, sourceDeviceId, true);
      } else {
        setRemoteApprovalPending(state, sourceDeviceId, false);
      }
      saveOfflineSnapshot(state, sourceDeviceId, {
        folders: session.folders,
        remoteDevice: session.remoteDevice,
        folderSyncStates: session.folderSyncStates,
        connectedVia: session.connectionPath,
        transportKind: session.connectionTransport,
      });
      applyAutoApprovals(state);
      if (state.activeTab === "folders" && state.session.currentFolderId) {
        if (folderIsLocked(state, state.session.currentFolderId)) {
          state.session.entries = [];
          state.session.currentFolderVersionKey = "";
        } else {
          const nextVersionKey = folderVersionKeyFromState(
            state,
            state.session.currentFolderId,
          );
          if (
            state.session.entries.length === 0 ||
            !state.session.currentFolderVersionKey ||
            state.session.currentFolderVersionKey !== nextVersionKey
          ) {
            await sessionStore.actions.reloadCurrentDirectory(connectionDetails(state));
            applySessionState(state, sessionStore.getState());
            await loadDirectorySideEffects(state, client);
          }
        }
      }
      state.session.lastUpdatedAt = nowTime();
    } catch (error) {
      reportActionError(state, "refresh_overview.failed", error, connectionDetails(state));
    }
  };

  const refreshActiveView = async () => {
    await refreshOverview();
  };

  const hydrate = async () => {
    try {
      state.favorites.items = await client.listFavorites();
      const fileFavorites = new Map<string, string[]>();
      for (const favorite of state.favorites.items) {
        if (favorite.kind !== "file") continue;
        if (!fileFavorites.has(favorite.folderId)) {
          fileFavorites.set(favorite.folderId, []);
        }
        fileFavorites.get(favorite.folderId)?.push(favorite.path);
      }
      for (const [folderId, paths] of fileFavorites) {
        await refreshCachedStatuses(state, client, folderId, paths);
      }
    } catch (error) {
      reportActionError(state, "hydrate_state.failed", error);
    }
  };

  const disconnect = async () => {
    if (state.session.isConnecting) return;
    try {
      await sessionStore.actions.disconnect();
    } catch (error) {
      reportActionError(state, "disconnect.failed", error);
    } finally {
      resetRuntimeState(state);
      clearDirectoryView(state);
      restoreOfflineSnapshot(state, undefined, "disconnect");
      state.ui.recentError = null;
    }
  };

  const refreshCurrentDeviceId = async () => {
    if (state.devices.isLoadingCurrentDeviceId) return;
    state.devices.isLoadingCurrentDeviceId = true;
    try {
      state.devices.currentDeviceId = await client.getDefaultDeviceId();
    } catch (error) {
      reportActionError(state, "device_id.read.failed", error);
    } finally {
      state.devices.isLoadingCurrentDeviceId = false;
    }
  };

  const copyCurrentDeviceId = async () => {
    try {
      if (!state.devices.currentDeviceId) {
        await refreshCurrentDeviceId();
      }
      await copyText(state.devices.currentDeviceId);
      state.devices.identityNotice = "Device ID copied.";
    } catch (error) {
      reportActionError(state, "device_id.copy.failed", error);
    }
  };

  const copySessionLogs = async () => {
    const text = state.logs.items
      .slice()
      .reverse()
      .map((item) => {
        const base = `${new Date(item.timestampMs).toISOString()} [${item.level.toUpperCase()}] ${item.event}: ${item.message}`;
        return item.details === undefined
          ? base
          : `${base}\n${JSON.stringify(item.details, null, 2)}`;
      })
      .join("\n\n");
    try {
      await copyText(text || "No session logs yet.");
    } catch (error) {
      reportActionError(state, "logs.copy.failed", error);
    }
  };

  const openFolderRoot = async (folderId: string) => {
    if (folderIsLocked(state, folderId)) return;
    state.ui.uploadMessage = "";
    state.activeTab = "folders";
    try {
      await sessionStore.actions.openFolder(folderId, connectionDetails(state));
      applySessionState(state, sessionStore.getState());
      await loadDirectorySideEffects(state, client);
    } catch (error) {
      reportActionError(state, "folder.open_root.failed", error, { folderId });
    }
  };

  const openDirectory = async (path: string) => {
    if (!state.session.currentFolderId) return;
    state.ui.uploadMessage = "";
    const nextPath = resolveDirectoryPath(state.session.currentPath, path);
    try {
      await sessionStore.actions.openPath(nextPath, connectionDetails(state));
      applySessionState(state, sessionStore.getState());
      await loadDirectorySideEffects(state, client);
    } catch (error) {
      reportActionError(state, "folder.open_path.failed", error, { path: nextPath });
    }
  };

  const goToBreadcrumb = async (segment: BreadcrumbSegment) => {
    if (segment.ellipsis) return;
    state.ui.uploadMessage = "";
    try {
      await sessionStore.actions.goToPath(
        segment.targetFolderId,
        segment.targetPath,
        connectionDetails(state),
      );
      applySessionState(state, sessionStore.getState());
      await loadDirectorySideEffects(state, client);
    } catch (error) {
      reportActionError(state, "folder.go_to_breadcrumb.failed", error, segment);
    }
  };

  const goToRootView = async () => {
    state.ui.uploadMessage = "";
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

  const openFavorite = async (favorite: AppState["favorites"]["items"][number]) => {
    if (!state.session.isConnected) return;
    state.activeTab = "folders";
    state.ui.uploadMessage = "";
    try {
      await sessionStore.actions.goToPath(
        favorite.folderId,
        favorite.kind === "folder"
          ? favorite.path
          : normalizePath(favorite.path.split("/").slice(0, -1).join("/")),
        connectionDetails(state),
      );
      applySessionState(state, sessionStore.getState());
      await loadDirectorySideEffects(state, client);
    } catch (error) {
      reportActionError(state, "favorite.open.failed", error, favorite);
    }
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

  const downloadFile = async (folderId: string, path: string, name: string) => {
    if (!state.session.remoteFs || !state.session.isConnected || state.favorites.isDownloading) {
      return;
    }
    state.favorites.isDownloading = true;
    const startedAt = Date.now();
    const downloadKey = cachedFileKey(folderId, path);
    state.favorites.activeDownloadKey = downloadKey;
    state.favorites.activeDownloadText = "0% • 0 B/s • ETA --";
    try {
      const bytes = await state.session.remoteFs.readFileFully(
        folderId,
        path,
        ({
          downloadedBytes,
          totalBytes,
        }: {
          downloadedBytes: number;
          totalBytes: number;
        }) => {
          state.favorites.activeDownloadText = downloadProgressText(
            downloadedBytes,
            totalBytes,
            (Date.now() - startedAt) / 1000,
          );
        },
      );
      await client.cacheFile(folderId, path, name, bytes);
      updateCachedKey(state, folderId, path, true);
      await refreshFolderRootCachedStatuses(state, client, [folderId]);
      state.favorites.activeDownloadText = "100% • Done";
    } catch (error) {
      reportActionError(state, "download_file.failed", error, { folderId, path });
    } finally {
      state.favorites.isDownloading = false;
      if (state.favorites.activeDownloadKey === downloadKey) {
        state.favorites.activeDownloadKey = "";
        state.favorites.activeDownloadText = "";
      }
    }
  };

  const updateFolderPasswordDraft = (folderId: string, password: string) => {
    state.passwords.drafts = {
      ...state.passwords.drafts,
      [folderId]: password,
    };
  };

  const setFolderPasswordInputVisible = (folderId: string, visible: boolean) => {
    state.passwords.visible = {
      ...state.passwords.visible,
      [folderId]: visible,
    };
  };

  const saveFolderPassword = async (folderId: string) => {
    const password = (state.passwords.drafts[folderId] ?? "").trim();
    const scopedKey = folderPasswordScopedKey(
      activeFolderPasswordScopeDeviceId(state),
      folderId,
    );
    const next = { ...state.passwords.saved };
    delete next[folderId];
    if (scopedKey) delete next[scopedKey];
    if (password) {
      next[scopedKey || folderId] = password;
    }
    state.passwords.saved = next;
    setFolderPasswordInputVisible(folderId, false);
    try {
      await sessionStore.actions.setFolderPasswords(activeFolderPasswords(state));
      if (state.session.isConnected) {
        await refreshOverview();
        if (!folderIsLocked(state, folderId) && state.session.currentFolderId === folderId) {
          await sessionStore.actions.reloadCurrentDirectory(connectionDetails(state));
          applySessionState(state, sessionStore.getState());
          await loadDirectorySideEffects(state, client);
        }
      }
    } catch (error) {
      reportActionError(state, "folder_password.save.failed", error, { folderId });
    }
  };

  const clearFolderPassword = async (folderId: string) => {
    const scopedKey = folderPasswordScopedKey(
      activeFolderPasswordScopeDeviceId(state),
      folderId,
    );
    const next = { ...state.passwords.saved };
    delete next[folderId];
    if (scopedKey) delete next[scopedKey];
    state.passwords.saved = next;
    state.passwords.drafts = { ...state.passwords.drafts, [folderId]: "" };
    setFolderPasswordInputVisible(folderId, true);
    try {
      await sessionStore.actions.setFolderPasswords(activeFolderPasswords(state));
      if (state.session.isConnected) {
        await refreshOverview();
      }
    } catch (error) {
      reportActionError(state, "folder_password.clear.failed", error, { folderId });
    }
  };

  const addSavedDevice = () => {
    const normalized = normalizeDeviceId(state.devices.newSavedDeviceId);
    if (!normalized) {
      state.ui.recentError = "Device ID is required.";
      return;
    }
    if (!isValidSyncthingDeviceId(normalized)) {
      state.ui.recentError =
        "Device ID looks invalid. Expected 52 or 56 base32 chars (A-Z, 2-7), usually shown as grouped with dashes.";
      return;
    }
    const customName = state.devices.newSavedDeviceCustomName.trim();
    upsertSavedDevice(state, normalized, customName || suggestedSavedDeviceName(state, normalized), {
      customName: customName !== "",
      isIntroducer: state.devices.newSavedDeviceIsIntroducer,
    });
    state.devices.selectedSavedDeviceId = normalized;
    state.connection.remoteId = normalized;
    state.devices.newSavedDeviceId = "";
    state.devices.newSavedDeviceCustomName = "";
    state.devices.newSavedDeviceIsIntroducer = false;
    state.ui.recentError = null;
  };

  const editSavedDeviceName = (deviceId: string) => {
    const normalized = normalizeDeviceId(deviceId);
    if (!normalized) return;
    const initial = suggestedSavedDeviceName(state, normalized);
    const updated =
      typeof window !== "undefined"
        ? window.prompt("Edit device name:", initial)
        : initial;
    if (updated === null) return;
    if (!updated.trim()) {
      state.ui.recentError = "Device name cannot be empty.";
      return;
    }
    upsertSavedDevice(state, normalized, updated.trim(), { customName: true });
    state.ui.recentError = null;
  };

  const useSavedDevice = (deviceId: string) => {
    state.devices.selectedSavedDeviceId = deviceId;
    state.connection.remoteId = deviceId;
    if (!state.session.isConnected) {
      restoreOfflineSnapshot(state, deviceId, "use_saved_device");
    }
  };

  const setSavedDeviceIntroducer = (deviceId: string, isIntroducer: boolean) => {
    upsertSavedDevice(state, deviceId, suggestedSavedDeviceName(state, deviceId), {
      customName:
        state.devices.savedDevices.find((item) => sameDeviceId(item.id, deviceId))
          ?.customName ?? false,
      isIntroducer,
    });
  };

  const removeSavedDevice = (deviceId: string) => {
    const normalized = normalizeDeviceId(deviceId);
    setRemoteApprovalPending(state, normalized, false);
    if (sameDeviceId(state.approvals.pendingApprovalPromptDeviceId, normalized)) {
      state.approvals.pendingApprovalPromptDeviceId = "";
    }
    state.devices.savedDevices = state.devices.savedDevices.filter(
      (item) => !sameDeviceId(item.id, normalized),
    );
    if (sameDeviceId(state.connection.remoteId, normalized)) {
      state.connection.remoteId = "";
    }
    state.approvals.syncApprovedFolderKeys = new Set(
      [...state.approvals.syncApprovedFolderKeys].filter(
        (key) => !key.startsWith(`${normalized}:`),
      ),
    );
    const scopedPrefix = `${normalized}${FOLDER_PASSWORD_SCOPE_SEPARATOR}`;
    state.passwords.saved = Object.fromEntries(
      Object.entries(state.passwords.saved).filter(
        ([key]) => !key.startsWith(scopedPrefix),
      ),
    );
    state.offline.snapshots = Object.fromEntries(
      Object.entries(state.offline.snapshots).filter(
        ([key]) => !sameDeviceId(key, normalized),
      ),
    );
  };

  const approveAdvertisedDevice = (device: ReturnType<typeof advertisedDevices>[number]) => {
    if (!isValidSyncthingDeviceId(device.id)) {
      state.ui.recentError = `Advertised device ID is invalid and cannot be approved: ${device.id}`;
      return;
    }
    upsertSavedDevice(state, device.id, device.name, { customName: false });
    state.devices.selectedSavedDeviceId = device.id;
    state.connection.remoteId = device.id;
    state.ui.recentError = null;
  };

  const approveFolderSync = (folder: ReturnType<typeof advertisedFolders>[number]) => {
    const next = new Set(state.approvals.syncApprovedFolderKeys);
    next.add(folder.key);
    state.approvals.syncApprovedFolderKeys = next;
    state.ui.recentError = null;
  };

  const resetDiscoveryServer = () => {
    state.connection.discoveryServer = getDefaultDiscoveryServer();
  };

  const clearOfflineFolderState = () => {
    state.offline.snapshots = {};
    if (!state.session.isConnected) {
      state.session.folders = [];
      state.session.folderSyncStates = [];
      state.session.remoteDevice = null;
      state.session.connectionPath = "";
      state.session.connectionTransport = "";
      clearDirectoryView(state);
    }
    pushSessionLog(
      state,
      "info",
      "offline.snapshot.cleared",
      "Cleared all persisted offline folder snapshots.",
    );
  };

  const regenerateDeviceId = async () => {
    if (state.devices.isRegeneratingDeviceId) return;
    const confirmed =
      typeof window !== "undefined"
        ? window.confirm(
            "Generate a new device ID now? Other peers will treat this as a new device until approved again.",
          )
        : true;
    if (!confirmed) return;
    state.devices.isRegeneratingDeviceId = true;
    try {
      state.devices.currentDeviceId = await client.regenerateDefaultIdentity();
      state.devices.identityNotice = "New device ID generated.";
      state.devices.identityRecoverySecret = "";
      state.ui.showRestoreFromBackup = false;
    } catch (error) {
      reportActionError(state, "device_id.regenerate.failed", error);
    } finally {
      state.devices.isRegeneratingDeviceId = false;
    }
  };

  const editLocalDeviceName = () => {
    const initial = state.connection.deviceName.trim() || suggestedClientName();
    const updated =
      typeof window !== "undefined"
        ? window.prompt("Edit this device name (advertised to peers):", initial)
        : initial;
    if (updated === null) return;
    if (!updated.trim()) {
      state.ui.recentError = "Device name is required.";
      return;
    }
    state.connection.deviceName = updated.trim();
    state.devices.identityNotice = "Advertised device name updated.";
    state.ui.recentError = null;
  };

  const copyIdentityBackupSecret = async () => {
    if (state.devices.isExportingIdentityRecovery) return;
    state.devices.isExportingIdentityRecovery = true;
    try {
      const exported = await client.exportIdentityRecovery();
      await copyText(exported.recoverySecret);
      state.devices.currentDeviceId = exported.deviceId;
      state.devices.identityNotice = "Backup secret copied. Keep it in a safe place.";
    } catch (error) {
      reportActionError(state, "identity_backup.copy_secret.failed", error);
    } finally {
      state.devices.isExportingIdentityRecovery = false;
    }
  };

  const restoreIdentityRecovery = async () => {
    if (state.devices.isRestoringIdentityRecovery) return;
    if (!state.devices.identityRecoverySecret.trim()) {
      state.ui.recentError = "Backup secret is required.";
      return;
    }
    state.devices.isRestoringIdentityRecovery = true;
    try {
      await client.restoreIdentityRecovery(state.devices.identityRecoverySecret.trim());
      await refreshCurrentDeviceId();
      state.devices.identityRecoverySecret = "";
      state.ui.showRestoreFromBackup = false;
      state.devices.identityNotice = "Device identity restored from backup secret.";
    } catch (error) {
      reportActionError(state, "identity_backup.restore.failed", error);
    } finally {
      state.devices.isRestoringIdentityRecovery = false;
    }
  };

  const switchTab = (tab: AppState["activeTab"], event?: MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    if (state.activeTab === tab) return;
    state.activeTab = tab;
    pushSessionLog(state, "info", "ui.tab.switch", `Switched tab to ${tab}`);
  };

  const handleUploadSelected = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const fileName = input.files?.[0]?.name;
    state.ui.uploadMessage = fileName
      ? `Upload selected (${fileName}) but uploading is not available in this read-only BEP client yet.`
      : "";
    input.value = "";
  };

  const openDiagnosticsPage = () => {
    state.currentPage = "diagnostics";
  };

  const closeDiagnosticsPage = () => {
    state.currentPage = "main";
  };

  const runFolderDiagnosticsTest = async () => {
    const test: TaskyonTestFn = async () =>
      runFolderContentDiagnostics({
        client,
        options: connectionDetails(state),
        maxPollAttempts: 16,
        pollIntervalMs: 250,
      });
    test.description = "End-to-end folder/index/readDir diagnostics";
    test.timeoutMs = 90_000;
    const registry = buildDiagnosticsRegistry({
      builtins: [
        {
          testName: "folderContentDiagnostics",
          func: test,
          sourcePath: "packages/app/src/lib/folderDiagnostics.ts",
        },
      ],
      modules: [],
    });
    const results = await runDiagnosticsTests(registry.tests, {
      details: true,
      timeoutMs: 90_000,
    });
    const passed = results.filter((result: { ok: boolean }) => result.ok).length;
    return {
      summary: {
        runAtIso: new Date().toISOString(),
        allPassed: passed === results.length,
        passed,
        failed: results.length - passed,
      },
      results,
    };
  };

  return {
    hydrate,
    connect,
    disconnect,
    refreshOverview,
    refreshActiveView,
    refreshCurrentDeviceId,
    copyCurrentDeviceId,
    copySessionLogs,
    openFolderRoot,
    openDirectory,
    goToBreadcrumb,
    goToRootView,
    setDirectoryPage,
    setDirectoryPageSize,
    toggleFavorite,
    removeFavorite,
    openFavorite,
    openDownloadedFilesPanel,
    clearAllCache,
    removeCachedFile,
    openCachedFile,
    openCachedFileDirectory,
    openCachedDirectory,
    downloadFile,
    updateFolderPasswordDraft,
    setFolderPasswordInputVisible,
    saveFolderPassword,
    clearFolderPassword,
    addSavedDevice,
    editSavedDeviceName,
    useSavedDevice,
    setSavedDeviceIntroducer,
    removeSavedDevice,
    approveAdvertisedDevice,
    approveFolderSync,
    resetDiscoveryServer,
    clearOfflineFolderState,
    regenerateDeviceId,
    editLocalDeviceName,
    copyIdentityBackupSecret,
    restoreIdentityRecovery,
    switchTab,
    handleUploadSelected,
    openDiagnosticsPage,
    closeDiagnosticsPage,
    runFolderDiagnosticsTest,
    persist: () => persistState(state),
    restoreOfflineSnapshot: (deviceId?: string, reason?: string) =>
      restoreOfflineSnapshot(state, deviceId, reason),
  };
};

export {
  cacheFileKeyExists,
  favoriteEntryKey,
  formatBytes,
  formatModified,
  isSavedDeviceConnected,
  rootFolderEntries,
};
