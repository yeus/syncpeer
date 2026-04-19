import {
  breadcrumbSegments,
  buildConnectionDetails,
  cachedFileKey,
  collectAdvertisedDevices,
  collectAdvertisedFolders,
  favoriteKey,
  folderDisplayName,
  formatEta,
  formatRate,
  fromConnectionSettings,
  normalizeDeviceId,
  normalizeFolderPasswords,
  normalizeSavedDevices,
  normalizeSyncApprovedIntroducedFolderKeys,
  resolvePreferredSourceDeviceId,
  resolveFolderPasswordsForDevice,
  sameDeviceId,
  toConnectionSettings,
  type CachedFileRecord,
  type FileEntry,
  type FolderInfo,
  type FolderSyncState,
  type RemoteDeviceInfo,
  type RemoteFsLike,
  type SavedDeviceLike,
  type SessionState,
  type StoredConnectionSettingsLike,
  type UiLogEntry,
} from "@syncpeer/core/browser";

const APP_STATE_STORAGE_KEY = "syncpeer.ui.state.v1";
const SESSION_LOG_LIMIT = 2000;
const MAX_VISIBLE_CRUMBS = 4;
const DEFAULT_DIRECTORY_PAGE_SIZE = 200;
const MIN_DIRECTORY_PAGE_SIZE = 10;
const MAX_DIRECTORY_PAGE_SIZE = 2000;

const parseJson = <T,>(raw: string | null) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const loadPersistedState = () => {
  if (typeof window === "undefined") return null;
  return parseJson<{
    activeTab?: "favorites" | "folders" | "devices";
    selectedSavedDeviceId?: string;
    connection?: StoredConnectionSettingsLike;
    savedDevices?: Array<{
      id: string;
      name: string;
      createdAtMs: number;
      isIntroducer: boolean;
      customName?: boolean;
    }>;
    syncApprovedIntroducedFolderKeys?: string[];
    acceptedIntroducedFolderKeys?: string[];
    folderPasswords?: Record<string, string>;
    offlineFolderSnapshots?: Record<string, OfflineFolderSnapshot>;
    directoryPageSize?: number;
    directoryViewMode?: "list" | "grid";
  }>(window.localStorage.getItem(APP_STATE_STORAGE_KEY));
};

const normalizeDirectoryPageSize = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_DIRECTORY_PAGE_SIZE;
  return Math.min(
    MAX_DIRECTORY_PAGE_SIZE,
    Math.max(MIN_DIRECTORY_PAGE_SIZE, Math.floor(numeric)),
  );
};

const normalizeDirectoryViewMode = (value: unknown): "list" | "grid" =>
  value === "grid" ? "grid" : "list";

export const persistState = (state: AppState) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    APP_STATE_STORAGE_KEY,
    JSON.stringify({
      activeTab: state.activeTab,
      selectedSavedDeviceId: state.devices.selectedSavedDeviceId,
      connection: toConnectionSettings(state.connection),
      savedDevices: state.devices.savedDevices,
      syncApprovedIntroducedFolderKeys: [...state.approvals.syncApprovedFolderKeys].sort(),
      folderPasswords: state.passwords.saved,
      offlineFolderSnapshots: state.offline.snapshots,
      directoryPageSize: state.ui.directoryPageSize,
      directoryViewMode: state.ui.directoryViewMode,
    }),
  );
};

export const createInitialState = (persisted = loadPersistedState()) => {
  const initialConnection = fromConnectionSettings(persisted?.connection ?? null);
  const savedDevices = normalizeSavedDevices(persisted?.savedDevices);
  return {
    activeTab:
      persisted?.activeTab === "devices" || persisted?.activeTab === "folders"
        ? persisted.activeTab
        : ("favorites" as const),
    currentPage: "main" as "main" | "diagnostics",
    connection: {
      host: initialConnection.host,
      port: initialConnection.port,
      cert: initialConnection.cert,
      key: initialConnection.key,
      remoteId: initialConnection.remoteId,
      deviceName: initialConnection.deviceName,
      timeoutMs: initialConnection.timeoutMs,
      discoveryMode: initialConnection.discoveryMode,
      discoveryServer: initialConnection.discoveryServer,
      enableRelayFallback: initialConnection.enableRelayFallback,
      autoAcceptNewDevices: initialConnection.autoAcceptNewDevices,
      autoAcceptIntroducedFolders:
        initialConnection.autoAcceptIntroducedFolders,
    },
    session: {
      remoteFs: null as RemoteFsLike | null,
      isConnected: false,
      isConnecting: false,
      isRefreshing: false,
      isLoadingDirectory: false,
      remoteDevice: null as RemoteDeviceInfo | null,
      connectionPath: "",
      connectionTransport: "" as "direct-tcp" | "relay" | "",
      folders: [] as FolderInfo[],
      folderSyncStates: [] as FolderSyncState[],
      currentFolderId: "",
      currentPath: "",
      entries: [] as FileEntry[],
      currentFolderVersionKey: "",
      lastUpdatedAt: "",
      activeConnectDeviceId: "",
      connectedSourceDeviceId: "",
      hasNonEmptyOverviewInSession: false,
      directoryPage: 1,
    },
    favorites: {
      items: [] as Array<{
        key: string;
        folderId: string;
        path: string;
        name: string;
        kind: "folder" | "file";
      }>,
      downloadedFiles: [] as CachedFileRecord[],
      cachedFileKeys: new Set<string>(),
      showDownloadedFiles: false,
      isLoadingDownloadedFiles: false,
      isDownloading: false,
      activeDownloadKey: "",
      activeDownloadText: "",
      isOpeningCachedFile: false,
      isRemovingCachedFile: false,
      isClearingCache: false,
    },
    devices: {
      savedDevices: savedDevices as SavedDeviceLike[],
      selectedSavedDeviceId: normalizeDeviceId(
        persisted?.selectedSavedDeviceId || savedDevices[0]?.id || "",
      ),
      newSavedDeviceId: "",
      newSavedDeviceCustomName: "",
      newSavedDeviceIsIntroducer: false,
      currentDeviceId: "",
      isLoadingCurrentDeviceId: false,
      isRegeneratingDeviceId: false,
      identityNotice: "",
      isExportingIdentityRecovery: false,
      isRestoringIdentityRecovery: false,
      identityRecoverySecret: "",
      lanDiscoveredDeviceIds: new Set<string>(),
      lanDiscoveryByDeviceId: {} as Record<
        string,
        { addresses: string[]; lastSeenAtMs: number }
      >,
      isDiscoveringLanDevices: false,
    },
    approvals: {
      syncApprovedFolderKeys: normalizeSyncApprovedIntroducedFolderKeys(
        persisted?.syncApprovedIntroducedFolderKeys ??
          persisted?.acceptedIntroducedFolderKeys,
      ),
      remoteApprovalPendingIds: new Set<string>(),
      pendingApprovalPromptDeviceId: "",
    },
    passwords: {
      saved: normalizeFolderPasswords(persisted?.folderPasswords),
      drafts: { ...normalizeFolderPasswords(persisted?.folderPasswords) },
      visible: {} as Record<string, boolean>,
    },
    offline: {
      snapshots: persisted?.offlineFolderSnapshots ?? {},
    },
    ui: {
      isSettingsExpanded: false,
      isLogPanelExpanded: false,
      isDeviceBackupExpanded: false,
      showRestoreFromBackup: false,
      autoConnectPaused: false,
      isAppVisible: true,
      uploadMessage: "",
      uploadProgressActive: false,
      uploadProgressPercent: 0,
      uploadProgressEta: "",
      uploadProgressRate: "",
      downloadNotice: "",
      recentError: null as string | null,
      lastLoggedError: "",
      directoryPageSize: normalizeDirectoryPageSize(persisted?.directoryPageSize),
      directoryViewMode: normalizeDirectoryViewMode(persisted?.directoryViewMode),
    },
    sync: {
      lastOverviewAtMs: 0,
      folderSignature: "",
      folderSignatureChangedAtMs: 0,
      lastRecoveryReconnectAtMs: 0,
      isRecoveringFolderSync: false,
      isSyncingStarredFiles: false,
      starredFileSyncState: {} as Record<
        string,
        {
          lastLocalHash: string;
          lastRemoteModifiedMs: number;
          lastSyncAtMs: number;
          lastDirection: "upload" | "download" | "baseline";
        }
      >,
    },
    logs: {
      nextId: 1,
      items: [] as Array<{
        id: string;
        timestampMs: number;
        level: "info" | "warning" | "error";
        event: string;
        message: string;
        details?: unknown;
      }>,
    },
  };
};

export type AppState = ReturnType<typeof createInitialState>;

export interface OfflineFolderSnapshot {
  deviceId: string;
  remoteDevice: import("@syncpeer/core/browser").RemoteDeviceInfo | null;
  folders: import("@syncpeer/core/browser").FolderInfo[];
  folderSyncStates: import("@syncpeer/core/browser").FolderSyncState[];
  connectedVia: string;
  transportKind: "direct-tcp" | "relay" | "";
  lastSeenAtMs: number;
}

export const pushSessionLog = (
  state: AppState,
  level: "info" | "warning" | "error",
  event: string,
  message: string,
  details?: unknown,
) => {
  state.logs.items = [
    {
      id: `${Date.now()}-${state.logs.nextId}`,
      timestampMs: Date.now(),
      level,
      event,
      message,
      details,
    },
    ...state.logs.items,
  ].slice(0, SESSION_LOG_LIMIT);
  state.logs.nextId += 1;
};

const classifyUiLogLevel = (
  state: AppState,
  entry: UiLogEntry,
  details: Record<string, unknown> | undefined,
) => {
  if (
    entry.event === "tauri.invoke.error" &&
    state.session.isConnecting &&
    (details?.command === "syncpeer_tls_open" ||
      details?.command === "syncpeer_relay_open")
  ) {
    return "warning" as const;
  }
  if (
    entry.event === "core.discovery.candidate.failed" ||
    entry.event === "core.discovery.relay.failed"
  ) {
    return "warning" as const;
  }
  return entry.level;
};

export const pushClientLog = (state: AppState, entry: UiLogEntry) => {
  const details =
    entry.details && typeof entry.details === "object"
      ? (entry.details as Record<string, unknown>)
      : undefined;
  const message =
    typeof details?.message === "string" && details.message.trim()
      ? details.message
      : entry.event;
  pushSessionLog(
    state,
    classifyUiLogLevel(state, entry, details),
    entry.event,
    message,
    entry.details,
  );
};

export const setError = (
  state: AppState,
  event: string,
  rawError: unknown,
  details?: unknown,
) => {
  const message = rawError instanceof Error ? rawError.message : String(rawError);
  state.ui.recentError = message;
  pushSessionLog(state, "error", event, message, details);
};

export const applySessionState = (state: AppState, next: SessionState) => {
  const previousFolderId = state.session.currentFolderId;
  const previousPath = state.session.currentPath;
  state.session.remoteFs = next.remoteFs;
  state.session.isConnected =
    next.phase === "connected" || next.phase === "refreshing";
  state.session.isConnecting = next.pending.connecting;
  state.session.isRefreshing = next.pending.refreshingOverview;
  state.session.isLoadingDirectory = next.pending.loadingDirectory;
  state.session.folders = next.folders;
  state.session.folderSyncStates = next.folderSyncStates;
  state.session.currentFolderId = next.currentFolderId;
  state.session.currentPath = next.currentPath;
  state.session.entries = next.entries;
  if (
    previousFolderId !== state.session.currentFolderId ||
    previousPath !== state.session.currentPath
  ) {
    state.session.directoryPage = 1;
  }
  const totalPages = Math.max(
    1,
    Math.ceil(state.session.entries.length / state.ui.directoryPageSize),
  );
  if (state.session.directoryPage > totalPages) {
    state.session.directoryPage = totalPages;
  }
  state.session.currentFolderVersionKey = next.currentFolderVersionKey;
  state.session.remoteDevice = next.remoteDevice;
  state.session.connectionPath = next.connectionPath;
  state.session.connectionTransport = next.connectionTransport;
  if (next.lastError) {
    state.ui.recentError = next.lastError;
  }
};

export const activeFolderPasswordScopeDeviceId = (state: AppState) =>
  resolvePreferredSourceDeviceId(
    state.session.remoteDevice?.id,
    state.connection.remoteId,
    state.devices.selectedSavedDeviceId,
  );

export const activeFolderPasswords = (state: AppState) =>
  resolveFolderPasswordsForDevice(
    state.passwords.saved,
    activeFolderPasswordScopeDeviceId(state),
  );

export const activeSourceDeviceId = (state: AppState) =>
  resolvePreferredSourceDeviceId(
    state.session.remoteDevice?.id,
    state.connection.remoteId,
    state.devices.selectedSavedDeviceId,
  );

export const currentSourceDeviceId = (state: AppState) =>
  normalizeDeviceId(state.session.remoteDevice?.id ?? state.connection.remoteId);

export const isIntroducerDevice = (state: AppState, deviceId: string) =>
  state.devices.savedDevices.some(
    (device) =>
      sameDeviceId(device.id, deviceId) && device.isIntroducer === true,
  );

export const currentSourceIsIntroducer = (state: AppState) =>
  state.session.isConnected && isIntroducerDevice(state, currentSourceDeviceId(state));

export const favoriteKeys = (state: AppState) =>
  new Set(state.favorites.items.map((item) => item.key));

export const visibleBreadcrumbs = (state: AppState) =>
  breadcrumbSegments(
    state.session.currentFolderId,
    state.session.currentPath,
    state.session.folders,
    MAX_VISIBLE_CRUMBS,
  );

export const rootFolderEntries = (state: AppState) =>
  state.session.folders
    .map((folder) => ({
      id: folder.id,
      name: folderDisplayName(folder),
      readOnly: folder.readOnly,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

export const folderState = (state: AppState, folderId: string) =>
  state.session.folders.find((folder) => folder.id === folderId);

export const folderIsLocked = (state: AppState, folderId: string) => {
  const folder = folderState(state, folderId);
  return Boolean(folder?.encrypted && folder?.needsPassword);
};

export const folderLockLabel = (state: AppState, folderId: string) => {
  const folder = folderState(state, folderId);
  if (!folder?.encrypted) return "";
  if (folder.passwordError) return "password error";
  return folder.needsPassword ? "locked" : "unlocked";
};

export const isFolderPasswordInputVisible = (state: AppState, folderId: string) => {
  if (state.passwords.visible[folderId]) return true;
  const folder = folderState(state, folderId);
  if (!folder?.encrypted) return false;
  if (folderIsLocked(state, folderId)) return true;
  if (folder.passwordError) return true;
  return !activeFolderPasswords(state)[folderId];
};

export const advertisedDevices = (state: AppState) =>
  collectAdvertisedDevices(
    state.session.folders,
    state.devices.savedDevices,
    currentSourceDeviceId(state),
    currentSourceIsIntroducer(state),
  );

export const advertisedFolders = (state: AppState) =>
  collectAdvertisedFolders(
    state.session.folders,
    currentSourceDeviceId(state),
    currentSourceIsIntroducer(state),
    state.approvals.syncApprovedFolderKeys,
  );

export const isSavedDeviceConnected = (state: AppState, deviceId: string) =>
  state.session.isConnected &&
  sameDeviceId(state.session.remoteDevice?.id ?? state.connection.remoteId, deviceId);

export const isLanDiscoveredDevice = (state: AppState, deviceId: string) =>
  state.devices.lanDiscoveredDeviceIds.has(normalizeDeviceId(deviceId));

export const isSavedDeviceAwaitingRemoteApproval = (
  state: AppState,
  deviceId: string,
) => state.approvals.remoteApprovalPendingIds.has(normalizeDeviceId(deviceId));

export const connectionDetails = (state: AppState) =>
  buildConnectionDetails(state.connection, activeFolderPasswords(state));

export const downloadButtonLabel = (
  state: AppState,
  folderId: string,
  path: string,
) => {
  const key = cachedFileKey(folderId, path);
  return key === state.favorites.activeDownloadKey
    ? state.favorites.activeDownloadText || "Downloading..."
    : "Download";
};

export const formatBytes = (size: number) => {
  if (!Number.isFinite(size) || size < 0) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

export const formatModified = (ms: number) =>
  ms ? new Date(ms).toLocaleString() : "n/a";

export const shouldHintRemoteApprovalPending = (message: string) => {
  const normalized = message.toLowerCase();
  const connectionClosedCount = (normalized.match(/connection closed/g) ?? [])
    .length;
  return (
    normalized.includes("may be waiting for you to accept this device") ||
    normalized.includes("remote peer rejected this device") ||
    normalized.includes("waiting for approval of this client") ||
    normalized.includes("unknown device") ||
    normalized.includes("not configured") ||
    normalized.includes("not in config") ||
    (normalized.includes("could not connect using discovered candidates") &&
      connectionClosedCount >= 2)
  );
};

export const hasSuccessfulConnectionHistory = (
  state: AppState,
  deviceId: string,
) => {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) return false;
  return Boolean(state.offline.snapshots[normalized]);
};

export const connectionModeLabel = (state: AppState) =>
  state.connection.discoveryMode === "global"
    ? `Global discovery via ${state.connection.discoveryServer}`
    : `Direct ${state.connection.host || "127.0.0.1"}:${state.connection.port}`;

export const connectTargetLabel = (state: AppState) => {
  const targetId = normalizeDeviceId(
    state.connection.remoteId || state.devices.selectedSavedDeviceId,
  );
  if (!targetId) return "";
  const saved = state.devices.savedDevices.find((device) =>
    sameDeviceId(device.id, targetId),
  );
  const savedName = saved?.name.trim() ?? "";
  return savedName ? `${savedName} (${targetId})` : targetId;
};

export const directoryTotalPages = (state: AppState) =>
  Math.max(1, Math.ceil(state.session.entries.length / state.ui.directoryPageSize));

export const directoryCurrentPage = (state: AppState) =>
  Math.min(
    directoryTotalPages(state),
    Math.max(1, Math.floor(state.session.directoryPage || 1)),
  );

export const paginatedDirectoryEntries = (state: AppState) => {
  const pageSize = state.ui.directoryPageSize;
  const page = directoryCurrentPage(state);
  const start = (page - 1) * pageSize;
  return state.session.entries.slice(start, start + pageSize);
};

export const folderVersionKeyFromState = (state: AppState, folderId: string) => {
  const syncState = state.session.folderSyncStates.find(
    (item) => item.folderId === folderId,
  );
  return syncState ? `${syncState.remoteIndexId}:${syncState.remoteMaxSequence}` : "";
};

export const cacheFileKeyExists = (
  state: AppState,
  folderId: string,
  path: string,
) => state.favorites.cachedFileKeys.has(cachedFileKey(folderId, path));

export const favoriteEntryKey = (
  folderId: string,
  path: string,
  kind: "folder" | "file",
) => favoriteKey(folderId, path, kind);

export const downloadProgressText = (
  downloadedBytes: number,
  totalBytes: number,
  elapsedSeconds: number,
) => {
  const speed = downloadedBytes / Math.max(elapsedSeconds, 0.001);
  const percent =
    totalBytes > 0 ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)) : 0;
  const remainingBytes = Math.max(totalBytes - downloadedBytes, 0);
  const etaSeconds =
    speed > 0 ? remainingBytes / speed : Number.POSITIVE_INFINITY;
  return `${percent}% • ${formatRate(speed)} • ETA ${formatEta(etaSeconds)}`;
};
