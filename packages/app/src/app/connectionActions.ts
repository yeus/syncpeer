import {
  normalizeDeviceId,
  sameDeviceId,
  type AppBuildInfo,
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import { reportUiError } from "../lib/tauriAdapters.js";
import { formatAppBuildInfo } from "../lib/appInfo.ts";
import { reportActionError } from "./actionErrors.ts";
import {
  refreshCachedStatuses,
  refreshFolderRootCachedStatuses,
} from "./cacheStatusActions.ts";
import {
  activeFolderPasswords,
  advertisedFolders,
  applySessionState,
  connectionDetails,
  currentSourceDeviceId,
  activeSourceDeviceId,
  hasSuccessfulConnectionHistory,
  pushSessionLog,
  shouldHintRemoteApprovalPending,
  type AppState,
} from "./state.ts";
import { localDiscoveryUnavailableNotice } from "./connectionNotices.ts";
import {
  applyAutoApprovals,
  normalizeCandidateAddresses,
  normalizeCandidateDeviceId,
  parseTcpAddress,
  suggestedSavedDeviceName,
  syncConnectedDeviceSavedName,
  upsertSavedDevice,
} from "./devicePolicies.ts";
import {
  hasAutoConnectTarget,
  restoreOfflineSnapshot,
  setRemoteApprovalPending,
} from "./syncPolicies.ts";
import {
  clearDirectoryView,
  ensureClientName,
  loadDirectorySideEffects,
  migrateActiveLegacyFolderPasswords,
  nowTime,
  remoteHasUnapprovedFolderShare,
  resetRuntimeState,
  restoreAfterTransportFailure,
  saveCurrentOfflineState,
  validateConnection,
  copyText,
} from "./actionSupport.ts";
import type { TransferRuntime } from "./transferRuntime.ts";

export const createConnectionActions = (args: {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly transfers: TransferRuntime;
  readonly syncStarredFiles: () => Promise<void>;
  readonly appInfo: AppBuildInfo;
}) => {
  const { state, client, sessionStore, transfers, syncStarredFiles, appInfo } = args;
  const { transferInProgress } = transfers;
  let connectInFlight: Promise<void> | null = null;
  let connectionSettingsTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionSettingsGeneration = 0;

const connect = async (targetDeviceId?: string) => {
  if (connectInFlight) {
    await connectInFlight;
    return;
  }
  connectInFlight = (async () => {
  state.ui.recentError = null;
  state.ui.uploadMessage = "";
  state.ui.autoConnectPaused = false;
  if (!ensureClientName(state)) {
    state.session.activeConnectDeviceId = "";
    return;
  }
  if (targetDeviceId) {
    state.devices.selectedSavedDeviceId = targetDeviceId;
    state.connection.remoteId = targetDeviceId;
    state.connection.discoveryMode = "automatic";
    state.connection.host = "";
    state.session.activeConnectDeviceId = targetDeviceId;
  }
  validateConnection(state);
  const attemptedDeviceId = normalizeDeviceId(
    targetDeviceId || state.connection.remoteId || state.devices.selectedSavedDeviceId,
  );
  restoreOfflineSnapshot(state, clearDirectoryView, attemptedDeviceId, "connect_start");
  try {
    migrateActiveLegacyFolderPasswords(state);
    await sessionStore.actions.setFolderPasswords(activeFolderPasswords(state));
    await sessionStore.actions.connect(connectionDetails(state));
    const session = sessionStore.getState();
    applySessionState(state, session);
    migrateActiveLegacyFolderPasswords(state);
    await sessionStore.actions.setFolderPasswords(activeFolderPasswords(state));
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
    saveCurrentOfflineState(state, sourceDeviceId);
    applyAutoApprovals(state, currentSourceDeviceId(state), advertisedFolders(state));
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
    reportUiError("connect.failed", error, {
      discoveryMode: state.connection.discoveryMode,
      timeoutMs: state.connection.timeoutMs,
    });
    resetRuntimeState(state);
    restoreOfflineSnapshot(state, clearDirectoryView, attemptedDeviceId, "connect_failed");
  } finally {
    state.session.activeConnectDeviceId = "";
  }
  })();
  try {
    await connectInFlight;
  } finally {
    connectInFlight = null;
  }
};

const ensureConnectedForTransfer = async (
  transferKind: "download" | "upload",
): Promise<boolean> => {
  if (state.session.isConnected && state.session.remoteFs) return true;
  pushSessionLog(
    state,
    "info",
    "transfer.reconnect.start",
    `Reconnecting before ${transferKind}.`,
    { transferKind },
  );
  await connect();
  const connected = state.session.isConnected && !!state.session.remoteFs;
  if (!connected) {
    pushSessionLog(
      state,
      "warning",
      "transfer.reconnect.failed",
      `Could not reconnect before ${transferKind}.`,
      { transferKind },
    );
  }
  return connected;
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
  if (transferInProgress()) return;
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
    saveCurrentOfflineState(state, sourceDeviceId);
    applyAutoApprovals(state, currentSourceDeviceId(state), advertisedFolders(state));
    if (
      state.activeTab === "folders" &&
      state.session.currentFolderId &&
      state.session.directory.status === "ready"
    ) {
      await loadDirectorySideEffects(state, client);
    }
    state.session.lastUpdatedAt = nowTime();
  } catch (error) {
    reportActionError(state, "refresh_overview.failed", error, connectionDetails(state));
    restoreAfterTransportFailure(state, error);
  }
};

const refreshActiveView = async () => {
  if (transferInProgress()) return;
  await refreshOverview();
  await syncStarredFiles();
};

const hydrate = async () => {
  pushSessionLog(state, "info", "app.build.info", "Build metadata", {
    ...appInfo,
  });
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
  saveCurrentOfflineState(state, activeSourceDeviceId(state));
  connectionSettingsGeneration += 1;
  if (connectionSettingsTimer) clearTimeout(connectionSettingsTimer);
  connectionSettingsTimer = null;
  state.ui.autoConnectPaused = true;
  try {
    await sessionStore.actions.disconnect();
  } catch (error) {
    reportActionError(state, "disconnect.failed", error);
  } finally {
    resetRuntimeState(state);
    clearDirectoryView(state);
    restoreOfflineSnapshot(state, clearDirectoryView, undefined, "disconnect");
    state.ui.recentError = null;
  }
};

const applyConnectionSettings = async (generation: number) => {
  if (generation !== connectionSettingsGeneration) return;
  if (!hasAutoConnectTarget(state)) return;
  const obsoleteConnect = connectInFlight;
  if (
    obsoleteConnect || (
      state.session.lifecyclePhase !== "idle" &&
      state.session.lifecyclePhase !== "error"
    )
  ) {
    await sessionStore.actions.disconnect();
    if (obsoleteConnect) await obsoleteConnect;
    if (generation !== connectionSettingsGeneration) return;
    resetRuntimeState(state);
  }
  if (generation !== connectionSettingsGeneration) return;
  state.ui.autoConnectPaused = false;
  await connect();
};

const scheduleConnectionSettingsApply = () => {
  if (connectionSettingsTimer) clearTimeout(connectionSettingsTimer);
  const generation = ++connectionSettingsGeneration;
  connectionSettingsTimer = setTimeout(() => {
    connectionSettingsTimer = null;
    void applyConnectionSettings(generation).catch((error) => {
      reportActionError(state, "connection_settings.apply_failed", error);
    });
  }, 500);
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

const discoverLocalDevices = async (options?: { timeoutMs?: number }) => {
  if (transferInProgress()) return;
  if (state.devices.isDiscoveringLanDevices) return;
  state.devices.isDiscoveringLanDevices = true;
  try {
    const localDeviceId = normalizeDeviceId(state.devices.currentDeviceId);
    const discovered = await client.discoverLocalDevices({
      timeoutMs: options?.timeoutMs ?? 1400,
    });
    const nextSeenIds = new Set<string>();
    const nextByDeviceId: Record<
      string,
      { addresses: string[]; lastSeenAtMs: number }
    > = {};
    const nextAnonymous: Array<{
      id: string;
      addresses: string[];
      lastSeenAtMs: number;
    }> = [];
    for (const candidate of discovered) {
      const addresses = normalizeCandidateAddresses(candidate.addresses);
      if (candidate.anonymous) {
        if (addresses.length > 0) {
          nextAnonymous.push({
            id: candidate.deviceId,
            addresses,
            lastSeenAtMs: Date.now(),
          });
        }
        continue;
      }
      const candidateDeviceId = normalizeCandidateDeviceId(candidate.deviceId);
      if (!candidateDeviceId) continue;
      if (candidateDeviceId === localDeviceId) continue;
      nextSeenIds.add(candidateDeviceId);
      nextByDeviceId[candidateDeviceId] = {
        addresses,
        lastSeenAtMs: Date.now(),
      };
      upsertSavedDevice(
        state,
        candidateDeviceId,
        suggestedSavedDeviceName(state, candidateDeviceId),
        { customName: false },
      );
    }
    state.devices.lanDiscoveredDeviceIds = nextSeenIds;
    state.devices.lanDiscoveryByDeviceId = nextByDeviceId;
    state.devices.lanAnonymousCandidates = nextAnonymous;
    state.devices.localDiscoveryNotice = "";
  } catch (error) {
    const notice = localDiscoveryUnavailableNotice(error);
    if (notice) {
      const changed = state.devices.localDiscoveryNotice !== notice;
      state.devices.localDiscoveryNotice = notice;
      if (changed) {
        pushSessionLog(state, "warning", "lan_discovery.unavailable", notice);
      }
    } else {
      state.devices.localDiscoveryNotice = "";
      reportActionError(state, "lan_discovery.failed", error, options);
    }
  } finally {
    state.devices.isDiscoveringLanDevices = false;
  }
};

const connectViaLanAnonymousCandidate = async (candidateId: string) => {
  const candidate = state.devices.lanAnonymousCandidates.find(
    (entry) => entry.id === candidateId,
  );
  if (!candidate) {
    state.ui.recentError = "LAN candidate not found.";
    return;
  }
  const parsed = candidate.addresses
    .map((entry) => parseTcpAddress(entry))
    .find((entry): entry is { host: string; port: number } => !!entry);
  if (!parsed) {
    state.ui.recentError = "LAN candidate has no usable tcp:// address.";
    return;
  }
  state.connection.discoveryMode = "direct";
  state.connection.host = parsed.host;
  state.connection.port = parsed.port;
  state.connection.remoteId = "";
  state.devices.selectedSavedDeviceId = "";
  await connect();
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
  const logBody = state.logs.items
    .slice()
    .reverse()
    .map((item) => {
      const base = `${new Date(item.timestampMs).toISOString()} [${item.level.toUpperCase()}] ${item.event}: ${item.message}`;
      return item.details === undefined
        ? base
        : `${base}\n${JSON.stringify(item.details, null, 2)}`;
    })
    .join("\n\n");
  const metadata = [
    formatAppBuildInfo(appInfo),
    "",
    "# Session Logs",
  ].join("\n");
  const text = `${metadata}\n${logBody || "No session logs yet."}`;
  try {
    await copyText(text);
  } catch (error) {
    reportActionError(state, "logs.copy.failed", error);
  }
};


  return {
    connect,
    ensureConnectedForTransfer,
    refreshOverview,
    refreshActiveView,
    hydrate,
    disconnect,
    scheduleConnectionSettingsApply,
    refreshCurrentDeviceId,
    discoverLocalDevices,
    connectViaLanAnonymousCandidate,
    copyCurrentDeviceId,
    copySessionLogs,
    dispose: () => {
      if (connectionSettingsTimer) clearTimeout(connectionSettingsTimer);
      connectionSettingsTimer = null;
    },
  };
};
