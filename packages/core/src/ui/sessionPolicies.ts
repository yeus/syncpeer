import type { ConnectionOverview, ConnectOptions } from "./browserClient.ts";
import type { SessionState } from "./sessionTypes.ts";
import { normalizeDeviceId, normalizePath } from "./helpers.ts";

export const createInitialSessionState = (): SessionState => ({
  phase: "idle",
  sourceDeviceId: "",
  remoteFs: null,
  remoteDevice: null,
  connectionPath: "",
  connectionTransport: "",
  folders: [],
  folderSyncStates: [],
  currentFolderId: "",
  currentPath: "",
  entries: [],
  currentFolderVersionKey: "",
  snapshot: {
    active: false,
    sourceDeviceId: "",
    liveDataSeenInSession: false,
  },
  pending: {
    connecting: false,
    loadingDirectory: false,
    refreshingOverview: false,
  },
  connectOptions: null,
  requestEpoch: 0,
  directoryLoadSeq: 0,
  lastError: null,
});

export const resolveOverviewSourceDeviceId = (
  overview: ConnectionOverview,
  connectOptions: ConnectOptions | null,
): string =>
  normalizeDeviceId(overview.device?.id ?? connectOptions?.remoteId ?? "");

export const resolvePreferredSourceDeviceId = (
  remoteDeviceId: string | null | undefined,
  connectionRemoteId: string | null | undefined,
  selectedSavedDeviceId: string | null | undefined,
): string =>
  normalizeDeviceId(remoteDeviceId ?? connectionRemoteId ?? selectedSavedDeviceId ?? "");

export const shouldPreserveEmptyOverview = (
  state: SessionState,
  sourceDeviceId: string,
  nextFolders: unknown[],
): boolean =>
  nextFolders.length === 0 &&
  state.folders.length > 0 &&
  sourceDeviceId !== "" &&
  sourceDeviceId === state.sourceDeviceId &&
  state.snapshot.liveDataSeenInSession;

export const applyOverviewToState = (
  state: SessionState,
  overview: ConnectionOverview,
  connectOptions: ConnectOptions | null,
): { nextState: SessionState; preservedEmpty: boolean } => {
  const nextFolders = Array.isArray(overview.folders) ? overview.folders : [];
  const sourceDeviceId = resolveOverviewSourceDeviceId(overview, connectOptions);
  const preservedEmpty = shouldPreserveEmptyOverview(state, sourceDeviceId, nextFolders);
  if (preservedEmpty) {
    return {
      nextState: {
        ...state,
        connectionPath: overview.connectedVia,
        connectionTransport: overview.transportKind,
      },
      preservedEmpty: true,
    };
  }
  const nextFolderSyncStates = Array.isArray(overview.folderSyncStates)
    ? overview.folderSyncStates
    : [];
  const hasLiveFolders = nextFolders.length > 0;
  return {
    nextState: {
      ...state,
      sourceDeviceId,
      remoteDevice: overview.device ?? null,
      folders: nextFolders,
      folderSyncStates: nextFolderSyncStates,
      connectionPath: overview.connectedVia,
      connectionTransport: overview.transportKind,
      snapshot: {
        active: hasLiveFolders || nextFolderSyncStates.length > 0,
        sourceDeviceId,
        restoredAtMs: hasLiveFolders || nextFolderSyncStates.length > 0
          ? Date.now()
          : state.snapshot.restoredAtMs,
        liveDataSeenInSession: state.snapshot.liveDataSeenInSession || hasLiveFolders,
      },
    },
    preservedEmpty: false,
  };
};

export const ensureCurrentFolderStillExists = (state: SessionState): SessionState => {
  if (!state.currentFolderId) return state;
  if (state.folders.length === 0) return state;
  if (state.folders.some((folder) => folder.id === state.currentFolderId)) {
    return state;
  }
  return {
    ...state,
    currentFolderId: "",
    currentPath: "",
    entries: [],
    currentFolderVersionKey: "",
  };
};

export const folderVersionKey = (state: SessionState, folderId: string): string => {
  const syncState = state.folderSyncStates.find((entry) => entry.folderId === folderId);
  if (!syncState) return "";
  return `${syncState.remoteIndexId}:${syncState.remoteMaxSequence}`;
};

export const setCurrentLocation = (
  state: SessionState,
  folderId: string,
  path: string,
): SessionState => ({
  ...state,
  currentFolderId: folderId,
  currentPath: normalizePath(path),
});

export const withUpdatedFolderPasswords = (
  options: ConnectOptions | null,
  folderPasswords: Record<string, string>,
): ConnectOptions | null => {
  if (!options) return null;
  return {
    ...options,
    folderPasswords: { ...folderPasswords },
  };
};
