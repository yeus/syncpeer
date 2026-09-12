import {
  FOLDER_PASSWORD_SCOPE_SEPARATOR,
  folderPasswordScopedKey,
  getDefaultDiscoveryServer,
  isValidSyncthingDeviceId,
  normalizeDeviceId,
  sameDeviceId,
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import { reportActionError } from "./actionErrors.ts";
import {
  activeFolderPasswordScopeDeviceId,
  activeFolderPasswords,
  type advertisedDevices,
  type advertisedFolders,
  applySessionState,
  connectionDetails,
  folderIsLocked,
  pushSessionLog,
  type AppState,
} from "./state.ts";
import {
  clearDirectoryView,
  copyText,
  loadDirectorySideEffects,
} from "./actionSupport.ts";
import { restoreOfflineSnapshot, setRemoteApprovalPending } from "./syncPolicies.ts";
import { suggestedClientName } from "./suggestedNames.ts";
import { suggestedSavedDeviceName, upsertSavedDevice } from "./devicePolicies.ts";

export const createDeviceActions = (args: {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly refreshOverview: () => Promise<void>;
  readonly refreshActiveView: () => Promise<void>;
  readonly refreshCurrentDeviceId: () => Promise<void>;
  readonly savePasswords?: (values: Record<string, string>) => Promise<void>;
}) => {
  const {
    state,
    client,
    sessionStore,
    refreshOverview,
    refreshActiveView,
    refreshCurrentDeviceId,
  } = args;

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

const changeFolderPassword = async (folderId: string, password: string) => {
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
  try {
    await args.savePasswords?.(next);
    state.passwords.saved = next;
    if (!password) state.passwords.drafts = { ...state.passwords.drafts, [folderId]: "" };
    setFolderPasswordInputVisible(folderId, !password);
    await sessionStore.actions.setFolderPasswords(activeFolderPasswords(state));
    if (state.session.isConnected) {
      await refreshOverview();
      if (password && !folderIsLocked(state, folderId) && state.session.currentFolderId === folderId) {
        await sessionStore.actions.reloadCurrentDirectory(connectionDetails(state));
        applySessionState(state, sessionStore.getState());
        await loadDirectorySideEffects(state, client);
      }
    }
  } catch (error) {
    reportActionError(state, "folder_password.save.failed", error, { folderId });
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


  return {
    updateFolderPasswordDraft,
    setFolderPasswordInputVisible,
    saveFolderPassword: (folderId: string) => changeFolderPassword(folderId, (state.passwords.drafts[folderId] ?? "").trim()),
    clearFolderPassword: (folderId: string) => changeFolderPassword(folderId, ""),
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
  };
};
