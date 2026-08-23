import { normalizeDeviceId } from "@syncpeer/core/browser";
import type {
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
