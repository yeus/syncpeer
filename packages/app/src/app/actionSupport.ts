import {
  FOLDER_PASSWORD_SCOPE_SEPARATOR,
  folderPasswordScopedKey,
  formatRate,
  isTransportFailure,
  isValidSyncthingDeviceId,
  normalizeDeviceId,
  normalizeDiscoveryServer,
  normalizePath,
  type SyncpeerBrowserClient,
} from "@syncpeer/core/browser";
import { refreshCachedStatuses } from "./cacheStatusActions.ts";
import {
  activeFolderPasswordScopeDeviceId,
  folderVersionKeyFromState,
  activeSourceDeviceId,
  type AppState,
} from "./state.ts";
import { suggestedClientName } from "./suggestedNames.ts";
import {
  clearDirectoryViewState,
  resetRuntimeSessionState,
} from "./sessionViewPolicies.ts";
import {
  restoreOfflineSnapshot,
  saveOfflineSnapshot,
  saveOfflineDirectorySnapshot,
} from "./syncPolicies.ts";

export const nowTime = () => new Date().toLocaleTimeString();
export const sortByName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((left, right) => left.name.localeCompare(right.name));

export const clearDirectoryView = (state: AppState) => {
  state.session = clearDirectoryViewState(state.session);
};

export const resetRuntimeState = (state: AppState) => {
  state.session = resetRuntimeSessionState(state.session);
};

export const saveCurrentOfflineState = (state: AppState, sourceDeviceId: string) => {
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

export const restoreAfterTransportFailure = (state: AppState, error: unknown) => {
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

export const elapsedMsSince = (startedAtMs: number) => Math.max(1, Date.now() - startedAtMs);

export const averageRateBps = (bytes: number, elapsedMs: number) =>
  bytes > 0 ? (bytes * 1000) / Math.max(1, elapsedMs) : 0;

export const formatRateSafe = (bytesPerSecond: number) => {
  try {
    return formatRate(bytesPerSecond);
  } catch {
    return `${Math.max(0, Math.round(bytesPerSecond))} B/s`;
  }
};

export const splitPath = (value: string) => {
  const normalized = normalizePath(value);
  if (!normalized) return { parent: "", name: "" };
  const parts = normalized.split("/");
  return {
    parent: normalizePath(parts.slice(0, -1).join("/")),
    name: parts[parts.length - 1] ?? "",
  };
};

export const digestBytesHex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
};

export const copyText = async (text: string) => {
  if (!text.trim()) throw new Error("Nothing to copy.");
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API unavailable on this device");
  }
  await navigator.clipboard.writeText(text);
};

export const ensureClientName = (state: AppState) => {
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

export const remoteHasUnapprovedFolderShare = (
  folders: Array<{ localDevicePresentInFolder?: boolean }>,
) => folders.some((folder) => folder.localDevicePresentInFolder === false);

export const migrateActiveLegacyFolderPasswords = (state: AppState) => {
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

export const validateConnection = (state: AppState) => {
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

export const loadDirectorySideEffects = async (
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
