<script lang="ts">
  import type { AdvertisedDeviceItem } from "@syncpeer/core/browser";
  import DeviceListItem from "./DeviceListItem.svelte";
  import Panel from "./Panel.svelte";
  import ListRow from "./ListRow.svelte";
  import StatusChip from "./StatusChip.svelte";
  import { detectRuntimeEnvironment, detectRuntimeSurface } from "../lib/runtimeInfo.ts";
  import type { AppState } from "../app/state.ts";

  interface Props {
    app: AppState;
    advertisedDevices: AdvertisedDeviceItem[];
    isSavedDeviceConnected: (deviceId: string) => boolean;
    isSavedDeviceAwaitingRemoteApproval: (deviceId: string) => boolean;
    isLanDiscoveredDevice: (deviceId: string) => boolean;
    currentSourceIsIntroducer: boolean;
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
    onApproveAdvertisedDevice: (device: AdvertisedDeviceItem) => void;
    onEditSavedDeviceName: (deviceId: string) => void;
    onSetSavedDeviceIntroducer: (deviceId: string, next: boolean) => void;
    onRemoveSavedDevice: (deviceId: string) => void;
    onConnectLocalCandidate: (candidateId: string) => void;
  }

  let {
    app,
    advertisedDevices,
    isSavedDeviceConnected,
    isSavedDeviceAwaitingRemoteApproval,
    isLanDiscoveredDevice,
    currentSourceIsIntroducer,
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
    onEditSavedDeviceName,
    onSetSavedDeviceIntroducer,
    onRemoveSavedDevice,
    onConnectLocalCandidate,
  }: Props = $props();

  const appVersion = String(import.meta.env.SYNCPEER_APP_VERSION || "0.0.0");
  const buildCommit = String(import.meta.env.SYNCPEER_BUILD_COMMIT || "unknown");
  const buildTimeUtc = String(import.meta.env.SYNCPEER_BUILD_TIME_UTC || "");
  const runtimeEnvironment = detectRuntimeEnvironment();
  const runtimeSurface = detectRuntimeSurface();
  const buildMode = import.meta.env.DEV ? "development" : "production";
  const buildTimeLocalLabel = (() => {
    const parsed = buildTimeUtc ? new Date(buildTimeUtc) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return "unknown";
    return parsed.toLocaleString();
  })();

  let advertisedById = $derived.by(() => new Map(
    advertisedDevices
      .filter((device) => !device.accepted)
      .map((device) => [device.id, device]),
  ));

  let deviceRows = $derived.by(() => {
    const savedRows = app.devices.savedDevices.map((device) => {
      const isConnected = isSavedDeviceConnected(device.id);
      const isLanDetected = isLanDiscoveredDevice(device.id);
      const lanMeta =
        app.devices.lanDiscoveryByDeviceId?.[device.id]?.addresses?.length > 0
          ? `LAN: ${app.devices.lanDiscoveryByDeviceId[device.id].addresses.join(", ")}`
          : "";
      const clientName = String(app.session.remoteDevice?.clientName ?? "").trim();
      const clientVersion = String(app.session.remoteDevice?.clientVersion ?? "").trim();
      const clientLabel = `${clientName} ${clientVersion}`.trim();
      const metaLines = isConnected
        ? [
            clientLabel ? `Client: ${clientLabel}` : "",
            app.session.connectionPath
              ? `Connected via ${app.session.connectionTransport === "relay" ? "relay" : "direct tcp"}: ${app.session.connectionPath}`
              : "",
            lanMeta,
          ].filter((line: string) => line !== "")
        : [lanMeta].filter((line: string) => line !== "");
      return {
        kind: "saved" as const,
        id: `saved:${device.id}`,
        name: device.name,
        deviceId: device.id,
        isConnected,
        isLanDetected,
        isIntroducer: device.isIntroducer === true,
        awaitingApproval: isSavedDeviceAwaitingRemoteApproval(device.id),
        metaLines,
      };
    });

    const connected = savedRows
      .filter((row) => row.isConnected)
      .sort((left, right) => left.name.localeCompare(right.name));
    const savedNotConnected = savedRows
      .filter((row) => !row.isConnected)
      .sort((left, right) => left.name.localeCompare(right.name));

    const notApproved = advertisedDevices
      .filter((device) => !device.accepted)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((device) => ({
        kind: "advertised" as const,
        id: `advertised:${device.id}`,
        name: device.name,
        deviceId: device.id,
        sourceFolderIds: device.sourceFolderIds,
        metaLines: [`Seen in folders: ${device.sourceFolderIds.join(", ")}`],
      }));

    const localCandidates = app.devices.lanAnonymousCandidates.map((candidate) => {
      const firstAddress = String(candidate.addresses?.[0] ?? "");
      const isLocalHost =
        firstAddress.includes("127.0.0.1") || firstAddress.includes("localhost");
      return {
        kind: "local-candidate" as const,
        id: `local-candidate:${candidate.id}`,
        name: isLocalHost ? "Local Syncthing/Peer on this device" : "Local LAN peer candidate",
        deviceId: candidate.id,
        metaLines: [
          candidate.addresses?.length > 0
            ? `Addresses: ${candidate.addresses.join(", ")}`
            : "",
          "No device ID advertised. You can still try direct connect.",
        ].filter((line: string) => line !== ""),
      };
    });

    return [...connected, ...savedNotConnected, ...notApproved, ...localCandidates];
  });

  const addAdvertisedDevice = (deviceId: string) => {
    const match = advertisedById.get(deviceId);
    if (!match) return;
    onApproveAdvertisedDevice(match);
  };
</script>

<Panel title="Devices">
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

  <div class="top-actions">
    <button
      class="ghost small"
      data-testid="connection-settings-toggle"
      onclick={() => {
        app.ui.isSettingsExpanded = !app.ui.isSettingsExpanded;
      }}
      aria-expanded={app.ui.isSettingsExpanded}
    >
      Settings
    </button>
    <button
      class="ghost small"
      data-testid="open-diagnostics"
      onclick={onOpenDiagnosticsPage}
    >Diagnostics</button>
  </div>

  <div class="this-device-summary">
    <div class="item-title-row">
      <span class="item-title">This Device</span>
      {#if app.devices.isLoadingCurrentDeviceId}
        <StatusChip small>loading...</StatusChip>
      {/if}
    </div>
    <div class="item-meta" data-testid="current-device-id">{app.devices.currentDeviceId || "Unavailable"}</div>
    <div class="item-meta">
      Advertised name: {app.connection.deviceName.trim() || "syncpeer-ui"}
    </div>
    <div class="item-meta">
      Version: {appVersion}
    </div>
    <div class="item-meta">
      Commit: <code>{buildCommit}</code>
    </div>
    <div class="item-meta">
      Built (local): {buildTimeLocalLabel}
    </div>
    {#if app.devices.identityNotice}
      <div class="item-meta">{app.devices.identityNotice}</div>
    {/if}
  </div>

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

  {#if app.ui.isSettingsExpanded}
    <div class="settings-block">
      <form
        class="settings"
        onsubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label>
          Discovery Method
          <select data-testid="connection-discovery-mode" bind:value={app.connection.discoveryMode}>
            <option value="global">Global Discovery (default)</option>
            <option value="lan">LAN Discovery</option>
            <option value="direct">Direct Host/Port</option>
          </select>
        </label>

        {#if app.connection.discoveryMode === "global"}
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

        {#if app.connection.discoveryMode === "direct"}
          <label>
            Host
            <input
              data-testid="connection-host"
              type="text"
              bind:value={app.connection.host}
              placeholder="127.0.0.1"
            />
          </label>

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
            Global discovery ignores manual host/port. The official Syncthing
            discovery server pin is applied automatically when you use
            discovery.syncthing.net.
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
            placeholder="Auto uses persisted cli-node cert.pem"
          />
        </label>

        <label>
          TLS Key (optional)
          <input
            data-testid="connection-key"
            type="text"
            bind:value={app.connection.key}
            placeholder="Auto uses persisted cli-node key.pem"
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

        <label class="checkbox-row">
          <input
            type="checkbox"
            bind:checked={app.connection.autoAcceptNewDevices}
          />
          <span>Auto-accept newly advertised devices</span>
        </label>

        <label class="checkbox-row">
          <input
            type="checkbox"
            bind:checked={app.connection.autoAcceptIntroducedFolders}
          />
          <span>Auto-approve folder sync for introduced folders</span>
        </label>

        <div class="hint version-meta">
          Version: <strong>{appVersion}</strong> | Commit: <code>{buildCommit}</code> | Built (local): {buildTimeLocalLabel} | Mode: {buildMode} | Runtime: {runtimeEnvironment}/{runtimeSurface}
        </div>

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
        <button
          type="button"
          class="ghost"
          onclick={onClearAllCache}
          disabled={app.favorites.isClearingCache}
        >
          {app.favorites.isClearingCache ? "Clearing Cache..." : "Clear Cache"}
        </button>
        <button type="button" class="ghost" onclick={onClearOfflineFolderState}>
          Clear Offline Folder State
        </button>
      </div>
    </div>
  {/if}
</Panel>

<Panel title="Add Device">
  <div class="saved-device-editor">
    <label>
      Device ID
      <input
        type="text"
        bind:value={app.devices.newSavedDeviceId}
        placeholder="ABCD123-..."
      />
    </label>
    {#if app.devices.newSavedDeviceId.trim()}
      <p class="hint">
        Saved as <strong
          >{app.devices.newSavedDeviceCustomName.trim() ||
            app.devices.newSavedDeviceId}</strong
        >. We’ll switch to the device’s advertised name after first connection
        unless you set a custom name.
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
      <input
        type="checkbox"
        bind:checked={app.devices.newSavedDeviceIsIntroducer}
      />
      <span>Treat as introducer</span>
    </label>
    <div class="actions">
      <button type="button" class="primary" onclick={onAddSavedDevice}
        >Add Device</button
      >
    </div>
  </div>
</Panel>

<Panel title="Peers">
  <ul class="list">
    {#if app.session.isConnected && !currentSourceIsIntroducer}
      <p class="hint">
        Introductions are only trusted from introducer peers. Mark this
        connected device as introducer to review/accept advertised devices.
      </p>
    {/if}

    {#if deviceRows.length === 0}
      <li class="empty">No peers yet. Add a saved device or wait for introductions.</li>
    {:else}
      {#each deviceRows as row (row.id)}
        <DeviceListItem
          {row}
          disableActions={app.session.isConnecting}
          onUseSavedDevice={onUseSavedDevice}
          onEditSavedDeviceName={onEditSavedDeviceName}
          onSetSavedDeviceIntroducer={onSetSavedDeviceIntroducer}
          onRemoveSavedDevice={onRemoveSavedDevice}
          onAddAdvertisedDevice={addAdvertisedDevice}
          onConnectLocalCandidate={onConnectLocalCandidate}
        />
      {/each}
    {/if}
  </ul>
</Panel>

<Panel title="Session Logs">
  <div class="actions">
    <button type="button" class="ghost" onclick={onCopySessionLogs}
      >Copy Logs</button
    >
  </div>
  <details bind:open={app.ui.isLogPanelExpanded}>
    <summary>View logs ({app.logs.items.length})</summary>
    <ul class="list">
      {#if app.logs.items.length === 0}
        <li class="empty">No session logs yet.</li>
      {:else}
        {#each app.logs.items as item (item.id)}
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
  </details>
</Panel>

<style>
  .status-row {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin-bottom: 0.45rem;
  }

  .top-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }

  .top-actions .small {
    min-height: 30px;
    padding: 0.15rem 0.45rem;
    font-size: 0.8rem;
  }

  .this-device-summary {
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.6rem;
    background: var(--bg-surface);
    margin-bottom: 0.5rem;
  }

  .settings-block {
    margin-top: 0.5rem;
  }

  .version-meta {
    margin-top: 0.35rem;
    line-height: 1.4;
  }

  .saved-device-editor {
    display: grid;
    gap: 0.45rem;
  }

  .settings-divider {
    grid-column: 1 / -1;
    border-top: 1px solid var(--border-default);
    margin: 0.25rem 0;
  }

  .actions {
    display: flex;
    gap: 0.45rem;
    margin-top: 0.45rem;
    flex-wrap: wrap;
  }

  form.settings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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
