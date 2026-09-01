import { normalizeDeviceId } from "@syncpeer/core/browser";
import type {
  ConnectionScope,
  FileEntry,
  FolderInfo,
  FolderSyncState,
  RemoteDeviceInfo,
} from "@syncpeer/core/browser";
import {
  activeSourceDeviceId,
  pushSessionLog,
  type AppState,
} from "./state.ts";

const sortByLastSeenDesc = <T extends { lastSeenAtMs: number }>(rows: T[]) =>
  [...rows].sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs);

const MAX_OFFLINE_DIRECTORIES = 64;
const MAX_OFFLINE_DIRECTORY_ENTRIES = 10_000;

export const offlineDirectoryKey = (folderId: string, path: string) =>
  JSON.stringify([folderId, path]);

const recentDirectories = (
  directories: NonNullable<AppState["offline"]["snapshots"][string]["directories"]>,
) => {
  let entryCount = 0;
  return Object.fromEntries(
    Object.entries(directories)
      .sort(([, left], [, right]) => right.loadedAtMs - left.loadedAtMs)
      .filter(([, directory], index) => {
        if (index >= MAX_OFFLINE_DIRECTORIES) return false;
        if (entryCount + directory.entries.length > MAX_OFFLINE_DIRECTORY_ENTRIES) {
          return false;
        }
        entryCount += directory.entries.length;
        return true;
      }),
  );
};

export const folderSignature = (folders: FolderInfo[]) =>
  folders
    .map((folder) =>
      [
        folder.id,
        folder.label,
        folder.stopReason ?? 0,
        folder.localDevicePresentInFolder ? 1 : 0,
      ].join(":"),
    )
    .sort()
    .join("|");

export const saveOfflineSnapshot = (
  state: AppState,
  sourceDeviceId: string,
  snapshot: {
    folders: FolderInfo[];
    remoteDevice: RemoteDeviceInfo | null;
    folderSyncStates: FolderSyncState[];
    connectedVia: string;
    transportKind: "direct-tcp" | "relay" | "";
    connectionScope?: ConnectionScope | "";
  },
) => {
  const deviceId = normalizeDeviceId(sourceDeviceId);
  if (!deviceId) return;
  if (snapshot.folders.length === 0 && snapshot.folderSyncStates.length === 0) return;
  const previous = state.offline.snapshots[deviceId];
  state.offline.snapshots = {
    ...state.offline.snapshots,
    [deviceId]: {
      deviceId,
      remoteDevice: snapshot.remoteDevice,
      folders: snapshot.folders,
      folderSyncStates: snapshot.folderSyncStates,
      connectedVia: snapshot.connectedVia,
      transportKind: snapshot.transportKind,
      connectionScope: snapshot.connectionScope ?? "",
      directories: previous?.directories ?? {},
      activeDirectoryKey: previous?.activeDirectoryKey,
      lastSeenAtMs: Date.now(),
    },
  };
};

export const saveOfflineDirectorySnapshot = (
  state: AppState,
  sourceDeviceId: string,
) => {
  const deviceId = normalizeDeviceId(sourceDeviceId);
  const current = state.offline.snapshots[deviceId];
  const directory = state.session.directory;
  if (!deviceId || !current || !directory.folderId || directory.status !== "ready") return;
  const key = offlineDirectoryKey(directory.folderId, directory.path);
  const loadedAtMs = directory.loadedAtMs || Date.now();
  state.offline.snapshots = {
    ...state.offline.snapshots,
    [deviceId]: {
      ...current,
      directories: recentDirectories({
        ...current.directories,
        [key]: {
          folderId: directory.folderId,
          path: directory.path,
          entries: [...directory.entries] as FileEntry[],
          versionKey: directory.versionKey,
          loadedAtMs,
        },
      }),
      activeDirectoryKey: key,
      lastSeenAtMs: Date.now(),
    },
  };
};

export const restoreOfflineDirectory = (
  state: AppState,
  folderId: string,
  path: string,
) => {
  const deviceId = normalizeDeviceId(activeSourceDeviceId(state));
  const snapshot = state.offline.snapshots[deviceId];
  const directory = snapshot?.directories?.[offlineDirectoryKey(folderId, path)];
  if (!snapshot || !directory) return false;
  state.session.directory = {
    ...state.session.directory,
    ...directory,
    entries: [...directory.entries],
    status: "ready",
    error: null,
  };
  state.session.currentFolderId = directory.folderId;
  state.session.currentPath = directory.path;
  state.session.entries = [...directory.entries];
  state.session.currentFolderVersionKey = directory.versionKey;
  state.session.directoryPage = 1;
  state.session.isOfflineSnapshot = true;
  state.session.offlineLastSeenAtMs = snapshot.lastSeenAtMs;
  return true;
};

export const hasAutoConnectTarget = (state: AppState) => {
  const remoteTarget = normalizeDeviceId(state.connection.remoteId);
  if (remoteTarget) return true;
  const selected = normalizeDeviceId(state.devices.selectedSavedDeviceId);
  if (!selected) return false;
  return !state.devices.lanDiscoveredDeviceIds.has(selected);
};

export const setRemoteApprovalPending = (
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

export const restoreOfflineSnapshot = (
  state: AppState,
  clearDirectoryView: (state: AppState) => void,
  preferredDeviceId?: string,
  reason = "restore",
) => {
  const preferred = normalizeDeviceId(preferredDeviceId ?? activeSourceDeviceId(state));
  const snapshots = sortByLastSeenDesc(Object.values(state.offline.snapshots));
  const snapshot =
    (preferred ? state.offline.snapshots[preferred] : null) ?? snapshots[0];
  if (!snapshot) return false;
  state.session.folders = snapshot.folders;
  state.session.folderSyncStates = snapshot.folderSyncStates;
  state.session.remoteDevice = snapshot.remoteDevice;
  state.session.connectionPath = snapshot.connectedVia;
  state.session.connectionTransport = snapshot.transportKind;
  state.session.connectionScope = snapshot.connectionScope ?? "";
  state.session.isOfflineSnapshot = true;
  state.session.offlineLastSeenAtMs = snapshot.lastSeenAtMs;
  const activeDirectory = snapshot.activeDirectoryKey
    ? snapshot.directories?.[snapshot.activeDirectoryKey]
    : undefined;
  if (activeDirectory) {
    restoreOfflineDirectory(state, activeDirectory.folderId, activeDirectory.path);
  } else if (
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
