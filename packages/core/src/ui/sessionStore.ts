import type { ConnectOptions } from "./browserClient.js";
import type { ConnectionLifecycleState } from "./connectionLifecycle.js";
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
  type FlowDeps,
} from "./sessionFlows.js";
import {
  directoryToError,
  directoryToIdle,
  directoryToLoading,
  directoryToLocked,
  directoryToReady,
  directoryToStale,
  directoryToStaleKeepingVersion,
} from "./sessionTransitions.js";
import type {
  SessionRuntimeActions,
  SessionRuntimeDeps,
  SessionState,
  SessionTraceEvent,
  SyncpeerSessionStore,
} from "./sessionTypes.js";
import { normalizePath } from "./helpers.js";

type TraceEmitter = (
  level: SessionTraceEvent["level"],
  event: string,
  message: string,
  details?: Record<string, unknown>,
) => void;

interface SessionActionContext {
  readonly deps: SessionRuntimeDeps;
  readonly now: () => number;
  readonly emitTrace: TraceEmitter;
  readonly getState: () => SessionState;
  readonly setState: (updater: (current: SessionState) => SessionState) => void;
  readonly isConnected: () => boolean;
  readonly resolveOptions: (options?: ConnectOptions) => ConnectOptions;
  readonly waitForFoldersToPopulate: ReturnType<typeof makeWaitForFoldersToPopulateFlow>;
  readonly waitForFolderIndexToArrive: ReturnType<typeof makeWaitForFolderIndexToArriveFlow>;
  readonly readDirWithRetry: ReturnType<typeof makeReadDirWithRetryFlow>;
  reloadCurrentDirectory: (options?: ConnectOptions) => Promise<void>;
}

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

const beginConnect = (ctx: SessionActionContext, options: ConnectOptions, nextEpoch: number): void => {
  ctx.setState((current) => ({
    ...current,
    phase: "connecting",
    directory: current.directory.folderId
      ? {
          ...directoryToLoading(current, current.directory.requestSeq + 1).directory,
          versionKey: "",
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
};

const applyConnectResult = (
  ctx: SessionActionContext,
  nextEpoch: number,
  options: ConnectOptions,
  remoteFs: SessionState["remoteFs"],
  overview: Awaited<ReturnType<SessionRuntimeDeps["transport"]["connectAndGetOverview"]>>,
): void => {
  ctx.setState((current) => {
    if (current.requestEpoch !== nextEpoch) return current;
    const applied = applyOverviewToState(current, overview, options);
    return ensureCurrentFolderStillExists({
      ...applied.nextState,
      remoteFs,
      phase: "connected",
      pending: {
        ...applied.nextState.pending,
        connecting: false,
      },
      requestEpoch: nextEpoch,
    });
  });
};

const pollFoldersPopulated = async (
  ctx: SessionActionContext,
  nextEpoch: number,
  options: ConnectOptions,
): Promise<void> => {
  await ctx.waitForFoldersToPopulate({
    timeoutMs: 4000,
    pollIntervalMs: 200,
    isConnected: ctx.isConnected,
    getCurrentFolderCount: () => ctx.getState().folders.length,
    pollOverview: async () => {
      const polled = await ctx.deps.transport.connectAndGetOverview(options);
      ctx.setState((current) => {
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
};

const reloadConnectedDirectory = async (
  ctx: SessionActionContext,
  options: ConnectOptions,
): Promise<void> => {
  const state = ctx.getState();
  if (
    state.directory.folderId &&
    state.folders.some((folder) => folder.id === state.directory.folderId) &&
    !directoryIsLocked(state)
  ) {
    await ctx.reloadCurrentDirectory(options);
  }
};

const failConnect = (ctx: SessionActionContext, nextEpoch: number, error: unknown): void => {
  const message = resolveErrorMessage(error);
  ctx.setState((current) =>
    current.requestEpoch !== nextEpoch
      ? current
      : {
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
        },
  );
};

const connectAction = async (
  ctx: SessionActionContext,
  options: ConnectOptions,
): Promise<void> => {
  const nextEpoch = ctx.getState().requestEpoch + 1;
  beginConnect(ctx, options, nextEpoch);
  try {
    const remoteFs = await ctx.deps.transport.connectAndSync(options);
    const overview = await ctx.deps.transport.connectAndGetOverview(options);
    applyConnectResult(ctx, nextEpoch, options, remoteFs, overview);
    if (ctx.getState().requestEpoch !== nextEpoch) return;
    await pollFoldersPopulated(ctx, nextEpoch, options);
    await reloadConnectedDirectory(ctx, options);
  } catch (error) {
    failConnect(ctx, nextEpoch, error);
    throw error;
  }
};

const beginDisconnect = (ctx: SessionActionContext, disconnectEpoch: number): void => {
  ctx.setState((current) => ({
    ...current,
    phase: "stopping",
    remoteFs: null,
    directory: {
      ...directoryToIdle(current).directory,
      versionKey: "",
    },
    currentFolderVersionKey: "",
    pending: {
      connecting: false,
      loadingDirectory: false,
      refreshingOverview: false,
    },
    requestEpoch: disconnectEpoch,
  }));
};

const finishDisconnect = (ctx: SessionActionContext, disconnectEpoch: number): void => {
  ctx.setState((current) =>
    current.requestEpoch !== disconnectEpoch
      ? current
      : {
          ...current,
          phase: "idle",
          remoteFs: null,
          directory: {
            ...directoryToIdle(current).directory,
            versionKey: "",
          },
          currentFolderVersionKey: "",
          pending: {
            connecting: false,
            loadingDirectory: false,
            refreshingOverview: false,
          },
        },
  );
};

const disconnectAction = async (ctx: SessionActionContext): Promise<void> => {
  const disconnectEpoch = ctx.getState().requestEpoch + 1;
  beginDisconnect(ctx, disconnectEpoch);
  try {
    await ctx.deps.transport.disconnect?.();
  } finally {
    finishDisconnect(ctx, disconnectEpoch);
  }
};

const beginRefresh = (ctx: SessionActionContext): void => {
  ctx.setState((current) => ({
    ...current,
    phase: "refreshing",
    directory: (
      current.directory.folderId && current.directory.status === "ready"
        ? directoryToStale(current)
        : current
    ).directory,
    pending: { ...current.pending, refreshingOverview: true },
  }));
};

const applyRefreshedOverview = (
  ctx: SessionActionContext,
  targetEpoch: number,
  overview: Awaited<ReturnType<SessionRuntimeDeps["transport"]["connectAndGetOverview"]>>,
  resolved: ConnectOptions,
): boolean => {
  let shouldReloadDirectory = false;
  ctx.setState((current) => {
    if (current.requestEpoch !== targetEpoch || current.remoteFs === null) return current;
    const applied = applyOverviewToState(current, overview, resolved);
    const nextState = ensureCurrentFolderStillExists({
      ...applied.nextState,
      phase: "connected",
      pending: { ...applied.nextState.pending, refreshingOverview: false },
    });
    const nextVersionKey = nextState.directory.folderId
      ? folderVersionKey(nextState, nextState.directory.folderId)
      : "";
    const hasSelectedFolder = nextState.directory.folderId !== "";
    const versionChanged =
      hasSelectedFolder &&
      nextVersionKey !== "" &&
      nextVersionKey !== nextState.directory.versionKey;
    const staleNeedsReload =
      hasSelectedFolder &&
      nextState.directory.status === "stale";
    shouldReloadDirectory =
      versionChanged ||
      staleNeedsReload ||
      directoryIsLocked(nextState);
    if (!versionChanged) return nextState;
    return directoryToStaleKeepingVersion(nextState, nextState.directory.versionKey);
  });
  return shouldReloadDirectory;
};

const failRefresh = (ctx: SessionActionContext, targetEpoch: number, error: unknown): void => {
  const message = resolveErrorMessage(error);
  ctx.setState((current) =>
    current.requestEpoch !== targetEpoch
      ? current
      : {
          ...current,
          phase: "error",
          pending: { ...current.pending, refreshingOverview: false },
          lastError: message,
        },
  );
};

const refreshOverviewAction = async (
  ctx: SessionActionContext,
  options?: ConnectOptions,
): Promise<void> => {
  const resolved = ctx.resolveOptions(options);
  if (!ctx.getState().remoteFs) return;
  const targetEpoch = ctx.getState().requestEpoch;
  beginRefresh(ctx);
  try {
    const overview = await ctx.deps.transport.connectAndGetOverview(resolved);
    const shouldReloadDirectory = applyRefreshedOverview(ctx, targetEpoch, overview, resolved);
    if (ctx.getState().requestEpoch !== targetEpoch || !ctx.getState().remoteFs) return;
    if (shouldReloadDirectory && ctx.getState().directory.folderId && !directoryIsLocked(ctx.getState())) {
      await ctx.reloadCurrentDirectory(resolved);
    }
  } catch (error) {
    failRefresh(ctx, targetEpoch, error);
    throw error;
  }
};

const goToRootAction = async (ctx: SessionActionContext): Promise<void> => {
  ctx.getState().remoteFs?.setFocusedFolder(null);
  ctx.setState((current) => {
    const requestSeq = current.directory.requestSeq + 1;
    return {
      ...current,
      directoryLoadSeq: requestSeq,
      directory: {
        ...directoryToIdle(current).directory,
        folderId: "",
        path: "",
        entries: [],
        versionKey: "",
        requestSeq,
      },
      currentFolderId: "",
      currentPath: "",
      entries: [],
      currentFolderVersionKey: "",
      pending: { ...current.pending, loadingDirectory: false },
    };
  });
};

const openFolderAction = async (
  ctx: SessionActionContext,
  folderId: string,
  options?: ConnectOptions,
): Promise<void> => {
  ctx.getState().remoteFs?.setFocusedFolder(folderId);
  ctx.setState((current) => setCurrentLocation(current, folderId, ""));
  await ctx.reloadCurrentDirectory(options);
};

const openPathAction = async (
  ctx: SessionActionContext,
  path: string,
  options?: ConnectOptions,
): Promise<void> => {
  ctx.setState((current) => ({
    ...current,
    directory: {
      ...directoryToLoading(current, current.directory.requestSeq).directory,
      path: normalizePath(path),
      entries: [],
      status: current.directory.folderId ? "loading" : "idle",
      versionKey: "",
    },
    currentPath: normalizePath(path),
    entries: [],
    currentFolderVersionKey: "",
  }));
  await ctx.reloadCurrentDirectory(options);
};

const goToPathAction = async (
  ctx: SessionActionContext,
  folderId: string,
  path: string,
  options?: ConnectOptions,
): Promise<void> => {
  ctx.getState().remoteFs?.setFocusedFolder(folderId);
  ctx.setState((current) => setCurrentLocation(current, folderId, path));
  await ctx.reloadCurrentDirectory(options);
};

const waitForFolderIndex = (
  ctx: SessionActionContext,
  folderId: string,
  resolved: ConnectOptions,
  targetEpoch: number,
) =>
  ctx.waitForFolderIndexToArrive({
    folderId,
    connectOptions: resolved,
    initialFolderSyncStates: ctx.getState().folderSyncStates,
    fetchFolderVersions: ctx.deps.transport.connectAndGetFolderVersions,
    isConnected: ctx.isConnected,
    onFolderSyncStates: (states) => {
      ctx.setState((next) =>
        next.requestEpoch === targetEpoch ? { ...next, folderSyncStates: states } : next,
      );
    },
  });

const readDirectoryForFolder = async (
  ctx: SessionActionContext,
  remoteFs: NonNullable<SessionState["remoteFs"]>,
  folderId: string,
  readPath: string,
) => {
  const latestFolder = ctx.getState().folders.find((entry) => entry.id === folderId);
  return ctx.readDirWithRetry({
    fs: remoteFs,
    folderId,
    path: readPath,
    encrypted: Boolean(latestFolder?.encrypted),
    locked: Boolean(latestFolder?.needsPassword),
    retryEmpty: true,
    retryIntervalMs: 200,
    retryTimeoutMs: 4000,
  });
};

const reportMissingFolderIndex = (ctx: SessionActionContext, folderId: string): never => {
  ctx.emitTrace(
    "warning",
    "session.flow.folder_index.not_received",
    `Folder index not received yet for ${folderId}.`,
    { folderId },
  );
  throw new Error(
    `Folder index was not received for ${folderId}; directory contents are not available yet.`,
  );
};

const applyDirectoryRead = (
  ctx: SessionActionContext,
  targetEpoch: number,
  requestSeq: number,
  folderId: string,
  readPath: string,
  entries: SessionState["entries"],
): void => {
  ctx.setState((next) => {
    if (next.requestEpoch !== targetEpoch) return next;
    if (next.directory.requestSeq !== requestSeq) return next;
    return directoryToReady(
      next,
      folderId,
      readPath,
      entries,
      folderVersionKey(next, folderId),
      ctx.now(),
    );
  });
};

const failDirectoryLoad = (
  ctx: SessionActionContext,
  targetEpoch: number,
  requestSeq: number,
  error: unknown,
): void => {
  const message = resolveErrorMessage(error);
  ctx.setState((next) =>
    next.requestEpoch === targetEpoch && next.directory.requestSeq === requestSeq
      ? directoryToError(next, message)
      : next,
  );
};

const reloadCurrentDirectoryAction = async (
  ctx: SessionActionContext,
  options?: ConnectOptions,
): Promise<void> => {
  const resolved = ctx.resolveOptions(options);
  const current = ctx.getState();
  const folderId = current.directory.folderId || current.currentFolderId;
  if (!current.remoteFs || !folderId) return;
  current.remoteFs.setFocusedFolder(folderId);
  const readPath = normalizePath(current.directory.path || current.currentPath);
  const folder = current.folders.find((entry) => entry.id === folderId);
  if (folder?.encrypted && folder.needsPassword) {
    ctx.setState((next) => directoryToLocked(next));
    return;
  }
  const targetEpoch = current.requestEpoch;
  const requestSeq = current.directory.requestSeq + 1;
  ctx.setState((next) => directoryToLoading(next, requestSeq));
  try {
    const indexResult = await waitForFolderIndex(ctx, folderId, resolved, targetEpoch);
    if (!indexResult.received) reportMissingFolderIndex(ctx, folderId);
    const readResult = await readDirectoryForFolder(ctx, current.remoteFs, folderId, readPath);
    applyDirectoryRead(ctx, targetEpoch, requestSeq, folderId, readPath, readResult.entries);
  } catch (error) {
    failDirectoryLoad(ctx, targetEpoch, requestSeq, error);
    throw error;
  }
};

const applyFolderPasswords = (
  ctx: SessionActionContext,
  folderPasswords: Record<string, string>,
): void => {
  ctx.setState((current) => {
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
      directory: (current.directory.folderId ? directoryToStale(current) : current).directory,
    };
  });
};

const setFolderPasswordsAction = async (
  ctx: SessionActionContext,
  folderPasswords: Record<string, string>,
): Promise<void> => {
  const state = ctx.getState();
  if (!state.connectOptions) return;
  if (sameStringRecord(state.connectOptions.folderPasswords, folderPasswords)) return;
  applyFolderPasswords(ctx, folderPasswords);
};

const createSessionActions = (ctx: SessionActionContext): SessionRuntimeActions => ({
  connect: (options) => connectAction(ctx, options),
  disconnect: () => disconnectAction(ctx),
  refreshOverview: (options) => refreshOverviewAction(ctx, options),
  goToRoot: () => goToRootAction(ctx),
  openFolder: (folderId, options) => openFolderAction(ctx, folderId, options),
  openPath: (path, options) => openPathAction(ctx, path, options),
  goToPath: (folderId, path, options) => goToPathAction(ctx, folderId, path, options),
  reloadCurrentDirectory: (options) => reloadCurrentDirectoryAction(ctx, options),
  setFolderPasswords: (folderPasswords) => setFolderPasswordsAction(ctx, folderPasswords),
  setOnline: async (online) => {
    await ctx.deps.transport.setOnline?.(online);
  },
  setForeground: async (foreground) => {
    await ctx.deps.transport.setForeground?.(foreground);
  },
  setTransferActive: async (active) => {
    await ctx.deps.transport.setTransferActive?.(active);
  },
});

const applyLifecycleState = (
  ctx: SessionActionContext,
  lifecycle: ConnectionLifecycleState,
): ConnectOptions | null => {
  let recoveryOptions: ConnectOptions | null = null;
  ctx.setState((current) => {
    const needsRecovery =
      lifecycle.phase === "connected" &&
      current.remoteFs === null &&
      !current.pending.connecting &&
      current.connectOptions !== null;
    if (needsRecovery) recoveryOptions = { ...current.connectOptions! };
    return {
      ...current,
      phase: needsRecovery ? "reconnecting" : lifecycle.phase,
      attempt: lifecycle.attempt,
      nextRetryAtMs: lifecycle.nextRetryAtMs,
      closureReason: lifecycle.closureReason,
      upgradeStatus: lifecycle.upgradeStatus,
      remoteFs: current.remoteFs,
      pending: {
        ...current.pending,
        connecting:
          needsRecovery ||
          lifecycle.phase === "connecting" ||
          lifecycle.phase === "reconnecting",
      },
    };
  });
  return recoveryOptions;
};

const subscribeToLifecycle = (ctx: SessionActionContext): void => {
  let lifecycleRecovery: Promise<void> | null = null;
  const recover = (options: ConnectOptions): void => {
    if (lifecycleRecovery) return;
    const recovery = Promise.resolve()
      .then(() => connectAction(ctx, options))
      .catch((error) => {
        ctx.emitTrace(
          "warning",
          "session.lifecycle_recovery.failed",
          "Could not restore session state after reconnect.",
          { error: resolveErrorMessage(error) },
        );
      });
    lifecycleRecovery = recovery;
    void recovery.finally(() => {
      if (lifecycleRecovery === recovery) lifecycleRecovery = null;
    });
  };
  ctx.deps.transport.subscribeLifecycle?.((lifecycle) => {
    const recoveryOptions = applyLifecycleState(ctx, lifecycle);
    if (recoveryOptions) recover(recoveryOptions);
  });
};

const createSessionTrace = (depsInput: SessionRuntimeDeps) => {
  const now = depsInput.now ?? (() => Date.now());
  const sleep = depsInput.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const emitTrace: TraceEmitter = (level, event, message, details) => {
    depsInput.onTrace?.({ atMs: now(), level, event, message, details });
  };
  return { now, sleep, emitTrace };
};

const createSessionStateStore = () => {
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
  return {
    getState: () => state,
    setState,
    subscribe: (listener: (nextState: SessionState) => void): (() => void) => {
      listeners.add(listener);
      listener(cloneState(state));
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const createSessionContext = (args: {
  deps: SessionRuntimeDeps;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  emitTrace: TraceEmitter;
  store: ReturnType<typeof createSessionStateStore>;
}): SessionActionContext => {
  const { deps, now, sleep, emitTrace, store } = args;
  const resolveOptions = (options?: ConnectOptions): ConnectOptions => {
    const resolved = options ?? store.getState().connectOptions;
    if (!resolved) {
      throw new Error("No connection options available. Call connect() with options first.");
    }
    return resolved;
  };
  const isConnected = (): boolean => {
    const state = store.getState();
    return state.phase === "connected" && state.remoteFs !== null;
  };
  const flowDeps: FlowDeps = {
    sleep,
    now,
    log: (entry) => emitTrace(entry.level, entry.event, entry.message, entry.details),
  };
  const context: SessionActionContext = {
    deps,
    now,
    emitTrace,
    getState: store.getState,
    setState: store.setState,
    isConnected,
    resolveOptions,
    waitForFoldersToPopulate: makeWaitForFoldersToPopulateFlow(flowDeps),
    waitForFolderIndexToArrive: makeWaitForFolderIndexToArriveFlow(flowDeps),
    readDirWithRetry: makeReadDirWithRetryFlow({ sleep, now }),
    reloadCurrentDirectory: (options) => reloadCurrentDirectoryAction(context, options),
  };
  return context;
};

export const createSyncpeerSessionStore = (depsInput: SessionRuntimeDeps): SyncpeerSessionStore => {
  const { now, sleep, emitTrace } = createSessionTrace(depsInput);
  const store = createSessionStateStore();
  const context = createSessionContext({ deps: depsInput, now, sleep, emitTrace, store });
  const actions = createSessionActions(context);
  subscribeToLifecycle(context);
  return {
    getState: () => cloneState(store.getState()),
    subscribe: store.subscribe,
    actions,
  };
};
