import type { ConnectOptions } from "./browserClient.js";
import {
  applyOverviewToState,
  createInitialSessionState,
  ensureCurrentFolderStillExists,
  folderVersionKey,
  setCurrentLocation,
  withUpdatedFolderPasswords,
} from "./sessionPolicies.js";
import {
  makeReadDirWithRetryFlow,
  makeWaitForFolderIndexToArriveFlow,
  makeWaitForFoldersToPopulateFlow,
} from "./sessionFlows.js";
import type {
  SessionRuntimeDeps,
  SessionState,
  SessionTraceEvent,
  SyncpeerSessionStore,
} from "./sessionTypes.js";
import { normalizePath } from "./helpers.js";

const resolveErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const cloneState = (state: SessionState): SessionState => ({
  ...state,
  folders: [...state.folders],
  folderSyncStates: [...state.folderSyncStates],
  directory: {
    ...state.directory,
    entries: [...state.directory.entries],
  },
  entries: [...state.entries],
  snapshot: { ...state.snapshot },
  pending: { ...state.pending },
  connectOptions: state.connectOptions ? { ...state.connectOptions } : null,
});

const sameStringRecord = (
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined,
): boolean => {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [key, value] of leftEntries) {
    if ((right ?? {})[key] !== value) return false;
  }
  return true;
};

const directoryIsLocked = (state: SessionState): boolean => {
  const folder = state.folders.find((entry) => entry.id === state.directory.folderId);
  return Boolean(folder?.encrypted && folder.needsPassword);
};

export const createSyncpeerSessionStore = (depsInput: SessionRuntimeDeps): SyncpeerSessionStore => {
  const now = depsInput.now ?? (() => Date.now());
  const sleep = depsInput.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const emitTrace = (
    level: SessionTraceEvent["level"],
    event: string,
    message: string,
    details?: Record<string, unknown>,
  ) => {
    depsInput.onTrace?.({
      atMs: now(),
      level,
      event,
      message,
      details,
    });
  };

  let state: SessionState = createInitialSessionState();
  const listeners = new Set<(nextState: SessionState) => void>();
  const notify = (): void => {
    const snapshot = cloneState(state);
    for (const listener of listeners) listener(snapshot);
  };
  const setState = (updater: (current: SessionState) => SessionState): void => {
    state = updater(state);
    notify();
  };
  const resolveOptions = (options?: ConnectOptions): ConnectOptions => {
    const resolved = options ?? state.connectOptions;
    if (!resolved) {
      throw new Error("No connection options available. Call connect() with options first.");
    }
    return resolved;
  };
  const isConnected = (): boolean => state.phase === "connected" && state.remoteFs !== null;

  const waitForFoldersToPopulate = makeWaitForFoldersToPopulateFlow({
    sleep,
    log: (entry) => emitTrace(entry.level, entry.event, entry.message, entry.details),
  });
  const waitForFolderIndexToArrive = makeWaitForFolderIndexToArriveFlow({
    sleep,
    log: (entry) => emitTrace(entry.level, entry.event, entry.message, entry.details),
  });
  const readDirWithRetry = makeReadDirWithRetryFlow({ sleep });

  const actions = {
    connect: async (options: ConnectOptions): Promise<void> => {
      const nextEpoch = state.requestEpoch + 1;
      setState((current) => ({
        ...current,
        phase: "connecting",
        directory: current.directory.folderId
          ? {
              ...current.directory,
              entries: [],
              status: "loading",
              versionKey: "",
              error: null,
              requestSeq: current.directory.requestSeq + 1,
            }
          : current.directory,
        entries: current.directory.folderId ? [] : current.entries,
        currentFolderVersionKey: current.directory.folderId ? "" : current.currentFolderVersionKey,
        pending: {
          ...current.pending,
          connecting: true,
          refreshingOverview: false,
          loadingDirectory: false,
        },
        connectOptions: { ...options },
        requestEpoch: nextEpoch,
        lastError: null,
      }));

      try {
        if (depsInput.transport.disconnect) {
          await depsInput.transport.disconnect();
        }
        const fs = await depsInput.transport.connectAndSync(options);
        const overview = await depsInput.transport.connectAndGetOverview(options);
        setState((current) => {
          const applied = applyOverviewToState(current, overview, options);
          return ensureCurrentFolderStillExists({
            ...applied.nextState,
            remoteFs: fs,
            phase: "connected",
            pending: {
              ...applied.nextState.pending,
              connecting: false,
            },
            requestEpoch: nextEpoch,
          });
        });

        await waitForFoldersToPopulate({
          timeoutMs: 4000,
          pollIntervalMs: 200,
          isConnected,
          getCurrentFolderCount: () => state.folders.length,
          pollOverview: async () => {
            const polled = await depsInput.transport.connectAndGetOverview(options);
            setState((current) => {
              if (current.requestEpoch !== nextEpoch) return current;
              const applied = applyOverviewToState(current, polled, options);
              return ensureCurrentFolderStillExists(applied.nextState);
            });
            return {
              folderCount: Array.isArray(polled.folders) ? polled.folders.length : 0,
              connectedVia: polled.connectedVia,
              transportKind: polled.transportKind,
            };
          },
        });
        if (
          state.directory.folderId &&
          state.folders.some((folder) => folder.id === state.directory.folderId) &&
          !directoryIsLocked(state)
        ) {
          await actions.reloadCurrentDirectory(options);
        }
      } catch (error) {
        const message = resolveErrorMessage(error);
        setState((current) => ({
          ...current,
          phase: "error",
          pending: {
            ...current.pending,
            connecting: false,
            refreshingOverview: false,
            loadingDirectory: false,
          },
          remoteFs: null,
          lastError: message,
        }));
        throw error;
      }
    },

    disconnect: async (): Promise<void> => {
      try {
        await depsInput.transport.disconnect?.();
      } finally {
        setState((current) => ({
          ...current,
          phase: "idle",
          remoteFs: null,
          directory: {
            ...current.directory,
            status: "idle",
            versionKey: "",
            error: null,
          },
          currentFolderVersionKey: "",
          pending: {
            connecting: false,
            loadingDirectory: false,
            refreshingOverview: false,
          },
          requestEpoch: current.requestEpoch + 1,
        }));
      }
    },

    refreshOverview: async (options?: ConnectOptions): Promise<void> => {
      const resolved = resolveOptions(options);
      if (!state.remoteFs) return;
      setState((current) => ({
        ...current,
        phase: "refreshing",
        pending: { ...current.pending, refreshingOverview: true },
      }));
      try {
        const overview = await depsInput.transport.connectAndGetOverview(resolved);
        let shouldReloadDirectory = false;
        setState((current) => {
          const applied = applyOverviewToState(current, overview, resolved);
          const nextState = ensureCurrentFolderStillExists({
            ...applied.nextState,
            phase: "connected",
            pending: { ...applied.nextState.pending, refreshingOverview: false },
          });
          const nextVersionKey = nextState.directory.folderId
            ? folderVersionKey(nextState, nextState.directory.folderId)
            : "";
          const versionChanged =
            nextState.directory.folderId !== "" &&
            nextState.directory.status === "ready" &&
            nextVersionKey !== "" &&
            nextVersionKey !== nextState.directory.versionKey;
          shouldReloadDirectory = versionChanged || directoryIsLocked(nextState);
          if (!versionChanged) return nextState;
          return {
            ...nextState,
            directory: {
              ...nextState.directory,
              status: "stale",
              versionKey: nextState.directory.versionKey,
              error: null,
            },
          };
        });
        if (shouldReloadDirectory && state.directory.folderId && !directoryIsLocked(state)) {
          await actions.reloadCurrentDirectory(resolved);
        }
      } catch (error) {
        const message = resolveErrorMessage(error);
        setState((current) => ({
          ...current,
          phase: "error",
          pending: { ...current.pending, refreshingOverview: false },
          lastError: message,
        }));
        throw error;
      }
    },

    goToRoot: async (): Promise<void> => {
      setState((current) => ({
        ...current,
        directory: {
          ...current.directory,
          folderId: "",
          path: "",
          entries: [],
          status: "idle",
          versionKey: "",
          error: null,
        },
        currentFolderId: "",
        currentPath: "",
        entries: [],
        currentFolderVersionKey: "",
        pending: { ...current.pending, loadingDirectory: false },
      }));
    },

    openFolder: async (folderId: string, options?: ConnectOptions): Promise<void> => {
      setState((current) => setCurrentLocation(current, folderId, ""));
      await actions.reloadCurrentDirectory(options);
    },

    openPath: async (path: string, options?: ConnectOptions): Promise<void> => {
      setState((current) => ({
        ...current,
        directory: {
          ...current.directory,
          path: normalizePath(path),
          entries: [],
          status: current.directory.folderId ? "loading" : "idle",
          versionKey: "",
          error: null,
        },
        currentPath: normalizePath(path),
        entries: [],
        currentFolderVersionKey: "",
      }));
      await actions.reloadCurrentDirectory(options);
    },

    goToPath: async (
      folderId: string,
      path: string,
      options?: ConnectOptions,
    ): Promise<void> => {
      setState((current) => setCurrentLocation(current, folderId, path));
      await actions.reloadCurrentDirectory(options);
    },

    reloadCurrentDirectory: async (options?: ConnectOptions): Promise<void> => {
      const resolved = resolveOptions(options);
      const current = state;
      const folderId = current.directory.folderId || current.currentFolderId;
      if (!current.remoteFs || !folderId) return;
      const folder = current.folders.find((entry) => entry.id === folderId);
      if (folder?.encrypted && folder.needsPassword) {
        setState((next) => ({
          ...next,
          directory: {
            ...next.directory,
            entries: [],
            status: "locked",
            error: null,
          },
          entries: [],
          pending: { ...next.pending, loadingDirectory: false },
        }));
        return;
      }
      const targetEpoch = current.requestEpoch;
      const requestSeq = current.directory.requestSeq + 1;
      setState((next) => ({
        ...next,
        directoryLoadSeq: requestSeq,
        directory: {
          ...next.directory,
          status: "loading",
          error: null,
          requestSeq,
        },
        pending: { ...next.pending, loadingDirectory: true },
        lastError: null,
      }));
      try {
        const indexResult = await waitForFolderIndexToArrive({
          folderId,
          connectOptions: resolved,
          initialFolderSyncStates: state.folderSyncStates,
          fetchFolderVersions: depsInput.transport.connectAndGetFolderVersions,
          isConnected,
          onFolderSyncStates: (states) => {
            setState((next) => ({ ...next, folderSyncStates: states }));
          },
        });
        if (!indexResult.received) {
          emitTrace(
            "warning",
            "session.flow.folder_index.not_received",
            `Folder index not received yet for ${folderId}.`,
            { folderId },
          );
        }

        const path = normalizePath(state.directory.path || state.currentPath);
        const latestFolder = state.folders.find((entry) => entry.id === folderId);
        const readResult = await readDirWithRetry({
          fs: state.remoteFs!,
          folderId,
          path,
          encrypted: Boolean(latestFolder?.encrypted),
          locked: Boolean(latestFolder?.needsPassword),
          retryIntervalMs: 200,
          retryTimeoutMs: 4000,
        });
        setState((next) => {
          if (next.requestEpoch !== targetEpoch) return next;
          if (next.directory.requestSeq !== requestSeq) return next;
          const versionKey = folderVersionKey(next, folderId);
          return {
            ...next,
            directory: {
              ...next.directory,
              folderId,
              path,
              entries: readResult.entries,
              status: "ready",
              versionKey,
              loadedAtMs: now(),
              error: null,
            },
            entries: readResult.entries,
            currentFolderId: folderId,
            currentPath: path,
            currentFolderVersionKey: versionKey,
            phase: "connected",
            pending: { ...next.pending, loadingDirectory: false },
          };
        });
      } catch (error) {
        const message = resolveErrorMessage(error);
        setState((next) => ({
          ...next,
          phase: "error",
          directory: {
            ...next.directory,
            status: "error",
            error: message,
          },
          pending: { ...next.pending, loadingDirectory: false },
          lastError: message,
        }));
        throw error;
      }
    },

    setFolderPasswords: async (folderPasswords: Record<string, string>): Promise<void> => {
      if (!state.connectOptions) {
        return;
      }
      if (sameStringRecord(state.connectOptions?.folderPasswords, folderPasswords)) {
        return;
      }
      setState((current) => {
        if (!current.connectOptions) {
          return current;
        }
        const nextConnectOptions = withUpdatedFolderPasswords(
          current.connectOptions,
          folderPasswords,
        );
        return {
          ...current,
          connectOptions: nextConnectOptions,
          directory: current.directory.folderId
            ? {
                ...current.directory,
                status: "stale",
                error: null,
              }
            : current.directory,
        };
      });
    },
  };

  return {
    getState: () => cloneState(state),
    subscribe: (listener: (nextState: SessionState) => void): (() => void) => {
      listeners.add(listener);
      listener(cloneState(state));
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
  };
};
