import {
  normalizeDeviceId,
  observePeer,
  expirePeerDiscovery,
  sameDeviceId,
  type AppBuildInfo,
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import { reportUiError } from "../lib/tauriAdapters.js";
import {
  CLIPBOARD_SESSION_LOG_LIMIT_BYTES,
  clipboardSessionLogsTooLarge,
  describeSessionLogSize,
  formatSessionLogs,
  sessionLogFileName,
  sessionLogTextSize,
  type SessionLogFilePort,
} from "./sessionLogs.ts";
import { reportActionError } from "./actionErrors.ts";
import {
  refreshCachedStatuses,
  refreshFolderRootCachedStatuses,
} from "./cacheStatusActions.ts";
import {
  activeFolderPasswords,
  applySessionState,
  reconcileFolderUnlockStatuses,
  connectionDetails,
  currentSourceDeviceId,
  activeSourceDeviceId,
  hasSuccessfulConnectionHistory,
  pushSessionLog,
  setError,
  shouldHintRemoteApprovalPending,
  type AppState,
} from "./state.ts";
import { localDiscoveryUnavailableNotice } from "./connectionNotices.ts";
import {
  recordAdvertisedPeerSuggestions,
  normalizeCandidateAddresses,
  normalizeCandidateDeviceId,
  syncConnectedDeviceSavedName,
  preferredConnectionForDevice,
  rememberAuthenticatedTcpEndpoint,
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
  resetRuntimeState,
  restoreAfterTransportFailure,
  saveCurrentOfflineState,
  validateConnection,
  copyText,
} from "./actionSupport.ts";
import type { TransferRuntime } from "./transferRuntime.ts";

type ConnectionActionArgs = {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly transfers: TransferRuntime;
  readonly syncStarredFiles: () => Promise<void>;
  readonly loadFavoriteSyncStates: () => Promise<void>;
  readonly appInfo: AppBuildInfo;
  readonly logFile?: SessionLogFilePort;
};

type ConnectionActionControl = {
  connectInFlight: Promise<void> | null;
  disconnectInFlight: Promise<void> | null;
  connectRequestGeneration: number;
  connectionSettingsTimer: ReturnType<typeof setTimeout> | null;
  connectionSettingsGeneration: number;
  lastAttemptedConnectionSettings: string | null;
};

export const createConnectionActions = (args: ConnectionActionArgs) => {
  const control: ConnectionActionControl = {
    connectInFlight: null,
    disconnectInFlight: null,
    connectionSettingsTimer: null,
    connectRequestGeneration: 0,
    connectionSettingsGeneration: 0,
    lastAttemptedConnectionSettings: null,
  };
  // Focus, pageshow and periodic refresh may fire together. Keep one native
  // overview/metadata pass active per app controller, without blocking a
  // subsequent refresh once it settles.
  let overviewInFlight: Promise<void> | null = null;
  let activeViewInFlight: Promise<void> | null = null;
  const refreshOverviewOnce = (): Promise<void> => {
    if (overviewInFlight) return overviewInFlight;
    const next = refreshOverview(args).finally(() => {
      if (overviewInFlight === next) overviewInFlight = null;
    });
    overviewInFlight = next;
    return next;
  };
  const refreshActiveViewOnce = (): Promise<void> => {
    if (activeViewInFlight) return activeViewInFlight;
    const next = (async () => {
      if (args.transfers.transferInProgress()) return;
      await refreshOverviewOnce();
      await args.syncStarredFiles();
      await args.loadFavoriteSyncStates();
    })().finally(() => {
      if (activeViewInFlight === next) activeViewInFlight = null;
    });
    activeViewInFlight = next;
    return next;
  };
  return {
    connect: (targetDeviceId?: string) => connect(args, control, targetDeviceId),
    ensureConnectedForTransfer: (kind: "download" | "upload") =>
      ensureConnectedForTransfer(args, control, kind),
    refreshOverview: refreshOverviewOnce,
    refreshActiveView: refreshActiveViewOnce,
    hydrate: () => hydrate(args),
    disconnect: () => disconnect(args, control),
    scheduleConnectionSettingsApply: () => scheduleConnectionSettingsApply(args, control),
    refreshCurrentDeviceId: () => refreshCurrentDeviceId(args),
    discoverLocalDevices: (options?: { timeoutMs?: number }) =>
      discoverLocalDevices(args, options),
    copyCurrentDeviceId: () => copyCurrentDeviceId(args),
    copySessionLogs: () => copySessionLogs(args),
    saveSessionLogs: () => saveSessionLogs(args),
    shareSessionLogs: () => shareSessionLogs(args),
    dispose: () => dispose(control),
  };
};

const connect = async (
  args: ConnectionActionArgs,
  control: ConnectionActionControl,
  targetDeviceId?: string,
) => {
  const { state, client, sessionStore } = args;
  // A native Android stop can take seconds. Never dial until teardown finishes.
  if (control.disconnectInFlight) await control.disconnectInFlight.catch(() => undefined);
  control.connectionSettingsGeneration += 1;
  if (control.connectionSettingsTimer) clearTimeout(control.connectionSettingsTimer);
  control.connectionSettingsTimer = null;
  if (control.connectInFlight && (!targetDeviceId ||
    sameDeviceId(targetDeviceId, state.session.activeConnectDeviceId)) &&
    control.lastAttemptedConnectionSettings === JSON.stringify(connectionDetails(state))) {
    await control.connectInFlight;
    return;
  }
  const generation = ++control.connectRequestGeneration;
  if (control.connectInFlight) {
    const previous = control.connectInFlight;
    pushSessionLog(state, "info", "peer.connect.switch_requested",
      "A newer peer selection is replacing an in-flight connection attempt.",
      { peerId: normalizeDeviceId(targetDeviceId ?? "") });
    // Cancel the underlying session before starting another. Do not await a stale
    // WebView/native connect promise: it may remain pending after socket cancellation.
    await sessionStore.actions.disconnect();
    if (generation !== control.connectRequestGeneration) return;
    if (control.connectInFlight === previous) control.connectInFlight = null;
  }
  control.connectInFlight = (async () => {
  if (state.ui.storageUnavailable) {
    state.ui.recentError =
      "Encrypted local storage is unavailable. Recover the vault before connecting to a peer.";
    state.ui.autoConnectPaused = true;
    pushSessionLog(state, "error", "peer.connect.blocked_local_storage",
      "The connection was not attempted: encrypted peer settings could not be opened.");
    return;
  }
  state.ui.recentError = null;
  state.ui.uploadMessage = "";
  state.ui.autoConnectPaused = false;
  if (!ensureClientName(state)) {
    state.session.activeConnectDeviceId = "";
    return;
  }
  if (targetDeviceId) {
    state.devices.selectedSavedDeviceId = targetDeviceId;
    Object.assign(state.connection, preferredConnectionForDevice(state.connection, targetDeviceId));
  }
  validateConnection(state);
  const attemptedDeviceId = normalizeDeviceId(
    targetDeviceId || state.connection.remoteId || state.devices.selectedSavedDeviceId,
  );
  // Record the peer being dialed even for an automatic connect. Otherwise a later
  // explicit "use" of the same peer looks like a switch and cancels this attempt.
  state.session.activeConnectDeviceId = attemptedDeviceId;
  if (attemptedDeviceId) delete state.devices.connectionErrors[attemptedDeviceId];
  pushSessionLog(state, "info", "peer.connect.attempt_started",
    "Attempting an authenticated peer connection; this does not confirm remote approval.",
    { peerId: attemptedDeviceId });
  restoreOfflineSnapshot(state, clearDirectoryView, attemptedDeviceId, "connect_start");
  try {
    migrateActiveLegacyFolderPasswords(state);
    await sessionStore.actions.setFolderPasswords(activeFolderPasswords(state));
    if (generation !== control.connectRequestGeneration) return;
    const requested = connectionDetails(state);
    control.lastAttemptedConnectionSettings = JSON.stringify(requested);
    await sessionStore.actions.connect(requested);
    if (generation !== control.connectRequestGeneration) return;
    const session = sessionStore.getState();
    applySessionState(state, session);
    migrateActiveLegacyFolderPasswords(state);
    await sessionStore.actions.setFolderPasswords(activeFolderPasswords(state));
    if (generation !== control.connectRequestGeneration) return;
    await refreshFolderRootCachedStatuses(
      state,
      client,
      session.folders.map((folder) => folder.id),
    );
    if (generation !== control.connectRequestGeneration) return;
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
    if (sourceDeviceId) delete state.devices.connectionErrors[sourceDeviceId];
    // A completed authenticated BEP session proves mutual device admission.
    pushSessionLog(state, "info", "peer.connect.authenticated",
      "The remote peer accepted an authenticated BEP session.",
      { peerId: sourceDeviceId });
    if (state.session.isConnected && sourceDeviceId) {
      state.devices.confirmedPeerIds = new Set([...state.devices.confirmedPeerIds, sourceDeviceId]);
      rememberAuthenticatedTcpEndpoint(state, sourceDeviceId);
    }
    if (
      state.approvals.pendingApprovalPromptDeviceId &&
      (sameDeviceId(state.approvals.pendingApprovalPromptDeviceId, attemptedDeviceId) ||
        sameDeviceId(state.approvals.pendingApprovalPromptDeviceId, sourceDeviceId))
    ) {
      state.approvals.pendingApprovalPromptDeviceId = "";
    }
    saveCurrentOfflineState(state, sourceDeviceId);
    recordAdvertisedPeerSuggestions(state, currentSourceDeviceId(state));
    // No advertised folders is a valid authenticated connection, not an instruction
    // to disable reconnect after the next Android standby transition.
    state.session.lastUpdatedAt = nowTime();
  } catch (error) {
    if (generation !== control.connectRequestGeneration) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!state.ui.isAppVisible && /connection is suspended or offline|connection attempt was cancelled/i.test(message)) {
      // Android's system Sharesheet backgrounds the WebView. The UI lifecycle
      // then deliberately suspends its local connect; the native service may
      // still connect and its next foreground push will reattach the UI.
      // This is neither a reachability error nor a reason to warn about trust.
      pushSessionLog(state, "info", "peer.connect.suspended",
        "Foreground connection paused while Syncpeer is in the background.");
      resetRuntimeState(state);
      restoreOfflineSnapshot(state, clearDirectoryView, attemptedDeviceId, "connect_suspended");
      return;
    }
    const unavailableRoster = error instanceof Error &&
      error.name === "ProtectedPeerRosterUnavailableError";
    pushSessionLog(state, unavailableRoster ? "error" : "warning",
      unavailableRoster ? "peer.connect.blocked_local_storage" : "peer.connect.attempt_failed",
      unavailableRoster
        ? "Connection blocked locally: encrypted peer permissions could not be read. No network connection was attempted."
        : "Peer connection did not complete; remote approval or reachability may be required.",
      { peerId: attemptedDeviceId, reason: message });
    if (attemptedDeviceId) state.devices.connectionErrors[attemptedDeviceId] = message;
    state.ui.recentError = message;
    // A revoked or explicitly disallowed identity must not enter a retry loop.
    if (unavailableRoster ||
      /not authorized|revoked|retired|not paired|removed from (?:the )?trusted device list/i.test(message)) {
      state.ui.autoConnectPaused = true;
    }
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
    if (generation === control.connectRequestGeneration) state.session.activeConnectDeviceId = "";
  }
  })();
  const current = control.connectInFlight;
  try {
    await current;
  } finally {
    if (control.connectInFlight === current) control.connectInFlight = null;
  }
};

const ensureConnectedForTransfer = async (
  args: ConnectionActionArgs,
  control: ConnectionActionControl,
  transferKind: "download" | "upload",
): Promise<boolean> => {
  const { state } = args;
  if (state.session.isConnected && state.session.remoteFs) return true;
  pushSessionLog(
    state,
    "info",
    "transfer.reconnect.start",
    `Reconnecting before ${transferKind}.`,
    { transferKind },
  );
  await connect(args, control);
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

const refreshOverview = async (args: ConnectionActionArgs) => {
  const { state, client, sessionStore, transfers } = args;
  const { transferInProgress } = transfers;
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
    reconcileFolderUnlockStatuses(state);
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
    setRemoteApprovalPending(state, sourceDeviceId, false);
    if (state.session.isConnected && sourceDeviceId) {
      state.devices.confirmedPeerIds = new Set([...state.devices.confirmedPeerIds, sourceDeviceId]);
    }
    saveCurrentOfflineState(state, sourceDeviceId);
    recordAdvertisedPeerSuggestions(state, currentSourceDeviceId(state));
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

const hydrate = async (args: ConnectionActionArgs) => {
  const { state, client, loadFavoriteSyncStates, appInfo } = args;
  pushSessionLog(state, "info", "app.build.info", "Build metadata", {
    ...appInfo,
  });
  try {
    const settings = await client.loadProfileSettings();
    state.favorites.exclusions = Object.values(settings.folders).flatMap(folder => folder.exclusions);
    state.favorites.ignorePatternsByFolder = Object.fromEntries(Object.entries(settings.folders)
      .map(([folderId, folder]) => [folderId, [...folder.ignorePatterns]]));
    state.favorites.pausedFolderIds = new Set(Object.entries(settings.folders)
      .filter(([, folder]) => folder.paused).map(([folderId]) => folderId));
    state.favorites.items = await client.listFavorites();
    await loadFavoriteSyncStates();
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

const disconnect = async (args: ConnectionActionArgs, control: ConnectionActionControl) => {
  const { state, sessionStore } = args;
  if (control.disconnectInFlight) return control.disconnectInFlight;
  saveCurrentOfflineState(state, activeSourceDeviceId(state));
  control.connectionSettingsGeneration += 1;
  if (control.connectionSettingsTimer) clearTimeout(control.connectionSettingsTimer);
  control.connectionSettingsTimer = null;
  state.ui.autoConnectPaused = true;
  // Invalidate an unfinished dial before asking Android to stop its session.
  control.connectRequestGeneration += 1;
  control.connectInFlight = null;
  const presentOffline = (reason: string) => {
    resetRuntimeState(state);
    clearDirectoryView(state);
    restoreOfflineSnapshot(state, clearDirectoryView, undefined, reason);
    state.ui.recentError = null;
  };
  // Cached browsing must work immediately, even during a slow native stop RPC.
  presentOffline("pause");
  const stopping = sessionStore.actions.disconnect();
  control.disconnectInFlight = stopping;
  try {
    await stopping;
  } catch (error) {
    reportActionError(state, "disconnect.failed", error);
  } finally {
    if (control.disconnectInFlight === stopping) control.disconnectInFlight = null;
    if (state.ui.autoConnectPaused) presentOffline("disconnect");
  }
};

const applyConnectionSettings = async (
  args: ConnectionActionArgs,
  control: ConnectionActionControl,
  generation: number,
) => {
  const { state, sessionStore } = args;
  if (generation !== control.connectionSettingsGeneration) return;
  if (state.ui.autoConnectPaused) return;
  if (!hasAutoConnectTarget(state)) return;
  // Some controls emit change events even when their effective value is
  // unchanged (notably during Android WebView restoration). Such a no-op must
  // not supersede a live or in-flight authenticated peer connection.
  if (control.lastAttemptedConnectionSettings === JSON.stringify(connectionDetails(state))) return;
  const obsoleteConnect = control.connectInFlight;
  if (
    obsoleteConnect || (
      state.session.lifecyclePhase !== "idle" &&
      state.session.lifecyclePhase !== "error"
    )
  ) {
    // Supersede the old UI attempt *before* disconnecting. Native disconnect
    // cancels its transport, but the old JS promise may never settle.
    if (obsoleteConnect) {
      control.connectRequestGeneration += 1;
      control.connectInFlight = null;
    }
    await sessionStore.actions.disconnect();
    if (generation !== control.connectionSettingsGeneration || state.ui.autoConnectPaused) return;
    resetRuntimeState(state);
  }
  if (generation !== control.connectionSettingsGeneration || state.ui.autoConnectPaused) return;
  state.ui.autoConnectPaused = false;
  await connect(args, control);
};

const scheduleConnectionSettingsApply = (
  args: ConnectionActionArgs,
  control: ConnectionActionControl,
) => {
  if (control.connectionSettingsTimer) clearTimeout(control.connectionSettingsTimer);
  const generation = ++control.connectionSettingsGeneration;
  control.connectionSettingsTimer = setTimeout(() => {
    control.connectionSettingsTimer = null;
    void applyConnectionSettings(args, control, generation).catch((error) => {
      reportActionError(args.state, "connection_settings.apply_failed", error);
    });
  }, 500);
};

const refreshCurrentDeviceId = async (args: ConnectionActionArgs) => {
  const { state, client } = args;
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

const discoverLocalDevices = async (
  args: ConnectionActionArgs,
  options?: { timeoutMs?: number },
) => {
  const { state, client, transfers } = args;
  if (transfers.transferInProgress()) return;
  if (state.devices.isDiscoveringLanDevices) return;
  state.devices.localDiscoveryHealth = "scanning";
  state.devices.isDiscoveringLanDevices = true;
  try {
    const localDeviceId = normalizeDeviceId(state.devices.currentDeviceId);
    const discovered = await client.discoverLocalDevices({
      timeoutMs: options?.timeoutMs ?? 1400,
    });
    const nextSeenIds = new Set<string>();
    let discovery = state.devices.peerDiscovery;
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
      const lastSeenAtMs = Date.now();
      nextByDeviceId[candidateDeviceId] = { addresses, lastSeenAtMs };
      discovery = observePeer(discovery, candidateDeviceId, { kind: "lan", addresses, lastSeenAtMs });
    }
    state.devices.peerDiscovery = expirePeerDiscovery(discovery, Date.now(),
      state.devices.savedDevices.map(device => device.id));
    state.devices.lanDiscoveredDeviceIds = nextSeenIds;
    state.devices.lanDiscoveryByDeviceId = nextByDeviceId;
    state.devices.lanAnonymousCandidates = nextAnonymous;
    if (state.devices.localDiscoveryHealth === "scanning") state.devices.localDiscoveryHealth = "available";
    if (state.devices.localDiscoveryHealth === "available") {
      state.devices.localDiscoveryNotice = nextSeenIds.size || nextAnonymous.length
        ? "" : "No nearby peers found during this scan. They may be offline or outside the local network.";
    }
  } catch (error) {
    state.devices.localDiscoveryHealth = "unavailable";
    const notice = localDiscoveryUnavailableNotice(error);
    if (notice) {
      const changed = state.devices.localDiscoveryNotice !== notice;
      state.devices.localDiscoveryNotice = notice;
      if (changed) {
        pushSessionLog(state, "warning", "lan_discovery.unavailable", notice);
      }
    } else {
      state.devices.localDiscoveryNotice = "LAN discovery failed on this attempt. You can add a device by ID instead.";
      reportActionError(state, "lan_discovery.failed", error, options);
    }
  } finally {
    state.devices.isDiscoveringLanDevices = false;
  }
};

const copyCurrentDeviceId = async (args: ConnectionActionArgs) => {
  const { state } = args;
  try {
    if (!state.devices.currentDeviceId) {
      await refreshCurrentDeviceId(args);
    }
    await copyText(state.devices.currentDeviceId);
    state.devices.identityNotice = "Device ID copied.";
  } catch (error) {
    reportActionError(state, "device_id.copy.failed", error);
  }
};

const exportedSessionLogs = (args: ConnectionActionArgs) =>
  formatSessionLogs(args.appInfo, args.state.logs.items, {
    startedAtMs: args.state.logs.previousRunStartedAtMs,
    items: args.state.logs.previousRunItems,
  }, {
    journalStarted: args.state.logs.journalStarted,
    historyLoaded: args.state.logs.historyAvailable,
    historyError: args.state.logs.historyError,
  }, args.state.logs.currentNativeItems);

const copySessionLogs = async (args: ConnectionActionArgs) => {
  const { state } = args;
  const text = exportedSessionLogs(args);
  const bytes = sessionLogTextSize(text);
  if (clipboardSessionLogsTooLarge(text)) {
    // Android copies through a shared ~1 MB Binder buffer; a bigger payload can
    // fail or be truncated inside the clipboard service without an error.
    setError(state, "logs.copy.too_large",
      new Error(`Session logs are ${describeSessionLogSize(bytes)}, too large for the clipboard. Use Save logs or Share logs instead.`),
      { bytes, limitBytes: CLIPBOARD_SESSION_LOG_LIMIT_BYTES });
    return;
  }
  try {
    await copyText(text);
  } catch (error) {
    reportActionError(state, "logs.copy.failed", error);
  }
};

const saveSessionLogs = async (args: ConnectionActionArgs) => {
  const { state, logFile } = args;
  if (!logFile) return;
  try {
    const fileName = sessionLogFileName(new Date());
    const saved = await logFile.save(fileName, exportedSessionLogs(args));
    if (saved === null) {
      pushSessionLog(state, "info", "logs.save.cancelled", "Saving session logs was cancelled.");
      return;
    }
    pushSessionLog(state, "info", "logs.saved", `Session logs saved as ${saved}.`, { fileName: saved });
  } catch (error) {
    reportActionError(state, "logs.save.failed", error);
  }
};

const shareSessionLogs = async (args: ConnectionActionArgs) => {
  const { state, logFile } = args;
  if (!logFile) return;
  try {
    const fileName = sessionLogFileName(new Date());
    await logFile.share(fileName, exportedSessionLogs(args));
    pushSessionLog(state, "info", "logs.shared", `Sharing session logs as ${fileName}.`, { fileName });
  } catch (error) {
    reportActionError(state, "logs.share.failed", error);
  }
};

const dispose = (control: ConnectionActionControl) => {
  if (control.connectionSettingsTimer) clearTimeout(control.connectionSettingsTimer);
  control.connectionSettingsTimer = null;
};
