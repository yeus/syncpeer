<script lang="ts">
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Panel from "./Panel.svelte";
  import ListRow from "./ListRow.svelte";
  import StatusChip from "./StatusChip.svelte";

  interface Props {
    app: any;
    connectionModeLabel: string;
    advertisedDevices: any[];
    advertisedFolders: any[];
    isSavedDeviceConnected: (deviceId: string) => boolean;
    isSavedDeviceAwaitingRemoteApproval: (deviceId: string) => boolean;
    currentSourceIsIntroducer: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
    onUseSavedDevice: (deviceId: string) => void;
    onResetDiscoveryServer: () => void;
    onClearAllCache: () => void;
    onClearOfflineFolderState: () => void;
    onOpenDiagnosticsPage: () => void;
    onCopyCurrentDeviceId: () => void;
    onCopySessionLogs: () => void;
    onEditLocalDeviceName: () => void;
    onRegenerateDeviceId: () => void;
    onCopyIdentityBackupSecret: () => void;
    onRestoreIdentityRecovery: () => void;
    onAddSavedDevice: () => void;
    onApproveAdvertisedDevice: (device: any) => void;
    onApproveFolderSync: (folder: any) => void;
    onConnectToSavedDevice: (deviceId: string) => void;
    onEditSavedDeviceName: (deviceId: string) => void;
    onSetSavedDeviceIntroducer: (deviceId: string, next: boolean) => void;
    onRemoveSavedDevice: (deviceId: string) => void;
    onRefreshOverview: () => void;
    onOpenFolderRoot: (folderId: string) => void;
  }

  let {
    app,
    connectionModeLabel,
    advertisedDevices,
    advertisedFolders,
    isSavedDeviceConnected,
    isSavedDeviceAwaitingRemoteApproval,
    currentSourceIsIntroducer,
    onConnect,
    onDisconnect,
    onUseSavedDevice,
    onResetDiscoveryServer,
    onClearAllCache,
    onClearOfflineFolderState,
    onOpenDiagnosticsPage,
    onCopyCurrentDeviceId,
    onCopySessionLogs,
    onEditLocalDeviceName,
    onRegenerateDeviceId,
    onCopyIdentityBackupSecret,
    onRestoreIdentityRecovery,
    onAddSavedDevice,
    onApproveAdvertisedDevice,
    onApproveFolderSync,
    onConnectToSavedDevice,
    onEditSavedDeviceName,
    onSetSavedDeviceIntroducer,
    onRemoveSavedDevice,
    onRefreshOverview,
    onOpenFolderRoot,
  }: Props = $props();
</script>

<Panel title="Settings">
  <div class="status-row">
    <StatusChip tone={app.session.isConnected ? "online" : "offline"}>
      {app.session.isConnected ? "Connected" : "Disconnected"}
    </StatusChip>
    {#if app.session.lastUpdatedAt}
      <span>Updated {app.session.lastUpdatedAt}</span>
    {/if}
    {#if app.session.isConnected && app.session.connectionPath}
      <span>
        Path:
        {app.session.connectionTransport === "relay" ? "relay" : "direct tcp"}
        ({app.session.connectionPath})
      </span>
    {/if}
  </div>

  <div class="identity-inline">
    <div class="item-main">
      <div class="item-title-row">
        <span class="item-title">This Device ID</span>
        {#if app.devices.isLoadingCurrentDeviceId}
          <StatusChip small>loading...</StatusChip>
        {/if}
      </div>
      <div class="item-meta">{app.devices.currentDeviceId || "Unavailable"}</div>
      <div class="item-meta">
        Advertised name: {app.connection.deviceName.trim() || "syncpeer-ui"}
      </div>
      {#if app.devices.identityNotice}
        <div class="item-meta">{app.devices.identityNotice}</div>
      {/if}
    </div>
    <div class="item-actions">
      <button class="ghost" onclick={onCopyCurrentDeviceId}>Copy ID</button>
      <button class="ghost" onclick={onEditLocalDeviceName}>Edit Name</button>
      <button class="ghost" onclick={onRegenerateDeviceId} disabled={app.devices.isRegeneratingDeviceId}>
        {app.devices.isRegeneratingDeviceId ? "Generating..." : "Generate New ID"}
      </button>
    </div>
  </div>

  {#if !app.session.isConnected}
    <button class="primary" onclick={onConnect} disabled={app.session.isConnecting}>
      {app.session.isConnecting ? "Connecting..." : "Connect Using Last Settings"}
    </button>
  {:else}
    <button class="ghost" onclick={onDisconnect} disabled={app.session.isConnecting}>
      Disconnect
    </button>
  {/if}

  <details bind:open={app.ui.isSettingsExpanded}>
    <summary>Connection Settings</summary>
    <form
      class="settings"
      onsubmit={(event) => {
        event.preventDefault();
        onConnect();
      }}
    >
      <label>
        Discovery Method
        <select bind:value={app.connection.discoveryMode}>
          <option value="global">Global Discovery (default)</option>
          <option value="direct">Direct Host/Port</option>
        </select>
      </label>

      {#if app.connection.discoveryMode === "global"}
        <label>
          Discovery Server
          <input type="text" bind:value={app.connection.discoveryServer} />
        </label>
      {/if}

      {#if app.connection.discoveryMode === "direct"}
        <label>
          Host
          <input type="text" bind:value={app.connection.host} placeholder="127.0.0.1" />
        </label>

        <label>
          Port
          <input type="number" bind:value={app.connection.port} min="1" max="65535" />
        </label>
      {:else}
        <div class="hint">
          Global discovery ignores manual host/port. The official Syncthing discovery server pin is applied automatically when you use discovery.syncthing.net.
        </div>
      {/if}

      <label>
        Saved Devices
        <select bind:value={app.devices.selectedSavedDeviceId}>
          <option value="">Manual entry</option>
          {#each app.devices.savedDevices as device (device.id)}
            <option value={device.id}>{device.name}</option>
          {/each}
        </select>
      </label>

      <label>
        Remote Device ID
        <input
          type="text"
          bind:value={app.connection.remoteId}
          placeholder="ABCD123-... (required for global discovery)"
          spellcheck="false"
          autocapitalize="characters"
          autocomplete="off"
          autocorrect="off"
        />
      </label>

      <label>
        TLS Certificate (optional)
        <input
          type="text"
          bind:value={app.connection.cert}
          placeholder="Auto uses persisted cli-node cert.pem"
        />
      </label>

      <label>
        TLS Key (optional)
        <input
          type="text"
          bind:value={app.connection.key}
          placeholder="Auto uses persisted cli-node key.pem"
        />
      </label>

      <label>
        Timeout (ms)
        <input type="number" bind:value={app.connection.timeoutMs} min="1000" step="1000" />
      </label>

      <label class="checkbox-row">
        <input type="checkbox" bind:checked={app.connection.enableRelayFallback} />
        <span>Enable relay fallback (Syncthing relay://)</span>
      </label>

      <label class="checkbox-row">
        <input type="checkbox" bind:checked={app.connection.autoAcceptNewDevices} />
        <span>Auto-accept newly advertised devices</span>
      </label>

      <label class="checkbox-row">
        <input type="checkbox" bind:checked={app.connection.autoAcceptIntroducedFolders} />
        <span>Auto-approve folder sync for introduced folders</span>
      </label>
    </form>

    <div class="actions">
      <button
        type="button"
        class="ghost"
        onclick={() => onUseSavedDevice(app.devices.selectedSavedDeviceId)}
        disabled={app.devices.selectedSavedDeviceId === ""}
      >
        Use Selected Device
      </button>
      <button
        type="button"
        class="ghost"
        onclick={onResetDiscoveryServer}
        disabled={app.connection.discoveryMode !== "global"}
      >
        Use Official Discovery Server
      </button>
      <button type="button" class="ghost" onclick={onClearAllCache} disabled={app.favorites.isClearingCache}>
        {app.favorites.isClearingCache ? "Clearing Cache..." : "Clear Cache"}
      </button>
      <button type="button" class="ghost" onclick={onClearOfflineFolderState}>
        Clear Offline Folder State
      </button>
      <button type="button" class="ghost" onclick={onOpenDiagnosticsPage}>
        Open Diagnostics Page
      </button>
    </div>
  </details>
</Panel>

<Panel>
  <details bind:open={app.ui.isDeviceBackupExpanded}>
    <summary>Device ID Backup</summary>
    <p class="hint">Keep a backup secret to restore this exact device ID after reinstall.</p>
    <div class="item-meta">Device ID: {app.devices.currentDeviceId || "Unavailable"}</div>
    <div class="actions">
      <button type="button" class="primary" onclick={onCopyCurrentDeviceId}>Copy Device ID</button>
      <button
        type="button"
        class="primary"
        onclick={onCopyIdentityBackupSecret}
        disabled={app.devices.isExportingIdentityRecovery}
      >
        {app.devices.isExportingIdentityRecovery ? "Copying..." : "Copy Backup Secret"}
      </button>
      <button
        type="button"
        class="ghost"
        onclick={() => {
          app.ui.showRestoreFromBackup = !app.ui.showRestoreFromBackup;
          app.ui.recentError = null;
        }}
      >
        {app.ui.showRestoreFromBackup ? "Hide Restore" : "Restore From Backup Secret"}
      </button>
    </div>

    {#if app.ui.showRestoreFromBackup}
      <label>
        Backup Secret
        <textarea
          class="recovery-secret"
          bind:value={app.devices.identityRecoverySecret}
          placeholder="Paste backup secret here"
        ></textarea>
      </label>
      <div class="actions">
        <button
          type="button"
          class="ghost"
          onclick={onRestoreIdentityRecovery}
          disabled={app.devices.isRestoringIdentityRecovery}
        >
          {app.devices.isRestoringIdentityRecovery ? "Restoring..." : "Restore Device ID"}
        </button>
        <button
          type="button"
          class="ghost"
          onclick={() => {
            app.devices.identityRecoverySecret = "";
            app.ui.recentError = null;
          }}
          disabled={!app.devices.identityRecoverySecret.trim()}
        >
          Clear Input
        </button>
      </div>
    {/if}
  </details>
</Panel>

<Panel title="Add Device">
  <div class="saved-device-editor">
    <label>
      Device ID
      <input type="text" bind:value={app.devices.newSavedDeviceId} placeholder="ABCD123-..." />
    </label>
    {#if app.devices.newSavedDeviceId.trim()}
      <p class="hint">
        Saved as <strong>{app.devices.newSavedDeviceCustomName.trim() || app.devices.newSavedDeviceId}</strong>.
        We’ll switch to the device’s advertised name after first connection unless you set a custom name.
      </p>
    {/if}
    <label>
      Custom name (optional)
      <input
        type="text"
        bind:value={app.devices.newSavedDeviceCustomName}
        placeholder="Leave blank to use device advertised name later"
      />
    </label>
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={app.devices.newSavedDeviceIsIntroducer} />
      <span>Treat as introducer</span>
    </label>
    <div class="actions">
      <button type="button" class="primary" onclick={onAddSavedDevice}>Add Device</button>
    </div>
  </div>
</Panel>

<Panel title="Advertised Devices">
  {#if app.session.isConnected && !currentSourceIsIntroducer}
    <p class="hint">
      Introductions are only trusted from introducer peers. Mark this connected device as introducer to review/accept advertised devices.
    </p>
  {/if}
  <ul class="list">
    {#if advertisedDevices.length === 0}
      <li class="empty">No introduced devices pending from the current introducer peer.</li>
    {:else}
      {#each advertisedDevices as device (device.id)}
        <ListRow>
          <div class="item-title-row">
            <div class="item-title">{device.name}</div>
            <StatusChip tone={device.accepted ? "online" : "offline"} small>
              {device.accepted ? "accepted" : "non-accepted"}
            </StatusChip>
          </div>
          <div class="item-meta">{device.id}</div>
          <div class="item-meta">Seen in folders: {device.sourceFolderIds.join(", ")}</div>
          <svelte:fragment slot="actions">
            {#if device.accepted}
              <button class="ghost" onclick={() => onUseSavedDevice(device.id)}>Use</button>
            {:else}
              <button class="primary" onclick={() => onApproveAdvertisedDevice(device)}>
                Approve
              </button>
            {/if}
          </svelte:fragment>
        </ListRow>
      {/each}
    {/if}
  </ul>
</Panel>

<Panel title="Folder Sync Approvals">
  {#if app.session.isConnected && !currentSourceIsIntroducer}
    <p class="hint">Introduced folder sync can only be approved from introducer peers.</p>
  {/if}
  <ul class="list">
    {#if advertisedFolders.length === 0}
      <li class="empty">No introduced folder sync approvals pending from the current introducer peer.</li>
    {:else}
      {#each advertisedFolders as folder (folder.key)}
        <ListRow>
          <div class="item-title-row">
            <div class="item-title">{folder.label}</div>
            <StatusChip tone={folder.syncApproved ? "online" : "offline"} small>
              {folder.syncApproved ? "sync approved" : "sync not approved"}
            </StatusChip>
          </div>
          <div class="item-meta">Folder ID: {folder.folderId}</div>
          <div class="item-meta">Introduced by: {folder.sourceDeviceId}</div>
          <svelte:fragment slot="actions">
            {#if folder.syncApproved}
              <button class="ghost" onclick={() => onOpenFolderRoot(folder.folderId)} disabled={!app.session.isConnected}>
                Open
              </button>
            {:else}
              <button class="primary" onclick={() => onApproveFolderSync(folder)}>
                Approve Sync
              </button>
            {/if}
          </svelte:fragment>
        </ListRow>
      {/each}
    {/if}
  </ul>
</Panel>

<Panel title="Saved Devices">
  <ul class="list">
    {#if app.devices.savedDevices.length === 0}
      <li class="empty">No saved devices yet. Add one from Connection Settings.</li>
    {:else}
      {#each app.devices.savedDevices as device (device.id)}
        <ListRow>
          <div class="item-title-row">
            <button class="item-title" onclick={() => onUseSavedDevice(device.id)}>{device.name}</button>
            {#if device.isIntroducer}
              <StatusChip small>introducer</StatusChip>
            {/if}
            {#if isSavedDeviceConnected(device.id)}
              <StatusChip tone="online" small>online</StatusChip>
            {/if}
            {#if isSavedDeviceAwaitingRemoteApproval(device.id)}
              <StatusChip tone="offline" small title="This peer may still need to approve your device on their Syncthing side.">
                not approved yet
              </StatusChip>
            {/if}
          </div>
          <div class="item-meta">{device.id}</div>
          <svelte:fragment slot="actions">
            <button
              class="primary"
              onclick={() => onConnectToSavedDevice(device.id)}
              disabled={app.session.isConnecting}
            >
              {app.session.isConnecting && app.session.activeConnectDeviceId === device.id
                ? "Connecting..."
                : "Connect"}
            </button>
            <button class="ghost" onclick={() => onUseSavedDevice(device.id)}>Use</button>
            <button class="ghost" onclick={() => onEditSavedDeviceName(device.id)}>Edit Name</button>
            <button
              class="ghost"
              onclick={() => onSetSavedDeviceIntroducer(device.id, !device.isIntroducer)}
            >
              {device.isIntroducer ? "Unset Introducer" : "Set Introducer"}
            </button>
            <button class="icon icon-only" onclick={() => onRemoveSavedDevice(device.id)} aria-label="Remove saved device">
              <Trash2 size={16} />
            </button>
          </svelte:fragment>
        </ListRow>
      {/each}
    {/if}
  </ul>
</Panel>

<Panel title="Active Remote Device">
  <ul class="list">
    {#if !app.session.remoteDevice}
      <li class="empty">No remote device metadata yet. Connect to a saved device.</li>
    {:else}
      <ListRow>
        <div class="item-title" title={app.session.remoteDevice.deviceName}>
          {app.session.remoteDevice.deviceName}
        </div>
        <div class="item-meta">{app.session.remoteDevice.id}</div>
        <div class="item-meta">
          {app.session.remoteDevice.clientName}
          {app.session.remoteDevice.clientVersion}
        </div>
        {#if app.session.connectionPath}
          <div class="item-meta">
            Connected via {app.session.connectionTransport === "relay" ? "relay" : "direct tcp"}:
            {app.session.connectionPath}
          </div>
        {/if}
        <svelte:fragment slot="actions">
          <button
            class="ghost"
            onclick={onRefreshOverview}
            disabled={!app.session.isConnected || app.session.isRefreshing || app.session.isConnecting}
          >
            Refresh
          </button>
        </svelte:fragment>
      </ListRow>
    {/if}
  </ul>
</Panel>

<Panel title="Session Logs">
  <details bind:open={app.ui.isLogPanelExpanded}>
    <summary>View logs ({app.logs.items.length})</summary>
    <div class="actions">
      <button type="button" class="ghost" onclick={onCopySessionLogs}>Copy Logs</button>
    </div>
    <ul class="list">
      {#if app.logs.items.length === 0}
        <li class="empty">No session logs yet.</li>
      {:else}
        {#each app.logs.items as item (item.id)}
          <ListRow>
            <div class="item-meta">
              {new Date(item.timestampMs).toLocaleTimeString()} | {item.level.toUpperCase()} | {item.event}
            </div>
            <div class={`item-meta ${item.level === "error" ? "log-error" : item.level === "warning" ? "log-warning" : ""}`}>
              {item.message}
            </div>
            {#if item.details !== undefined}
              <pre class="log-details">{JSON.stringify(item.details, null, 2)}</pre>
            {/if}
          </ListRow>
        {/each}
      {/if}
    </ul>
  </details>
</Panel>
