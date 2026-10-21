<script lang="ts">
  import { defaultFolderSettings, defaultProfileSettings } from "../../core/src/sync/profileSettings.ts";
  import { createInitialState } from "../src/app/state.ts";
  import GeneralSettingsPage from "../src/GeneralSettingsPage.svelte";
  import PersonalSpaceOnboarding from "../src/components/PersonalSpaceOnboarding.svelte";
  import FolderSettingsPage from "../src/FolderSettingsPage.svelte";
  import NewFolderPage from "../src/NewFolderPage.svelte";
  import DeviceTab from "../src/components/DeviceTab.svelte";
  import FileSystemListItem from "../src/components/FileSystemListItem.svelte";

  let app = $state(createInitialState(null));
  let page = $state("main"), phase = $state("unlocked");
  let managedStorage = $state(true), selectedFolderId = $state("photos");
  let password = $state("synthetic-folder-password");
  let calls = $state<Record<string, unknown>[]>([]);
  let profile = $state({ ...defaultProfileSettings(), folders: {
    photos: { ...defaultFolderSettings(), ignorePatterns: ["photos-only"] },
    documents: { ...defaultFolderSettings(), ignorePatterns: ["documents-only"] },
  } });
  let minimumCopies = $state(2);
  const devices = [{ id: "synthetic-device", syncthingId: "synthetic-owned-peer", state: "active" }];
  const record = (request: Record<string, unknown>) => { calls = [...calls, request]; };
  async function command<T>(request: Record<string, unknown>): Promise<T> {
    record(request);
    switch (request.operation) {
      case "status": return { vault: { phase }, folders: [
        { id: "photos", label: "Photos", downloads: true },
        { id: "documents", label: "Documents", downloads: true },
      ], pendingLocalReleases: [] } as T;
      case "profileSettings": return profile as T;
      case "ownedDevices": return { localDeviceId: "synthetic-device", devices } as T;
      case "sharedPersonalSpaceSettings": return { settings: { folders: {
        photos: { minimumCopies, retentionRevision: 1, holders: [], devices: {} },
        documents: { minimumCopies: 3, retentionRevision: 1, holders: [], devices: {} },
      } }, conflicts: [{ path: ["folders", "photos", "credential"], heads: [], changes: [
        { id: "synthetic-credential-conflict", deviceId: "synthetic-device", value: {
          label: "Photos", password: "synthetic-never-rendered-credential" }, },
      ] }, { path: ["folders", "documents", "retention"], heads: [], changes: [
        { id: "synthetic-conflict", deviceId: "synthetic-device", value: "documents-only-conflict" },
      ] }] } as T;
      case "localReleaseHistory": return [] as T;
      case "saveProfileSettings": profile = request.settings as typeof profile; break;
      case "savePersonalSpaceSetting": minimumCopies = (request.value as { minimumCopies: number }).minimumCopies; break;
      case "unlock": phase = "unlocked"; break;
    }
    return undefined as T;
  }
</script>

<button data-testid="lock-fixture" onclick={() => { phase = "locked"; }}>Lock fixture</button>
<button data-testid="uninitialized-fixture" onclick={() => { phase = "uninitialized"; }}>Reset fixture</button>
<button data-testid="browser-fixture" onclick={() => { managedStorage = false; }}>Browser fixture</button>
<button data-testid="onboarding-fixture" onclick={() => { page = "onboarding"; }}>Onboarding fixture</button>
<output data-testid="calls" hidden>{JSON.stringify(calls)}</output>
{#if page === "main"}
  <DeviceTab {app} advertisedDevices={[]} currentSourceIsIntroducer={false}
    isSavedDeviceConnected={() => false} isSavedDeviceAwaitingRemoteApproval={() => false} isLanDiscoveredDevice={() => false}
    onUseSavedDevice={() => {}} onResetDiscoveryServer={() => {}} onClearAllCache={() => {}} onClearOfflineFolderState={() => {}}
    onOpenDiagnosticsPage={() => {}} onOpenAboutPage={() => {}} onCopyCurrentDeviceId={() => {}} onCopySessionLogs={() => {}}
    onEditLocalDeviceName={() => {}} onRegenerateDeviceId={() => {}} onCopyIdentityBackupSecret={() => {}}
    onRestoreIdentityRecovery={() => {}} onAddSavedDevice={() => {}} onApproveAdvertisedDevice={() => {}}
    onEditSavedDeviceName={() => {}} onSetSavedDeviceIntroducer={() => {}} onRemoveSavedDevice={() => {}}
    onConnectLocalCandidate={() => {}} onConnectionSettingsChanged={() => {}} onOpenGeneralSettings={() => { page = "general"; }} />
  <button data-testid="new-folder" onclick={() => { page = "new"; }}>New folder</button>
  <ul><FileSystemListItem item={{ kind: "root-folder", folderId: "photos", name: "Photos", readOnly: false,
    encrypted: true, lockLabel: "unlocked", passwordError: "", locked: false, isFavorite: false,
    hasCachedRoot: false, statsText: "synthetic folder" }} isOpeningCachedFile={false}
    isRemovingCachedFile={false} isClearingCache={false}
    onOpenFolderSettings={id => { selectedFolderId = id; page = "folder"; }} /></ul>
{:else if page === "general"}
  <GeneralSettingsPage {command} onBack={() => { page = "main"; }} onUnlock={async () => {}}
    onOpenFolderSettings={id => { selectedFolderId = id; page = "folder"; }}
    onUnlockBiometric={async () => {}} onRotateMasterPassword={async value => { record({ operation: "changeMasterPassword", value }); }}
    onSettingsSaved={() => {}} onTrustedDevicesChanged={async () => {}} getDefaultDeviceId={async () => "synthetic-device"}
    onStartPairing={async () => { throw new Error("Pairing is outside this synthetic fixture."); }}
    onJoinPairing={async () => { throw new Error("Pairing is outside this synthetic fixture."); }} onPairedDevice={() => {}} />
{:else if page === "folder"}
  <FolderSettingsPage folderId={selectedFolderId} folderLabel={selectedFolderId === "photos" ? "Photos" : "Documents"}
    encrypted={true} {managedStorage}
    passwordDraft={password} passwordSaved={password} passwordError="" actionError="" peerId="synthetic-owned-peer"
    {command} onBack={() => { page = "main"; }} onOpenGeneralSettings={() => { page = "general"; }}
    onUpdatePassword={(_id, value) => { password = value; }}
    onSavePassword={async id => { record({ operation: "saveFolderPassword", folderId: id, password }); }}
    onClearPassword={async id => { password = ""; record({ operation: "clearFolderPassword", folderId: id }); }}
    onImport={async () => {}} onMigrate={async (id, target) => { record({ operation: "migrate", folderId: id, target }); }}
    onRelease={async () => {}} onSettingsSaved={() => {}} />
{:else if page === "onboarding"}
  <PersonalSpaceOnboarding mode="create" suggestedName="synthetic-device" initialDeviceName=""
    {command} getDefaultDeviceId={async () => "synthetic-device"}
    onDeviceNameSaved={() => {}} onReady={async () => {}} onOpenSettings={() => { page = "general"; }} />
{:else}
  <NewFolderPage {command} onBack={() => { page = "main"; }} onOpenGeneralSettings={() => { page = "general"; }}
    onCreate={async label => { record({ operation: "createFolder", label }); }} />
{/if}
