import {
  createSha256DownloadSink,
  DownloadInterruptedError,
  cachedFileKey,
  downloadRemoteFile,
  favoriteKey,
  folderPasswordScopedKey,
  getDefaultDiscoveryServer,
  formatEta,
  formatRate,
  isValidSyncthingDeviceId,
  isTransportFailure,
  normalizeDeviceId,
  normalizeDiscoveryServer,
  normalizePath,
  resolveDirectoryPath,
  sameDeviceId,
  type BreadcrumbSegment,
  type FileEntry,
  type FavoriteRecord,
  type FileDownloadResult,
  type FileDownloadSink,
  type FileEntrySortMode,
} from "@syncpeer/core/browser";
import {
  FOLDER_PASSWORD_SCOPE_SEPARATOR,
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import { reportUiError } from "../lib/tauriAdapters.js";
import {
  formatAppBuildInfo,
  getAppBuildInfo,
} from "../lib/appInfo.ts";
import {
  activeFolderPasswordScopeDeviceId,
  activeFolderPasswords,
  type advertisedDevices,
  advertisedFolders,
  applySessionState,
  cacheFileKeyExists,
  connectionDetails,
  currentSourceDeviceId,
  activeSourceDeviceId,
  downloadProgressText,
  downloadTransportText,
  favoriteEntryKey,
  folderIsLocked,
  folderVersionKeyFromState,
  formatBytes,
  formatModified,
  hasSuccessfulConnectionHistory,
  isSavedDeviceConnected,
  directoryTotalPages,
  persistState,
  pushSessionLog,
  rootFolderEntries,
  shouldHintRemoteApprovalPending,
  type AppState,
} from "./state.ts";
import {
  suggestedClientName,
} from "./suggestedNames.ts";
import { localDiscoveryUnavailableNotice } from "./connectionNotices.ts";
import { remoteFavoriteNeedsDownload } from "./favoriteSyncPolicies.ts";
import {
  clearDirectoryViewState,
  resetRuntimeSessionState,
} from "./sessionViewPolicies.ts";
import { updateCachedKey } from "./downloadPolicies.ts";
import { reportActionError } from "./actionErrors.ts";
import {
  refreshCachedStatuses,
  refreshFolderRootCachedStatuses,
} from "./cacheStatusActions.ts";
import type { TransferRuntime } from "./transferRuntime.ts";
import {
  hasAutoConnectTarget,
  restoreOfflineSnapshot,
  restoreOfflineDirectory,
  saveOfflineDirectorySnapshot,
  saveOfflineSnapshot,
  setRemoteApprovalPending,
} from "./syncPolicies.ts";
import {
  applyAutoApprovals,
  normalizeCandidateAddresses,
  normalizeCandidateDeviceId,
  parseTcpAddress,
  suggestedSavedDeviceName,
  syncConnectedDeviceSavedName,
  upsertSavedDevice,
} from "./devicePolicies.ts";

const nowTime = () => new Date().toLocaleTimeString();
const sortByName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((left, right) => left.name.localeCompare(right.name));

const clearDirectoryView = (state: AppState) => {
  state.session = clearDirectoryViewState(state.session);
};

const resetRuntimeState = (state: AppState) => {
  state.session = resetRuntimeSessionState(state.session);
};

const saveCurrentOfflineState = (state: AppState, sourceDeviceId: string) => {
  saveOfflineSnapshot(state, sourceDeviceId, {
    folders: state.session.folders,
    remoteDevice: state.session.remoteDevice,
    folderSyncStates: state.session.folderSyncStates,
    connectedVia: state.session.connectionPath,
    transportKind: state.session.connectionTransport,
    connectionScope: state.session.connectionScope,
  });
  saveOfflineDirectorySnapshot(state, sourceDeviceId);
};

const restoreAfterTransportFailure = (state: AppState, error: unknown) => {
  if (!isTransportFailure(error)) return;
  const sourceDeviceId = activeSourceDeviceId(state);
  resetRuntimeState(state);
  restoreOfflineSnapshot(
    state,
    clearDirectoryView,
    sourceDeviceId,
    "transport_failed",
  );
};

const elapsedMsSince = (startedAtMs: number) => Math.max(1, Date.now() - startedAtMs);

const averageRateBps = (bytes: number, elapsedMs: number) =>
  bytes > 0 ? (bytes * 1000) / Math.max(1, elapsedMs) : 0;

const formatRateSafe = (bytesPerSecond: number) => {
  try {
    return formatRate(bytesPerSecond);
  } catch {
    return `${Math.max(0, Math.round(bytesPerSecond))} B/s`;
  }
};

const splitPath = (value: string) => {
  const normalized = normalizePath(value);
  if (!normalized) return { parent: "", name: "" };
  const parts = normalized.split("/");
  return {
    parent: normalizePath(parts.slice(0, -1).join("/")),
    name: parts[parts.length - 1] ?? "",
  };
};

const digestBytesHex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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
  if (import.meta.env.SYNCPEER_LAN_E2E === true && currentName === "syncpeer-ui") {
    state.connection.deviceName = "syncpeer-ui-e2e";
    return true;
  }
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

const migrateActiveLegacyFolderPasswords = (state: AppState) => {
  const sourceDeviceId = activeFolderPasswordScopeDeviceId(state);
  const normalizedSource = normalizeDeviceId(sourceDeviceId);
  if (!normalizedSource) return;
  const next = { ...state.passwords.saved };
  let changed = false;
  for (const [storedKey, password] of Object.entries(state.passwords.saved)) {
    if (storedKey.includes(FOLDER_PASSWORD_SCOPE_SEPARATOR)) continue;
    const folderId = storedKey.trim();
    if (!folderId || !password.trim()) continue;
    const scopedKey = folderPasswordScopedKey(normalizedSource, folderId);
    if (!scopedKey) continue;
    if (!next[scopedKey]) {
      next[scopedKey] = password;
    }
    delete next[storedKey];
    changed = true;
  }
  if (changed) {
    state.passwords.saved = next;
  }
};

const validateConnection = (state: AppState) => {
  if (
    (state.connection.discoveryMode === "automatic" ||
      state.connection.discoveryMode === "global" ||
      state.connection.discoveryMode === "lan") &&
    !normalizeDeviceId(state.connection.remoteId) &&
    state.devices.selectedSavedDeviceId
  ) {
    state.connection.remoteId = state.devices.selectedSavedDeviceId;
  }
  if (
    (state.connection.discoveryMode === "global" || state.connection.discoveryMode === "lan") &&
    !normalizeDeviceId(state.connection.remoteId)
  ) {
    throw new Error(
      "Discovery requires a Remote Device ID. Add/select a saved device first.",
    );
  }
  if (
    state.connection.discoveryMode !== "direct" &&
    normalizeDeviceId(state.connection.remoteId) !== "" &&
    !isValidSyncthingDeviceId(state.connection.remoteId)
  ) {
    throw new Error(
      "Remote Device ID looks invalid. Expected 52 or 56 base32 chars (A-Z, 2-7), usually shown as grouped with dashes.",
    );
  }
  if (state.connection.discoveryMode === "automatic" || state.connection.discoveryMode === "global") {
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
  saveOfflineDirectorySnapshot(state, activeSourceDeviceId(state));
};

export const createAppActions = (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
  sessionStore: SyncpeerSessionStore;
  transfers: TransferRuntime;
}) => {
  const { state, client, sessionStore, transfers } = args;
  const appInfo = getAppBuildInfo();
  const {
    begin: beginManagedTransfer,
    update: updateManagedTransfer,
    finish: finishManagedTransfer,
    setDownloadNotice,
    setActiveDownload,
    clearActiveDownload,
    transferInProgress,
    hasActiveDirection,
  } = transfers;
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

  const syncStarredFiles = async () => {
    if (state.sync.isSyncingStarredFiles) return;
    if (!state.ui.isAppVisible) return;
    if (!state.session.isConnected || !state.session.remoteFs) return;
    if (
      state.session.isConnecting ||
      state.session.isRefreshing ||
      state.session.isLoadingDirectory
    ) {
      return;
    }
    const starredFiles = state.favorites.items.filter((item) => item.kind === "file");
    if (starredFiles.length === 0) return;

    state.sync.isSyncingStarredFiles = true;
    const startedAtMs = Date.now();
    let uploaded = 0;
    let downloaded = 0;

    try {
      const remoteFs = state.session.remoteFs;
      const cachedFiles = await client.listCachedFiles();
      const cachedByKey = new Map(cachedFiles.map((item) => [item.key, item]));
      const dirCache = new Map<string, FileEntry[]>();
      const syncController = new AbortController();

      const downloadStarredFile = async (
        folderId: string,
        path: string,
        name: string,
        size: number,
        modifiedMs: number,
        expectedLocalHash?: string,
      ): Promise<string> => {
        const id = `starred-download:${cachedFileKey(folderId, path)}`;
        let outcome: "completed" | "failed" | "cancelled" = "failed";
        let activeSink: FileDownloadSink | null = null;
        await beginManagedTransfer({
          id,
          direction: "download",
          label: name,
          completedBytes: 0,
          totalBytes: size,
          cancellable: true,
        }, () => syncController.abort());
        try {
          const onProgress = (progress: { downloadedBytes: number; totalBytes: number }) =>
            updateManagedTransfer(id, progress.downloadedBytes, progress.totalBytes);
          let localHash: string;
          if (remoteFs.readFileToSink && client.createFileDownloadSink) {
            const nativeSink = await client.createFileDownloadSink({
              folderId,
              path,
              name,
              modifiedMs,
              expectedLocalHash,
            });
            const hashingSink = createSha256DownloadSink(nativeSink);
            activeSink = hashingSink.sink;
            const result = await remoteFs.readFileToSink(
              folderId,
              path,
              hashingSink.sink,
              onProgress,
              syncController.signal,
            );
            localHash = hashingSink.digestHex();
            pushSessionLog(state, "info", "favorites.download.complete", "Favorite download completed", {
              totalBytes: result.totalBytes,
              networkBytes: result.networkBytes,
              reusedBytes: result.reusedBytes,
              resumedBytes: result.resumedBytes,
            });
          } else {
            const bytes = await remoteFs.readFileFully(
              folderId,
              path,
              onProgress,
              syncController.signal,
            );
            await client.cacheFile(folderId, path, name, bytes, modifiedMs);
            localHash = await digestBytesHex(bytes);
          }
          outcome = "completed";
          return localHash;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") outcome = "cancelled";
          if (activeSink && !(error instanceof DownloadInterruptedError)) await activeSink.abort(error);
          throw error;
        } finally {
          await finishManagedTransfer(id, outcome);
        }
      };

      const uploadStarredFile = async (
        folderId: string,
        path: string,
        name: string,
        bytes: Uint8Array,
        modifiedMs: number,
      ) => {
        const id = `starred-upload:${cachedFileKey(folderId, path)}`;
        let outcome: "completed" | "failed" | "cancelled" = "failed";
        await beginManagedTransfer({
          id,
          direction: "upload",
          label: name,
          completedBytes: 0,
          totalBytes: bytes.length,
          cancellable: true,
        }, () => syncController.abort());
        try {
          await remoteFs.writeFileFully(folderId, path, bytes, {
            modifiedMs,
            signal: syncController.signal,
            onProgress: (progress) => updateManagedTransfer(
              id,
              progress.processedBytes,
              progress.totalBytes,
            ),
          });
          // Picker edits can continue while uploading. Acknowledge the sent snapshot
          // without rewriting newer local bytes in the service-owned document.
          const acknowledged = await client.acknowledgeCachedSync?.(folderId, path, {
            hash: await digestBytesHex(bytes), sizeBytes: bytes.length, modifiedMs,
          });
          if (!acknowledged) await client.cacheFile(folderId, path, name, bytes, modifiedMs);
          outcome = "completed";
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") outcome = "cancelled";
          throw error;
        } finally {
          await finishManagedTransfer(id, outcome);
        }
      };

      for (const favorite of starredFiles) {
        if (syncController.signal.aborted) break;
        const targetPath = normalizePath(favorite.path);
        if (!targetPath) continue;
        const { parent, name } = splitPath(targetPath);
        if (!name) continue;
        const dirKey = `${favorite.folderId}::${parent}`;
        if (!dirCache.has(dirKey)) {
          dirCache.set(dirKey, await remoteFs.readDir(favorite.folderId, parent));
        }
        const remoteEntry = dirCache
          .get(dirKey)
          ?.find((entry) => entry.type === "file" && normalizePath(entry.path) === targetPath);
        if (!remoteEntry) continue;

        const key = cachedFileKey(favorite.folderId, targetPath);
        const cached = cachedByKey.get(key);

        if (!cached) {
          const localHash = await downloadStarredFile(
            favorite.folderId,
            targetPath,
            favorite.name,
            remoteEntry.size,
            remoteEntry.modifiedMs || Date.now(),
          );
          state.sync.starredFileSyncState[key] = {
            lastLocalHash: localHash,
            lastRemoteModifiedMs: remoteEntry.modifiedMs || Date.now(),
            lastRemoteSizeBytes: remoteEntry.size,
            lastSyncAtMs: Date.now(),
            lastDirection: "download",
          };
          downloaded += 1;
          continue;
        }

        const remoteModifiedMs = remoteEntry.modifiedMs || 0;
        const previous = state.sync.starredFileSyncState[key] ?? (cached.syncBaseline ? {
          lastLocalHash: cached.syncBaseline.hash,
          lastRemoteModifiedMs: cached.syncBaseline.modifiedMs,
          lastRemoteSizeBytes: cached.syncBaseline.sizeBytes,
          lastSyncAtMs: cached.cachedAtMs,
          lastDirection: "baseline" as const,
        } : undefined);
        if (cached.syncBaselineRequired && !previous) {
          throw new Error("This local document has no verified remote baseline. Upload or download it explicitly before enabling automatic updates.");
        }
        let localBytes: Uint8Array | null = null;
        if (cached.localPath) {
          try { localBytes = await client.readBinaryFile(cached.localPath); }
          catch { localBytes = null; }
        }
        const localHash = localBytes ? await digestBytesHex(localBytes) : previous?.lastLocalHash ?? "";
        const localChanged = Boolean(localBytes && previous) && localHash !== previous!.lastLocalHash;
        const remoteChanged = remoteFavoriteNeedsDownload(
          { sizeBytes: remoteEntry.size, modifiedMs: remoteModifiedMs },
          previous,
          cached,
        );
        if (remoteChanged) {
          if (cached.syncBaseline && (!localBytes || localChanged)) {
            throw new Error("Both the document and remote file may have changed. Local edits were preserved; resolve the conflict before downloading a replacement.");
          }
          const localHash = await downloadStarredFile(
            favorite.folderId,
            targetPath,
            favorite.name,
            remoteEntry.size,
            remoteModifiedMs || Date.now(),
            cached.syncBaselineRequired ? previous?.lastLocalHash : undefined,
          );
          state.sync.starredFileSyncState[key] = {
            lastLocalHash: localHash,
            lastRemoteModifiedMs: remoteModifiedMs || Date.now(),
            lastRemoteSizeBytes: remoteEntry.size,
            lastSyncAtMs: Date.now(),
            lastDirection: "download",
          };
          downloaded += 1;
          continue;
        }

        if (!previous) {
          const baselineHash = localBytes ? await digestBytesHex(localBytes) : "";
          state.sync.starredFileSyncState[key] = {
            lastLocalHash: baselineHash,
            lastRemoteModifiedMs: remoteModifiedMs,
            lastRemoteSizeBytes: remoteEntry.size,
            lastSyncAtMs: Date.now(),
            lastDirection: "baseline",
          };
          continue;
        }

        if (localChanged && localBytes) {
          const uploadModifiedMs = Date.now();
          await uploadStarredFile(
            favorite.folderId,
            targetPath,
            favorite.name,
            localBytes,
            uploadModifiedMs,
          );
          state.sync.starredFileSyncState[key] = {
            lastLocalHash: localHash,
            lastRemoteModifiedMs: uploadModifiedMs,
            lastRemoteSizeBytes: localBytes.length,
            lastSyncAtMs: Date.now(),
            lastDirection: "upload",
          };
          uploaded += 1;
          continue;
        }

        state.sync.starredFileSyncState[key] = {
          ...previous,
          lastLocalHash: localHash,
          lastRemoteModifiedMs: remoteModifiedMs,
          lastRemoteSizeBytes: remoteEntry.size,
          lastSyncAtMs: previous.lastSyncAtMs,
        };
      }

      if (uploaded > 0 || downloaded > 0) {
        pushSessionLog(
          state,
          "info",
          "starred.sync.complete",
          `Starred sync finished: uploaded=${uploaded}, downloaded=${downloaded}.`,
          {
            uploaded,
            downloaded,
            durationMs: elapsedMsSince(startedAtMs),
            fileCount: starredFiles.length,
          },
        );
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        reportActionError(state, "starred.sync.failed", error, {
          durationMs: elapsedMsSince(startedAtMs),
        });
      }
    } finally {
      state.sync.isSyncingStarredFiles = false;
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

  const openFolderRoot = async (folderId: string) => {
    if (folderIsLocked(state, folderId)) return;
    state.ui.uploadMessage = "";
    state.activeTab = "folders";
    if (!state.session.isConnected || !state.session.remoteFs) {
      if (!restoreOfflineDirectory(state, folderId, "")) {
        state.ui.recentError = "This folder has not been browsed on this device yet.";
      }
      return;
    }
    try {
      await sessionStore.actions.openFolder(folderId, connectionDetails(state));
      applySessionState(state, sessionStore.getState());
      await loadDirectorySideEffects(state, client);
    } catch (error) {
      reportActionError(state, "folder.open_root.failed", error, { folderId });
      restoreAfterTransportFailure(state, error);
    }
  };

  const openDirectory = async (path: string) => {
    if (!state.session.currentFolderId) return;
    state.ui.uploadMessage = "";
    const nextPath = resolveDirectoryPath(state.session.currentPath, path);
    if (!state.session.isConnected || !state.session.remoteFs) {
      if (!restoreOfflineDirectory(state, state.session.currentFolderId, nextPath)) {
        state.ui.recentError = "This directory has not been browsed on this device yet.";
      }
      return;
    }
    try {
      await sessionStore.actions.openPath(nextPath, connectionDetails(state));
      applySessionState(state, sessionStore.getState());
      await loadDirectorySideEffects(state, client);
    } catch (error) {
      reportActionError(state, "folder.open_path.failed", error, { path: nextPath });
      restoreAfterTransportFailure(state, error);
    }
  };

  const goToBreadcrumb = async (segment: BreadcrumbSegment) => {
    if (segment.ellipsis) return;
    state.ui.uploadMessage = "";
    if (!state.session.isConnected || !state.session.remoteFs) {
      if (!restoreOfflineDirectory(state, segment.targetFolderId, segment.targetPath)) {
        state.ui.recentError = "This directory has not been browsed on this device yet.";
      }
      return;
    }
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
      restoreAfterTransportFailure(state, error);
    }
  };

  const goToRootView = async () => {
    state.ui.uploadMessage = "";
    if (!state.session.isConnected || !state.session.remoteFs) {
      clearDirectoryView(state);
      return;
    }
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

  const setDirectorySortMode = (sortMode: FileEntrySortMode) => {
    state.ui.directorySortMode = sortMode;
    state.session.directoryPage = 1;
  };

  const setDirectoryNameFilter = (nameFilter: string) => {
    state.ui.directoryNameFilter = nameFilter;
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

  const openFavorite = async (favorite: Pick<FavoriteRecord, "folderId" | "path" | "kind">) => {
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

  const downloadFile = async (
    folderId: string,
    path: string,
    name: string,
    options?: { openAfterDownload?: boolean },
  ) => {
    const downloadKey = cachedFileKey(folderId, path);
    if (state.favorites.activeDownloads[downloadKey]) return;
    const connected = await ensureConnectedForTransfer("download");
    if (!connected || !state.session.remoteFs) return;
    state.favorites.isDownloading = true;
    const startedAt = Date.now();
    let lastTransferLogAtMs = 0;
    let activeTransportKind = state.session.connectionTransport;
    let activeConnectedVia = state.session.connectionPath;
    let activeConnectionScope = state.session.connectionScope;
    let activeSink: FileDownloadSink | null = null;
    let downloadedHash: string;
    let transferOutcome: "completed" | "failed" | "cancelled" = "failed";
    const abortController = new AbortController();
    const cancelTransfer = () => {
      abortController.abort();
      setDownloadNotice(`Cancelling download ${name}…`);
    };
    const transferId = `download:${downloadKey}`;
    const remoteFs = state.session.remoteFs;
    const initialProgressText = `0% • 0 B/s • ETA -- • ${downloadTransportText(
      state.session.connectionTransport,
      state.session.connectionScope,
    )}`;
    setActiveDownload(downloadKey, {
      name,
      text: initialProgressText,
      progressPercent: 0,
    });
    pushSessionLog(state, "info", "download.start", `Downloading ${name}`, {
      folderId,
      path,
      fileName: name,
    });
    try {
      await beginManagedTransfer({
        id: transferId,
        direction: "download",
        label: name,
        completedBytes: 0,
        totalBytes: 0,
        cancellable: true,
      }, cancelTransfer);
      const onProgress = ({
        downloadedBytes,
        totalBytes,
        transportKind,
        connectedVia,
        connectionScope,
        networkBytes,
        reusedBytes,
        resumedBytes,
      }: {
        downloadedBytes: number;
        totalBytes: number;
        networkBytes?: number;
        reusedBytes?: number;
        resumedBytes?: number;
        transportKind?: "direct-tcp" | "direct-quic" | "relay";
        connectedVia?: string;
        connectionScope?: "lan" | "wan" | "unknown";
      }) => {
        activeTransportKind = transportKind ?? activeTransportKind;
        activeConnectedVia = connectedVia ?? activeConnectedVia;
        activeConnectionScope = connectionScope ?? activeConnectionScope;
        const elapsedMs = elapsedMsSince(startedAt);
        const rateBps = averageRateBps(networkBytes ?? downloadedBytes, elapsedMs);
        const progressText = downloadProgressText(
          downloadedBytes,
          totalBytes,
          elapsedMs / 1000,
        ) + ` • ${downloadTransportText(
          transportKind ?? state.session.connectionTransport,
          connectionScope ?? state.session.connectionScope,
        )}`;
        const progressPercent =
          totalBytes > 0
            ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))
            : 0;
        setActiveDownload(downloadKey, {
          name,
          text: progressText,
          progressPercent,
        });
        updateManagedTransfer(transferId, downloadedBytes, totalBytes);
        const now = Date.now();
        if (now - lastTransferLogAtMs >= 2000 || downloadedBytes >= totalBytes) {
          lastTransferLogAtMs = now;
          pushSessionLog(state, "info", "download.progress", `Downloading ${name}`, {
            folderId,
            path,
            downloadedBytes,
            networkBytes,
            reusedBytes,
            resumedBytes,
            totalBytes,
            elapsedMs,
            rateBps: Math.round(rateBps),
            rate: formatRateSafe(rateBps),
            transportKind: transportKind ?? state.session.connectionTransport,
            connectedVia,
            connectionScope: connectionScope ?? state.session.connectionScope,
          });
        }
      };
      let downloadResult: FileDownloadResult;
      const remoteEntry = state.session.entries.find(
        (entry) => entry.type === "file" && normalizePath(entry.path) === normalizePath(path),
      );
      const remoteModifiedMs = remoteEntry?.modifiedMs || Date.now();
      if (remoteFs.readFileToSink && client.createFileDownloadSink) {
        const sink = await client.createFileDownloadSink({
          folderId,
          path,
          name,
          modifiedMs: remoteModifiedMs,
        });
        const hashingSink = createSha256DownloadSink(sink);
        activeSink = hashingSink.sink;
        downloadResult = await remoteFs.readFileToSink(
          folderId,
          path,
          hashingSink.sink,
          onProgress,
          abortController.signal,
        );
        downloadedHash = hashingSink.digestHex();
      } else {
        const bytes = await downloadRemoteFile(remoteFs, {
          folderId,
          path,
          onProgress,
          signal: abortController.signal,
        });
        await client.cacheFile(folderId, path, name, bytes, remoteModifiedMs);
        downloadedHash = await digestBytesHex(bytes);
        downloadResult = { bytesWritten: bytes.length, totalBytes: bytes.length };
      }
      const elapsedMs = elapsedMsSince(startedAt);
      const rateBps = averageRateBps(downloadResult.bytesWritten, elapsedMs);
      updateCachedKey(state, folderId, path, true);
      state.sync.starredFileSyncState[downloadKey] = {
        lastLocalHash: downloadedHash,
        lastRemoteModifiedMs: remoteModifiedMs,
        lastRemoteSizeBytes: downloadResult.totalBytes,
        lastSyncAtMs: Date.now(),
        lastDirection: "download",
      };
      await refreshFolderRootCachedStatuses(state, client, [folderId]);
      const doneProgressText =
        `100% • Done • ${downloadTransportText(activeTransportKind, activeConnectionScope)}`;
      setActiveDownload(downloadKey, {
        name,
        text: doneProgressText,
        progressPercent: 100,
      });
      transferOutcome = "completed";
      setDownloadNotice(
        `Downloaded ${name} via ${downloadTransportText(activeTransportKind, activeConnectionScope)}` +
        ((downloadResult.reusedBytes ?? 0) + (downloadResult.resumedBytes ?? 0) > 0
          ? ` · ${Math.round(((downloadResult.reusedBytes ?? 0) + (downloadResult.resumedBytes ?? 0)) / Math.max(1, downloadResult.totalBytes) * 100)}% recovered locally`
          : ""),
        4000,
      );
      pushSessionLog(state, "info", "download.complete", `Downloaded ${name}`, {
        folderId,
        path,
        sizeBytes: downloadResult.bytesWritten,
        networkBytes: downloadResult.networkBytes,
        reusedBytes: downloadResult.reusedBytes,
        resumedBytes: downloadResult.resumedBytes,
        elapsedMs,
        rateBps: Math.round(rateBps),
        rate: formatRateSafe(rateBps),
        transportKind: activeTransportKind,
        connectedVia: activeConnectedVia,
        connectionScope: activeConnectionScope,
      });
      if (options?.openAfterDownload) {
        await openCachedFile(folderId, path);
      }
    } catch (error) {
      if (activeSink && !(error instanceof DownloadInterruptedError)) {
        try {
          await activeSink.abort(error);
        } catch (abortError) {
          reportActionError(state, "download_file.abort_failed", abortError, { folderId, path });
        }
      }
      if (error instanceof Error && error.name === "AbortError") {
        transferOutcome = "cancelled";
        setDownloadNotice(`Download cancelled: ${name}`, 4000);
      } else {
        reportActionError(state, "download_file.failed", error, { folderId, path });
        restoreAfterTransportFailure(state, error);
        setDownloadNotice(`Download failed: ${name}`, 6000);
      }
    } finally {
      await finishManagedTransfer(transferId, transferOutcome);
      clearActiveDownload(downloadKey);
    }
  };

  const openOrDownloadFile = async (folderId: string, path: string, name: string) => {
    if (cacheFileKeyExists(state, folderId, path)) {
      await openCachedFile(folderId, path);
      return;
    }
    await downloadFile(folderId, path, name, { openAfterDownload: true });
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
    migrateActiveLegacyFolderPasswords(state);
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
    migrateActiveLegacyFolderPasswords(state);
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
    state.connection.discoveryMode = "automatic";
    state.connection.host = "";
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
    state.connection.discoveryMode = "automatic";
    state.connection.host = "";
    if (!state.session.isConnected) {
      restoreOfflineSnapshot(state, clearDirectoryView, deviceId, "use_saved_device");
      return;
    }
    void refreshActiveView();
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
    state.connection.discoveryMode = "automatic";
    state.connection.host = "";
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
    void refreshActiveView();
  };

  const uploadPreparedFile = async (
    fileName: string,
    bytes: Uint8Array,
    modifiedMs?: number,
    managed?: { id: string; controller: AbortController },
  ) => {
    const connected = await ensureConnectedForTransfer("upload");
    if (!connected || !state.session.remoteFs) {
      state.ui.uploadMessage = "Connect to a folder before uploading.";
      if (managed) await finishManagedTransfer(managed.id, "failed");
      return;
    }
    const remoteFs = state.session.remoteFs;
    if (!state.session.currentFolderId) {
      state.ui.uploadMessage = "Open a folder first, then upload into the current directory.";
      if (managed) await finishManagedTransfer(managed.id, "failed");
      return;
    }
    const relativePath = normalizePath(
      [state.session.currentPath, fileName].filter(Boolean).join("/"),
    );
    if (!relativePath) {
      state.ui.uploadMessage = "Invalid upload target path.";
      if (managed) await finishManagedTransfer(managed.id, "failed");
      return;
    }
    state.ui.uploadProgressActive = true;
    state.ui.uploadProgressPercent = 0;
    state.ui.uploadProgressEta = "";
    state.ui.uploadProgressRate = "";
    state.ui.uploadMessage = `Uploading ${fileName}...`;
    const startedAtMs = Date.now();
    let lastTransferLogAtMs = 0;
    const controller = managed?.controller ?? new AbortController();
    const transferId = managed?.id ?? `upload:${relativePath}:${startedAtMs}`;
    let transferOutcome: "completed" | "failed" | "cancelled" = "failed";
    if (!managed) {
      await beginManagedTransfer({
        id: transferId,
        direction: "upload",
        label: fileName,
        completedBytes: 0,
        totalBytes: bytes.length,
        cancellable: true,
      }, () => controller.abort());
    }
    pushSessionLog(state, "info", "upload.start", `Uploading ${fileName}`, {
      folderId: state.session.currentFolderId,
      path: relativePath,
      fileName,
      sizeBytes: bytes.length,
    });
    const updateUploadProgress = (processedBytes: number, totalBytes: number) => {
      const elapsedMs = elapsedMsSince(startedAtMs);
      const safeTotal = Math.max(1, totalBytes);
      const pct = Math.min(100, Math.floor((processedBytes / safeTotal) * 100));
      const rateBps = averageRateBps(processedBytes, elapsedMs);
      const remainingBytes = Math.max(0, totalBytes - processedBytes);
      const etaSeconds = rateBps > 0 ? remainingBytes / rateBps : 0;
      state.ui.uploadProgressPercent = pct;
      state.ui.uploadProgressRate = rateBps > 0 ? formatRateSafe(rateBps) : "";
      state.ui.uploadProgressEta = etaSeconds > 0 ? formatEta(etaSeconds) : "";
      const now = Date.now();
      if (now - lastTransferLogAtMs >= 2000 || pct === 100) {
        lastTransferLogAtMs = now;
        pushSessionLog(state, "info", "upload.progress", `Uploading ${fileName}`, {
          folderId: state.session.currentFolderId,
          path: relativePath,
          processedBytes,
          totalBytes,
          percent: pct,
          elapsedMs,
          rateBps: Math.round(rateBps),
          rate: formatRateSafe(rateBps),
          etaSeconds: Math.max(0, Math.round(etaSeconds)),
        });
      }
      const uploadNotice = `Upload ${pct}%${state.ui.uploadProgressEta ? ` · ETA ${state.ui.uploadProgressEta}` : ""}`;
      setDownloadNotice(uploadNotice);
      updateManagedTransfer(transferId, processedBytes, totalBytes);
    };
    try {
      await remoteFs.writeFileFully(
        state.session.currentFolderId,
        relativePath,
        bytes,
        {
          modifiedMs: modifiedMs || Date.now(),
          signal: controller.signal,
          onProgress: (progress) => {
            updateUploadProgress(progress.processedBytes, progress.totalBytes);
          },
        },
      );
      updateUploadProgress(bytes.length, bytes.length);
      await sessionStore.actions.reloadCurrentDirectory(connectionDetails(state));
      applySessionState(state, sessionStore.getState());
      await loadDirectorySideEffects(state, client);
      state.ui.uploadMessage = `Uploaded ${fileName}.`;
      setDownloadNotice(`Uploaded ${fileName}`, 4000);
      transferOutcome = "completed";
      const elapsedMs = elapsedMsSince(startedAtMs);
      const rateBps = averageRateBps(bytes.length, elapsedMs);
      pushSessionLog(state, "info", "upload.complete", `Uploaded ${fileName}`, {
        folderId: state.session.currentFolderId,
        path: relativePath,
        sizeBytes: bytes.length,
        elapsedMs,
        rateBps: Math.round(rateBps),
        rate: formatRateSafe(rateBps),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        transferOutcome = "cancelled";
        state.ui.uploadMessage = `Upload cancelled: ${fileName}`;
        setDownloadNotice(`Upload cancelled: ${fileName}`, 4000);
        return;
      }
      reportActionError(state, "upload_file.failed", error, {
        folderId: state.session.currentFolderId,
        path: relativePath,
        fileName,
        sizeBytes: bytes.length,
      });
      setDownloadNotice(`Upload failed: ${fileName}`, 6000);
    } finally {
      await finishManagedTransfer(transferId, transferOutcome);
      if (!hasActiveDirection("upload")) {
        state.ui.uploadProgressActive = false;
        state.ui.uploadProgressPercent = 0;
        state.ui.uploadProgressEta = "";
        state.ui.uploadProgressRate = "";
      }
    }
  };

  const handleUploadSelected = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) {
      state.ui.uploadMessage = "";
      input.value = "";
      return;
    }
    void (async () => {
      const batchId = Date.now();
      const prepared = files.map((file, index) => ({
        file,
        id: `upload:${batchId}:${index}`,
      }));
      const controller = new AbortController();
      for (const item of prepared) {
        await beginManagedTransfer({
          id: item.id,
          direction: "upload",
          label: item.file.name,
          completedBytes: 0,
          totalBytes: item.file.size,
          cancellable: true,
        }, () => controller.abort());
      }
      for (const item of prepared) {
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await item.file.arrayBuffer());
        } catch (error) {
          reportActionError(state, "upload_file.read_failed", error, {
            fileName: item.file.name,
            sizeBytes: item.file.size,
          });
          await finishManagedTransfer(item.id, "failed");
          continue;
        }
        await uploadPreparedFile(
          item.file.name,
          bytes,
          item.file.lastModified || Date.now(),
          { id: item.id, controller },
        );
      }
    })();
    input.value = "";
  };

  const handleUploadClick = () => {
    document.getElementById("folder-upload-input")?.click();
  };

  const setAutoConnectPaused = (paused: boolean) => {
    state.ui.autoConnectPaused = paused;
  };

  const setAppVisibility = (isVisible: boolean) => {
    state.ui.isAppVisible = isVisible;
    void sessionStore.actions.setForeground(isVisible);
  };

  const onNetworkOnline = async () => {
    await sessionStore.actions.setOnline(true);
    if (state.ui.autoConnectPaused) return;
    await discoverLocalDevices({ timeoutMs: 1200 });
    if (!hasAutoConnectTarget(state)) return;
    if (state.session.isConnected || state.session.isConnecting) return;
    await connect();
  };

  const onAppForeground = async () => {
    if (state.ui.autoConnectPaused) return;
    await discoverLocalDevices({ timeoutMs: 1200 });
    if (!hasAutoConnectTarget(state)) return;
    if (state.session.isConnected || state.session.isConnecting) return;
    await connect();
  };

  const openDiagnosticsPage = () => {
    state.currentPage = "diagnostics";
  };

  const closeDiagnosticsPage = () => {
    state.currentPage = "main";
  };

  const openAboutPage = () => {
    state.currentPage = "about";
  };

  const closeAboutPage = () => {
    state.currentPage = "main";
  };

  return {
    hydrate,
    connect,
    disconnect,
    scheduleConnectionSettingsApply,
    refreshOverview,
    refreshActiveView,
    refreshCurrentDeviceId,
    discoverLocalDevices,
    connectViaLanAnonymousCandidate,
    copyCurrentDeviceId,
    copySessionLogs,
    openFolderRoot,
    openDirectory,
    goToBreadcrumb,
    goToRootView,
    setDirectoryPage,
    setDirectoryPageSize,
    setDirectorySortMode,
    setDirectoryNameFilter,
    toggleFavorite,
    removeFavorite,
    openFavorite,
    openDownloadedFilesPanel,
    clearAllCache,
    removeCachedFile,
    openCachedFile,
    openCachedFileDirectory,
    openCachedDirectory,
    openOrDownloadFile,
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
    handleUploadClick,
    handleUploadSelected,
    setAutoConnectPaused,
    setAppVisibility,
    onNetworkOnline,
    onAppForeground,
    openDiagnosticsPage,
    closeDiagnosticsPage,
    openAboutPage,
    closeAboutPage,
    persist: () => persistState(state),
    restoreOfflineSnapshot: (deviceId?: string, reason?: string) =>
      restoreOfflineSnapshot(state, clearDirectoryView, deviceId, reason),
    dispose: () => {
      if (connectionSettingsTimer) clearTimeout(connectionSettingsTimer);
      connectionSettingsTimer = null;
    },
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
