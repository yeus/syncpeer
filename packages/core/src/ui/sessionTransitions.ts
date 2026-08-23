import type { FileEntry } from "../core/model/remoteFs.js";
import type { SessionState } from "./sessionTypes.js";

export const directoryToLoading = (
  state: SessionState,
  requestSeq: number,
): SessionState => ({
  ...state,
  directoryLoadSeq: requestSeq,
  directory: {
    ...state.directory,
    status: "loading",
    error: null,
    requestSeq,
  },
  pending: { ...state.pending, loadingDirectory: true },
  lastError: null,
});

export const directoryToReady = (
  state: SessionState,
  folderId: string,
  path: string,
  entries: FileEntry[],
  versionKey: string,
  loadedAtMs: number,
): SessionState => ({
  ...state,
  directory: {
    ...state.directory,
    folderId,
    path,
    entries,
    status: "ready",
    versionKey,
    loadedAtMs,
    error: null,
  },
  entries,
  currentFolderId: folderId,
  currentPath: path,
  currentFolderVersionKey: versionKey,
  phase: "connected",
  pending: { ...state.pending, loadingDirectory: false },
});

export const directoryToStale = (state: SessionState): SessionState => ({
  ...state,
  directory: {
    ...state.directory,
    status: "stale",
    error: null,
  },
});

export const directoryToIdle = (state: SessionState): SessionState => ({
  ...state,
  directory: {
    ...state.directory,
    status: "idle",
    error: null,
  },
});

export const directoryToStaleKeepingVersion = (
  state: SessionState,
  versionKey: string,
): SessionState => {
  const staleState = directoryToStale(state);
  return {
    ...staleState,
    directory: {
      ...staleState.directory,
      versionKey,
    },
  };
};

export const directoryToLocked = (state: SessionState): SessionState => ({
  ...state,
  directory: {
    ...state.directory,
    entries: [],
    status: "locked",
    error: null,
  },
  entries: [],
  pending: { ...state.pending, loadingDirectory: false },
});

export const directoryToError = (
  state: SessionState,
  message: string,
): SessionState => ({
  ...state,
  phase: "error",
  directory: {
    ...state.directory,
    status: "error",
    error: message,
  },
  pending: { ...state.pending, loadingDirectory: false },
  lastError: message,
});
