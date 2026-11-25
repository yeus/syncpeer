<script lang="ts">
  import PasswordInput from "./PasswordInput.svelte";
  import Panel from "./Panel.svelte";
  import ListRow from "./ListRow.svelte";
  import type { AppState } from "../app/state.ts";
  import { formatSyncthingDeviceId } from "../app/devicePolicies.ts";
  import type { SettingsSection } from "../app/settingsSections.ts";
  interface Props {
    app: AppState;
    section: SettingsSection;
    onResetDiscoveryServer: () => void;
    onClearAllCache: () => void;
    onClearOfflineFolderState: () => void;
    onOpenDiagnosticsPage: () => void;
    onCopyCurrentDeviceId: () => void;
    onCopySessionLogs: () => void;
    onSaveSessionLogs?: () => void;
    onShareSessionLogs?: () => void;
    logExportStatus?: "preparing" | "copying" | "saving" | "sharing" | null;
    onEditLocalDeviceName: () => void;
    onRegenerateDeviceId: () => void;
    onCopyIdentityBackupSecret: () => void;
    onRestoreIdentityRecovery: () => void;
    onUseSavedDevice: (deviceId: string) => void;
    onConnectionSettingsChanged: () => void;
  }
  let { app, section, onResetDiscoveryServer, onClearAllCache, onClearOfflineFolderState, onOpenDiagnosticsPage, onCopyCurrentDeviceId, onCopySessionLogs, onSaveSessionLogs, onShareSessionLogs, logExportStatus = null, onEditLocalDeviceName, onRegenerateDeviceId, onCopyIdentityBackupSecret, onRestoreIdentityRecovery, onUseSavedDevice, onConnectionSettingsChanged }: Props = $props();
  let previousRunPanelExpanded = $state(false);
</script>

{#if section === "appearance"}
<Panel title="Appearance">
      <div class="appearance-settings" data-testid="appearance-settings">
        <div class="appearance-grid">
          <label>
            Theme
            <select data-testid="theme-mode" bind:value={app.ui.theme.mode}>
              <option value="auto">Automatic</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Primary color
            <span class="color-field">
              <input
                data-testid="theme-primary-color"
                type="color"
                bind:value={app.ui.theme.primaryColor}
              />
              <code>{app.ui.theme.primaryColor}</code>
            </span>
          </label>
          <label>
            Secondary color
            <span class="color-field">
              <input
                data-testid="theme-secondary-color"
                type="color"
                bind:value={app.ui.theme.secondaryColor}
              />
              <code>{app.ui.theme.secondaryColor}</code>
            </span>
          </label>
          <label class="checkbox-row expert-toggle">
            <input
              data-testid="expert-view"
              type="checkbox"
              bind:checked={app.ui.expertView}
            />
            <span>Expert view</span>
          </label>
        </div>
      </div>
</Panel>
{:else if section === "network"}
<Panel title="Network">
  <p class="hint" data-testid="local-discovery-health" role="status">
    {#if app.devices.isDiscoveringLanDevices}Scanning the local network…
    {:else if app.devices.localDiscoveryHealth === "partial"}Partial LAN discovery
    {:else if app.devices.localDiscoveryHealth === "unavailable"}LAN discovery unavailable
    {:else if app.devices.localDiscoveryHealth === "available"}LAN discovery available
    {:else}LAN discovery not yet checked{/if}
  </p>
  <p class="hint">LAN discovery only finds reachable devices on the same multicast-capable network. For a peer outside your LAN, enter its device ID below and use automatic/global discovery or a configured direct/relay address. Discovery does not approve a peer.</p>
  {#if app.devices.localDiscoveryNotice}
    <p class="hint" data-testid="local-discovery-notice">
      {app.devices.localDiscoveryNotice}
    </p>
  {/if}
      <form
        class="settings"
        onchange={() => {
          app.devices.directTcpNotice = "";
          onConnectionSettingsChanged();
        }}
        onsubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label>
          Discovery Method
          <select data-testid="connection-discovery-mode" bind:value={app.connection.discoveryMode}
            onchange={() => {
              if (app.connection.discoveryMode !== "direct") app.connection.quicOnly = false;
            }}>
            <option value="automatic">Automatic (default)</option>
            <option value="global">Global Discovery</option>
            <option value="lan">LAN Discovery</option>
            <option value="direct">Direct Host/Port</option>
          </select>
        </label>

        {#if app.connection.discoveryMode === "automatic" || app.connection.discoveryMode === "global"}
          <label>
            Discovery Server
            <input data-testid="connection-discovery-server" type="text" bind:value={app.connection.discoveryServer} />
          </label>
        {/if}

        {#if app.connection.discoveryMode === "lan"}
          <p class="hint">
            LAN discovery uses Syncthing's local UDP discovery. Both devices must
            be on the same LAN or multicast-capable network.
          </p>
        {/if}

        {#if app.connection.discoveryMode === "direct" || app.connection.discoveryMode === "automatic"}
          <label>
            Host
            <input
              data-testid="connection-host"
              type="text"
              bind:value={app.connection.host}
              placeholder="e.g. 192.168.1.10"
            />
          </label>
          {#if app.connection.discoveryMode === "direct" && app.devices.directTcpNotice}
            <p class="hint" role="status" data-testid="direct-tcp-address-notice">{app.devices.directTcpNotice}</p>
          {/if}

          <label>
            Port
            <input
              data-testid="connection-port"
              type="number"
              bind:value={app.connection.port}
              min="1"
              max="65535"
            />
          </label>
        {:else if app.connection.discoveryMode === "global"}
          <div class="hint">
            Global discovery ignores manual host/port. Syncpeer uses Syncthing's
            current official lookup and announcement services automatically.
          </div>
        {/if}
        {#if app.connection.discoveryMode === "direct"}
          <label class="checkbox-row">
            <input
              data-testid="connection-direct-quic"
              type="checkbox"
              bind:checked={app.connection.quicOnly}
            />
            <span>Use QUIC instead of TCP for this direct connection</span>
          </label>
        {/if}

        {#if app.connection.discoveryMode === "automatic"}
          <div class="hint">
            Automatic mode races saved, LAN, global, direct, and relay paths and keeps the best available connection.
          </div>
        {/if}

        <label>
          Incoming TCP port
          <input
            data-testid="connection-listen-port"
            type="number"
            bind:value={app.connection.listenPort}
            min="1"
            max="65535"
          />
        </label>
        <div class="hint">Other peers can reach this device on this port when LAN access is available. Default: 22000.</div>

        <label>
          Saved Devices
          <select data-testid="connection-saved-device" bind:value={app.devices.selectedSavedDeviceId}>
            <option value="">Manual entry</option>
            {#each app.devices.savedDevices as device (device.id)}
              <option value={device.id}>{device.name}</option>
            {/each}
          </select>
        </label>

        <label>
          Remote Device ID
          <input
            data-testid="connection-remote-id"
            type="text"
            bind:value={app.connection.remoteId}
            placeholder="ABCD123-... (required for discovery modes)"
            spellcheck="false"
            autocapitalize="characters"
            autocomplete="off"
            autocorrect="off"
          />
        </label>

        <label>
          TLS Certificate (optional)
          <input
            data-testid="connection-cert"
            type="text"
            bind:value={app.connection.cert}
            placeholder="Auto uses this device's protected certificate"
          />
        </label>

        <label>
          TLS Key (optional)
          <input
            data-testid="connection-key"
            type="text"
            bind:value={app.connection.key}
            placeholder="Auto uses this device's protected key"
          />
        </label>

        <label>
          Timeout (ms)
          <input
            data-testid="connection-timeout"
            type="number"
            bind:value={app.connection.timeoutMs}
            min="1000"
            step="1000"
          />
        </label>

        <label class="checkbox-row">
          <input
            data-testid="connection-relay-fallback"
            type="checkbox"
            bind:checked={app.connection.enableRelayFallback}
          />
          <span>Enable relay fallback (Syncthing relay://)</span>
        </label>

        <p class="hint">New devices and offered folders always require explicit approval.</p>

      </form>
      <div class="actions">
      <button
          type="button"
          class="ghost"
          onclick={() => onUseSavedDevice(app.devices.selectedSavedDeviceId)}
          disabled={app.devices.selectedSavedDeviceId === ""}
        >
          Connect to Selected Peer
        </button>
        <button
          type="button"
          class="ghost"
          onclick={onResetDiscoveryServer}
          disabled={app.connection.discoveryMode !== "global" && app.connection.discoveryMode !== "automatic"}
        >
          Use Official Discovery Server
        </button>
      </div>
</Panel>
{:else if section === "storage"}
<Panel title="Cache management">
  <div class="actions">
        <button
          type="button"
          class="ghost"
          data-testid="clear-cache-button"
          onclick={onClearAllCache}
          disabled={app.favorites.isClearingCache}
        >
          {app.favorites.isClearingCache ? "Clearing Cache..." : "Clear Cache"}
        </button>
        <button type="button" class="ghost" onclick={onClearOfflineFolderState}>
          Clear Offline Folder State
        </button>
  </div>
</Panel>
{:else if section === "security"}
<Panel title="Device identity">
  <p class="item-meta">{formatSyncthingDeviceId(app.devices.currentDeviceId) || "Unavailable"}</p>
  <details bind:open={app.ui.isDeviceBackupExpanded}>
    <summary>This Device Details</summary>
    <div class="actions">
      <button type="button" class="ghost" onclick={onCopyCurrentDeviceId}>Copy ID</button>
      <button type="button" class="ghost" onclick={onEditLocalDeviceName}>Edit Name</button>
      <button
        type="button"
        class="ghost"
        onclick={onRegenerateDeviceId}
        disabled={app.devices.isRegeneratingDeviceId}
      >
        {app.devices.isRegeneratingDeviceId ? "Generating..." : "Generate New ID"}
      </button>
      <button
        type="button"
        class="ghost"
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
        {app.ui.showRestoreFromBackup
          ? "Hide Restore"
          : "Restore From Backup Secret"}
      </button>
    </div>

    {#if app.ui.showRestoreFromBackup}
      <PasswordInput label="Backup Secret" secretLabel="device identity backup secret"
        testId="device-identity-backup-secret" bind:value={app.devices.identityRecoverySecret}
        placeholder="Paste backup secret here" autocomplete="off" />
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
{:else if section === "diagnostics"}
  <div class="actions">
    <button data-testid="open-diagnostics" onclick={onOpenDiagnosticsPage}>Run diagnostics</button>
  </div>
<Panel title="Session Logs">
  <div class="actions">
    <button type="button" class="ghost" disabled={logExportStatus !== null} onclick={onCopySessionLogs}
      >Copy Logs</button
    >
    {#if onSaveSessionLogs}
      <button type="button" class="ghost" data-testid="save-session-logs" disabled={logExportStatus !== null} onclick={onSaveSessionLogs}
        >Save Logs</button
      >
    {/if}
    {#if onShareSessionLogs}
      <button type="button" class="ghost" data-testid="share-session-logs" disabled={logExportStatus !== null} onclick={onShareSessionLogs}
        >Share Logs</button
      >
    {/if}
  {#if logExportStatus !== null}
    <p role="status" data-testid="session-log-export-status" class="hint">
      {logExportStatus === "preparing"
        ? "Preparing encrypted previous-run history for export…"
        : logExportStatus === "sharing" ? "Opening Android share sheet…"
        : logExportStatus === "saving" ? "Saving logs…" : "Copying logs…"}
    </p>
  {/if}
  </div>
  <p class="hint">Android encrypted journal: {app.logs.journalStarted ? "writing enabled" : "not confirmed"}. Previous runs: {app.logs.historyAvailable ? `${app.logs.previousRunItems.length} entries recovered` : "not loaded"}. Save/Share retrieves history; installed updates preserve data, uninstalling does not.</p>
  {#if app.logs.historyError}
    <p class="hint" role="status">{app.logs.historyError}</p>
  {/if}
  {#if app.logs.historyAvailable && app.logs.previousRunItems.length > 0}
    <details data-testid="previous-session-logs" bind:open={previousRunPanelExpanded}>
      <summary>Previous runs ({app.logs.previousRunItems.length} entries)
        {#if app.logs.previousRunStartedAtMs}
          · {new Date(app.logs.previousRunStartedAtMs).toLocaleString()}
        {/if}
      </summary>
      {#if previousRunPanelExpanded}
      {#if app.logs.previousRunItems.length > 250}
        <p class="item-meta">Showing 250 recent entries; Save or Share Logs includes all recovered entries.</p>
      {/if}
      <ul class="list">
        {#each app.logs.previousRunItems.slice(0, 250) as item (item.id)}
          <ListRow>
            <div class="item-meta">
              {new Date(item.timestampMs).toLocaleString()} | {item.level.toUpperCase()} | {item.event}
            </div>
            <div class={`item-meta ${item.level === "error" ? "log-error" : item.level === "warning" ? "log-warning" : ""}`}>{item.message}</div>
            {#if item.details !== undefined}
              <pre class="log-details">{JSON.stringify(item.details, null, 2)}</pre>
            {/if}
          </ListRow>
        {/each}
      </ul>
      {/if}
    </details>
  {/if}
  <details bind:open={app.ui.isLogPanelExpanded}>
    <summary>View logs ({app.logs.items.length})</summary>
    {#if app.ui.isLogPanelExpanded}
      {#if app.logs.items.length > 250}
        <p class="item-meta">Showing the latest 250 entries. Save or Share Logs includes all {app.logs.items.length} cached entries.</p>
      {/if}
      <ul class="list">
      {#if app.logs.items.length === 0}
        <li class="empty">No session logs yet.</li>
      {:else}
        {#each app.logs.items.slice(0, 250) as item (item.id)}
          <ListRow>
            <div class="item-meta">
              {new Date(item.timestampMs).toLocaleTimeString()} | {item.level.toUpperCase()}
              | {item.event}
            </div>
            <div
              class={`item-meta ${item.level === "error" ? "log-error" : item.level === "warning" ? "log-warning" : ""}`}
            >
              {item.message}
            </div>
            {#if item.details !== undefined}
              <pre class="log-details">{JSON.stringify(
                  item.details,
                  null,
                  2,
                )}</pre>
            {/if}
          </ListRow>
        {/each}
      {/if}
    </ul>
    {/if}
  </details>
</Panel>
{/if}
<style>
  .appearance-settings {
    padding-bottom: 0.7rem;
    border-bottom: 0;
  }

  .appearance-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.55rem;
    align-items: end;
  }

  .color-field {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 42px;
  }

  .color-field input {
    width: 3rem;
    height: 2.35rem;
    padding: 0.15rem;
  }

  .color-field code {
    color: var(--text-secondary);
    font-size: 0.76rem;
  }

  .expert-toggle {
    min-height: 42px;
  }

  .actions {
    display: flex;
    gap: 0.45rem;
    margin-top: 0.45rem;
    flex-wrap: wrap;
  }

  form.settings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
    gap: 0.45rem;
    margin-top: 0.45rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .checkbox-row {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    min-height: 42px;
  }

  .checkbox-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
    margin: 0;
  }

  @media (max-width: 640px) {
    form.settings {
      grid-template-columns: 1fr;
    }
  }
</style>
