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

type DeviceActionArgs = {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly refreshOverview: () => Promise<void>;
  readonly refreshActiveView: () => Promise<void>;
  readonly refreshCurrentDeviceId: () => Promise<void>;
  readonly savePasswords?: (values: Record<string, string>) => Promise<void>;
};

class DeviceActionsRuntime {
  constructor(
    private readonly state: AppState,
    private readonly client: SyncpeerBrowserClient,
    private readonly sessionStore: SyncpeerSessionStore,
    private readonly refreshOverview: () => Promise<void>,
    private readonly refreshActiveView: () => Promise<void>,
    private readonly refreshCurrentDeviceId: () => Promise<void>,
    private readonly savePasswords?: (values: Record<string, string>) => Promise<void>,
  ) {}

  private updateFolderPasswordDraft = (folderId: string, password: string) => {
    this.state.passwords.drafts = {
      ...this.state.passwords.drafts,
      [folderId]: password,
    };
  };

  private changeFolderPassword = async (folderId: string, password: string) => {
    const scopedKey = folderPasswordScopedKey(
      activeFolderPasswordScopeDeviceId(this.state),
      folderId,
    );
    const next = { ...this.state.passwords.saved };
    delete next[folderId];
    if (scopedKey) delete next[scopedKey];
    if (password) {
      next[scopedKey || folderId] = password;
    }
    try {
      await this.savePasswords?.(next);
      this.state.passwords.saved = next;
      if (!password) this.state.passwords.drafts = { ...this.state.passwords.drafts, [folderId]: "" };
      await this.sessionStore.actions.setFolderPasswords(activeFolderPasswords(this.state));
      if (this.state.session.isConnected) {
        await this.refreshOverview();
        if (password && !folderIsLocked(this.state, folderId) && this.state.session.currentFolderId === folderId) {
          await this.sessionStore.actions.reloadCurrentDirectory(connectionDetails(this.state));
          applySessionState(this.state, this.sessionStore.getState());
          await loadDirectorySideEffects(this.state, this.client);
        }
      }
    } catch (error) {
      reportActionError(this.state, "folder_password.save.failed", error, { folderId });
    }
  };

  private addSavedDevice = () => {
    const normalized = normalizeDeviceId(this.state.devices.newSavedDeviceId);
    if (!normalized) {
      this.state.ui.recentError = "Device ID is required.";
      return;
    }
    if (!isValidSyncthingDeviceId(normalized)) {
      this.state.ui.recentError =
        "Device ID looks invalid. Expected 52 or 56 base32 chars (A-Z, 2-7), usually shown as grouped with dashes.";
      return;
    }
    const customName = this.state.devices.newSavedDeviceCustomName.trim();
    upsertSavedDevice(this.state, normalized, customName || suggestedSavedDeviceName(this.state, normalized), {
      customName: customName !== "",
      isIntroducer: this.state.devices.newSavedDeviceIsIntroducer,
    });
    this.state.devices.selectedSavedDeviceId = normalized;
    this.state.connection.remoteId = normalized;
    this.state.connection.discoveryMode = "automatic";
    this.state.connection.host = "";
    this.state.devices.newSavedDeviceId = "";
    this.state.devices.newSavedDeviceCustomName = "";
    this.state.devices.newSavedDeviceIsIntroducer = false;
    this.state.ui.recentError = null;
  };

  private editSavedDeviceName = (deviceId: string) => {
    const normalized = normalizeDeviceId(deviceId);
    if (!normalized) return;
    const initial = suggestedSavedDeviceName(this.state, normalized);
    const updated =
      typeof window !== "undefined"
        ? window.prompt("Edit device name:", initial)
        : initial;
    if (updated === null) return;
    if (!updated.trim()) {
      this.state.ui.recentError = "Device name cannot be empty.";
      return;
    }
    upsertSavedDevice(this.state, normalized, updated.trim(), { customName: true });
    this.state.ui.recentError = null;
  };

  private useSavedDevice = (deviceId: string) => {
    this.state.devices.selectedSavedDeviceId = deviceId;
    this.state.connection.remoteId = deviceId;
    this.state.connection.discoveryMode = "automatic";
    this.state.connection.host = "";
    if (!this.state.session.isConnected) {
      restoreOfflineSnapshot(this.state, clearDirectoryView, deviceId, "use_saved_device");
      return;
    }
    void this.refreshActiveView();
  };

  private setSavedDeviceIntroducer = (deviceId: string, isIntroducer: boolean) => {
    upsertSavedDevice(this.state, deviceId, suggestedSavedDeviceName(this.state, deviceId), {
      customName:
        this.state.devices.savedDevices.find((item) => sameDeviceId(item.id, deviceId))
          ?.customName ?? false,
      isIntroducer,
    });
  };

  private removeSavedDevice = (deviceId: string) => {
    const normalized = normalizeDeviceId(deviceId);
    setRemoteApprovalPending(this.state, normalized, false);
    if (sameDeviceId(this.state.approvals.pendingApprovalPromptDeviceId, normalized)) {
      this.state.approvals.pendingApprovalPromptDeviceId = "";
    }
    this.state.devices.savedDevices = this.state.devices.savedDevices.filter(
      (item) => !sameDeviceId(item.id, normalized),
    );
    if (sameDeviceId(this.state.connection.remoteId, normalized)) {
      this.state.connection.remoteId = "";
    }
    this.state.approvals.syncApprovedFolderKeys = new Set(
      [...this.state.approvals.syncApprovedFolderKeys].filter(
        (key) => !key.startsWith(`${normalized}:`),
      ),
    );
    const scopedPrefix = `${normalized}${FOLDER_PASSWORD_SCOPE_SEPARATOR}`;
    this.state.passwords.saved = Object.fromEntries(
      Object.entries(this.state.passwords.saved).filter(
        ([key]) => !key.startsWith(scopedPrefix),
      ),
    );
    this.state.offline.snapshots = Object.fromEntries(
      Object.entries(this.state.offline.snapshots).filter(
        ([key]) => !sameDeviceId(key, normalized),
      ),
    );
  };

  private approveAdvertisedDevice = (device: ReturnType<typeof advertisedDevices>[number]) => {
    if (!isValidSyncthingDeviceId(device.id)) {
      this.state.ui.recentError = `Advertised device ID is invalid and cannot be approved: ${device.id}`;
      return;
    }
    upsertSavedDevice(this.state, device.id, device.name, { customName: false });
    this.state.devices.selectedSavedDeviceId = device.id;
    this.state.connection.remoteId = device.id;
    this.state.connection.discoveryMode = "automatic";
    this.state.connection.host = "";
    this.state.ui.recentError = null;
  };

  private approveFolderSync = (folder: ReturnType<typeof advertisedFolders>[number]) => {
    const next = new Set(this.state.approvals.syncApprovedFolderKeys);
    next.add(folder.key);
    this.state.approvals.syncApprovedFolderKeys = next;
    this.state.ui.recentError = null;
  };

  private resetDiscoveryServer = () => {
    this.state.connection.discoveryServer = getDefaultDiscoveryServer();
  };

  private clearOfflineFolderState = () => {
    this.state.offline.snapshots = {};
    if (!this.state.session.isConnected) {
      this.state.session.folders = [];
      this.state.session.folderSyncStates = [];
      this.state.session.remoteDevice = null;
      this.state.session.connectionPath = "";
      this.state.session.connectionTransport = "";
      clearDirectoryView(this.state);
    }
    pushSessionLog(
      this.state,
      "info",
      "offline.snapshot.cleared",
      "Cleared all persisted offline folder snapshots.",
    );
  };

  private regenerateDeviceId = async () => {
    if (this.state.devices.isRegeneratingDeviceId) return;
    const confirmed =
      typeof window !== "undefined"
        ? window.confirm(
            "Generate a new device ID now? Other peers will treat this as a new device until approved again.",
          )
        : true;
    if (!confirmed) return;
    this.state.devices.isRegeneratingDeviceId = true;
    try {
      this.state.devices.currentDeviceId = await this.client.regenerateDefaultIdentity();
      this.state.devices.identityNotice = "New device ID generated.";
      this.state.devices.identityRecoverySecret = "";
      this.state.ui.showRestoreFromBackup = false;
    } catch (error) {
      reportActionError(this.state, "device_id.regenerate.failed", error);
    } finally {
      this.state.devices.isRegeneratingDeviceId = false;
    }
  };

  private editLocalDeviceName = () => {
    const initial = this.state.connection.deviceName.trim() || suggestedClientName();
    const updated =
      typeof window !== "undefined"
        ? window.prompt("Edit this device name (advertised to peers):", initial)
        : initial;
    if (updated === null) return;
    if (!updated.trim()) {
      this.state.ui.recentError = "Device name is required.";
      return;
    }
    this.state.connection.deviceName = updated.trim();
    this.state.devices.identityNotice = "Advertised device name updated.";
    this.state.ui.recentError = null;
  };

  private copyIdentityBackupSecret = async () => {
    if (this.state.devices.isExportingIdentityRecovery) return;
    this.state.devices.isExportingIdentityRecovery = true;
    try {
      const exported = await this.client.exportIdentityRecovery();
      await copyText(exported.recoverySecret);
      this.state.devices.currentDeviceId = exported.deviceId;
      this.state.devices.identityNotice = "Backup secret copied. Keep it in a safe place.";
    } catch (error) {
      reportActionError(this.state, "identity_backup.copy_secret.failed", error);
    } finally {
      this.state.devices.isExportingIdentityRecovery = false;
    }
  };

  private restoreIdentityRecovery = async () => {
    if (this.state.devices.isRestoringIdentityRecovery) return;
    if (!this.state.devices.identityRecoverySecret.trim()) {
      this.state.ui.recentError = "Backup secret is required.";
      return;
    }
    this.state.devices.isRestoringIdentityRecovery = true;
    try {
      await this.client.restoreIdentityRecovery(this.state.devices.identityRecoverySecret.trim());
      await this.refreshCurrentDeviceId();
      this.state.devices.identityRecoverySecret = "";
      this.state.ui.showRestoreFromBackup = false;
      this.state.devices.identityNotice = "Device identity restored from backup secret.";
    } catch (error) {
      reportActionError(this.state, "identity_backup.restore.failed", error);
    } finally {
      this.state.devices.isRestoringIdentityRecovery = false;
    }
  };

  private saveFolderPassword = (folderId: string) => this.changeFolderPassword(folderId,
    (this.state.passwords.drafts[folderId] ?? activeFolderPasswords(this.state)[folderId] ?? "").trim());

  private clearFolderPassword = (folderId: string) => this.changeFolderPassword(folderId, "");

  api() {
    return {
      updateFolderPasswordDraft: this.updateFolderPasswordDraft,
      saveFolderPassword: this.saveFolderPassword,
      clearFolderPassword: this.clearFolderPassword,
      addSavedDevice: this.addSavedDevice,
      editSavedDeviceName: this.editSavedDeviceName,
      useSavedDevice: this.useSavedDevice,
      setSavedDeviceIntroducer: this.setSavedDeviceIntroducer,
      removeSavedDevice: this.removeSavedDevice,
      approveAdvertisedDevice: this.approveAdvertisedDevice,
      approveFolderSync: this.approveFolderSync,
      resetDiscoveryServer: this.resetDiscoveryServer,
      clearOfflineFolderState: this.clearOfflineFolderState,
      regenerateDeviceId: this.regenerateDeviceId,
      editLocalDeviceName: this.editLocalDeviceName,
      copyIdentityBackupSecret: this.copyIdentityBackupSecret,
      restoreIdentityRecovery: this.restoreIdentityRecovery,
    };
  }
}

export const createDeviceActions = (args: DeviceActionArgs) =>
  new DeviceActionsRuntime(
    args.state,
    args.client,
    args.sessionStore,
    args.refreshOverview,
    args.refreshActiveView,
    args.refreshCurrentDeviceId,
    args.savePasswords,
  ).api();
