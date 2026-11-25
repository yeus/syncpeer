<script lang="ts">
  import { tick } from "svelte";
  import { peerRegistryViews, sameDeviceId, type AdvertisedDeviceItem, type AdvertisedFolderItem } from "@syncpeer/core/browser";
  import Smartphone from "lucide-svelte/icons/smartphone";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import type { SettingsSection } from "../app/settingsSections.ts";
  import DeviceListItem from "./DeviceListItem.svelte";
  import Panel from "./Panel.svelte";
  import { formatSyncthingDeviceId } from "../app/devicePolicies.ts";
  import { downloadTransportText, type AppState } from "../app/state.ts";

  interface Props {
    app: AppState;
    onOpenSettingsSection: (section: SettingsSection) => void;
    advertisedDevices: AdvertisedDeviceItem[];
    advertisedFolders: AdvertisedFolderItem[];
    isSavedDeviceAwaitingRemoteApproval: (deviceId: string) => boolean;
    isLanDiscoveredDevice: (deviceId: string) => boolean;
    onUseSavedDevice: (deviceId: string) => void;
    onConnectDirectTcp: (deviceId: string) => Promise<void>;
    onCopyCurrentDeviceId: () => void;
    onEditLocalDeviceName: () => void;
    onDiscoverDevices: () => Promise<void>;
    onAddSavedDevice: () => void;
    onApproveAdvertisedDevice: (device: AdvertisedDeviceItem) => void;
    onApproveFolderSync: (folder: AdvertisedFolderItem) => void;
    onRevokeFolderSync: (folder: AdvertisedFolderItem) => void;
    onEditSavedDeviceName: (deviceId: string) => void;
    onSetSavedDeviceIntroducer: (deviceId: string, next: boolean) => void;
    onRemoveSavedDevice: (deviceId: string) => void;
    onPauseConnection?: () => void;
    onResumeConnection?: () => void;
  }

  let {
    app,
    onOpenSettingsSection,
    advertisedDevices,
    advertisedFolders,
    isSavedDeviceAwaitingRemoteApproval,
    isLanDiscoveredDevice,
    onUseSavedDevice,
    onConnectDirectTcp,
    onCopyCurrentDeviceId,
    onEditLocalDeviceName,
    onDiscoverDevices,
    onAddSavedDevice,
    onApproveAdvertisedDevice,
    onApproveFolderSync,
    onRevokeFolderSync,
    onEditSavedDeviceName,
    onSetSavedDeviceIntroducer,
    onRemoveSavedDevice,
    onPauseConnection,
    onResumeConnection,
  }: Props = $props();


  let advertisedById = $derived.by(() => new Map(
    advertisedDevices
      .filter((device) => !device.accepted)
      .map((device) => [device.id, device]),
  ));

  let deviceRows = $derived.by(() => {
    const connectedDeviceId = app.session.isConnected
      ? (app.session.remoteDevice?.id ?? app.connection.remoteId)
      : "";
    const views = peerRegistryViews({
      saved: app.devices.savedDevices,
      discovery: app.devices.peerDiscovery,
      advertised: advertisedDevices,
      connectedDeviceId,
      confirmedDeviceIds: app.devices.confirmedPeerIds,
      awaitingRemoteApproval: app.approvals.remoteApprovalPendingIds,
    });
    const connectingTargetId = app.session.activeConnectDeviceId || (
      app.session.isConnecting || app.session.lifecyclePhase === "connecting" ||
        app.session.lifecyclePhase === "reconnecting"
        ? app.connection.remoteId || app.devices.selectedSavedDeviceId : ""
    );
    const rows = views.map(view => {
      const saved = app.devices.savedDevices.find(device => device.id === view.deviceId);
      const sources = view.sources.map(source => {
        const lastSeen = new Date(source.lastSeenAtMs).toLocaleString();
        if (source.kind === "manual") return { summary: "Manually added", details: [] as string[] };
        if (source.kind === "incoming") return {
          summary: `Incoming request · seen ${lastSeen}`, details: [] as string[],
        };
        if (source.kind === "lan" || source.kind === "verified") return {
          summary: `${source.kind === "verified" ? "Authenticated TCP" : "LAN"} · seen ${lastSeen}`,
          details: (source.addresses ?? []).map(address => `LAN address: ${address}`),
        };
        const origin = app.devices.savedDevices.find(device => device.id === source.sourceDeviceId);
        const via = origin?.name ?? (source.sourceDeviceId?.slice(0, 7) ?? "another peer");
        return {
          summary: `Advertised by ${via} · seen ${lastSeen}`,
          details: (source.folderIds ?? []).map(folderId => `Introduced via folder: ${folderId}`),
        };
      });
      const metaLines = sources.map(source => source.summary);
      const detailLines = sources.flatMap(source => source.details);
      if (view.connected && app.session.connectionPath) {
        metaLines.unshift(`Connected via ${downloadTransportText(app.session.connectionTransport, app.session.connectionScope)}`);
        detailLines.unshift(`Connection path: ${app.session.connectionPath}`);
      }
      if (saved) return {
        kind: "saved" as const, id: view.deviceId, name: view.name,
        confirmed: view.confirmed,
        deviceId: view.deviceId, isConnected: view.connected,
        connectionLabel: view.connected && app.session.connectionTransport === "relay" ? "Connected via relay" : view.connected && app.session.connectionScope === "lan" ? "Connected via LAN" : undefined,
        paused: app.ui.autoConnectPaused && sameDeviceId(app.connection.remoteId, view.deviceId),
        selected: sameDeviceId(app.connection.remoteId, view.deviceId),
        isConnecting: !view.connected && Boolean(connectingTargetId) && sameDeviceId(connectingTargetId, view.deviceId),
        directTcpPreparing: sameDeviceId(app.devices.directTcpPreparingDeviceId, view.deviceId),
        connectError: app.devices.connectionErrors[view.deviceId] ?? "",
        isLanDetected: isLanDiscoveredDevice(view.deviceId),
        isIntroducer: saved.isIntroducer,
        awaitingApproval: isSavedDeviceAwaitingRemoteApproval(view.deviceId), metaLines, detailLines,
      };
      const advertised = advertisedById.get(view.deviceId);
      if (advertised) return {
        kind: "advertised" as const, id: view.deviceId, name: view.name,
        deviceId: view.deviceId, sourceFolderIds: advertised.sourceFolderIds, metaLines, detailLines,
      };
      return { kind: "candidate" as const, id: view.deviceId, name: view.name,
        deviceId: view.deviceId,
        incomingRequest: view.sources.some(source => source.kind === "incoming"),
        metaLines, detailLines };
    });
    const localCandidates = app.devices.lanAnonymousCandidates.map(candidate => ({
      kind: "local-candidate" as const,
      id: `anonymous:${candidate.id}`,
      name: "Unidentified LAN candidate",
      deviceId: candidate.id,
      metaLines: ["A verified Syncthing device ID is required before adding this peer."],
      detailLines: candidate.addresses.map(address => `LAN address: ${address}`),
    }));
    return [...rows, ...localCandidates];
  });

  const connectDirectTcp = async (deviceId: string) => {
    await onConnectDirectTcp(deviceId);
    if (!app.devices.directTcpNotice) return;
    onOpenSettingsSection?.("network");
    await tick();
    const hostInput = document.querySelector<HTMLInputElement>('[data-testid="connection-host"]');
    hostInput?.scrollIntoView({ block: "center" });
    hostInput?.focus();
  };

  const addAdvertisedDevice = (deviceId: string) => {
    const match = advertisedById.get(deviceId);
    if (!match) return;
    onApproveAdvertisedDevice(match);
  };
</script>

<Panel title="Devices">
  <div class="this-device-summary">
    <Smartphone size={28} aria-hidden="true" />
    <div class="device-name">
      <div class="item-title">This device</div>
      <div class="item-meta">{app.connection.deviceName.trim() || "Unnamed device"}</div>
    </div>
    <button class="ghost" onclick={onCopyCurrentDeviceId}>Copy ID</button>
  </div>
  <details class="local-details">
    <summary>This Device Details</summary>
    <p class="item-meta" data-testid="current-device-id">{formatSyncthingDeviceId(app.devices.currentDeviceId) || "Unavailable"}</p>
    <button class="ghost" onclick={onEditLocalDeviceName}>Edit Name</button>
    <button class="ghost" onclick={() => onOpenSettingsSection("security")}>Identity and recovery</button>
    {#if app.devices.identityNotice}<p class="hint">{app.devices.identityNotice}</p>{/if}
  </details>
</Panel>

<Panel title="My peers">
  <button class="primary" data-testid="open-add-device" onclick={() => { app.ui.showAddDevice = !app.ui.showAddDevice; }} aria-expanded={app.ui.showAddDevice}>{app.ui.showAddDevice ? "Cancel" : "+ Add device"}</button>
  {#if app.ui.showAddDevice}
      <div class="saved-device-editor">
    <label>
      Device ID
      <input
        data-testid="new-peer-device-id"
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
    <details><summary>Advanced</summary>
      <label class="checkbox-row"><input type="checkbox" bind:checked={app.devices.newSavedDeviceIsIntroducer} /> Treat as introducer</label>
    </details>
    <div class="actions">
      <button type="button" class="primary" onclick={() => { onAddSavedDevice(); if (!app.devices.newSavedDeviceId) app.ui.showAddDevice = false; }}
        >Add Device</button
      >
    </div>
  </div>
  {/if}
  <ul class="list peer-list">
    {#each deviceRows.filter(row => row.kind === "saved") as row (row.id)}
      <DeviceListItem {row} {onUseSavedDevice} onConnectDirectTcp={connectDirectTcp}
        {onEditSavedDeviceName} {onSetSavedDeviceIntroducer} {onRemoveSavedDevice}
        onAddAdvertisedDevice={addAdvertisedDevice} {onPauseConnection} {onResumeConnection}
        onOpenNetwork={() => onOpenSettingsSection("network")} onOpenDiagnostics={() => onOpenSettingsSection("diagnostics")} />
    {:else}
      <li class="empty">No peers yet. Add a device to get started.</li>
    {/each}
  </ul>
</Panel>

{#if deviceRows.some(row => row.kind === "candidate" && row.incomingRequest)}
<Panel title="Incoming requests">
  <ul class="list peer-list">
    {#each deviceRows.filter(row => row.kind === "candidate" && row.incomingRequest) as row (row.id)}
      <DeviceListItem {row} {onUseSavedDevice} onConnectDirectTcp={connectDirectTcp}
        {onEditSavedDeviceName} {onSetSavedDeviceIntroducer} {onRemoveSavedDevice}
        onAddAdvertisedDevice={addAdvertisedDevice} />
    {/each}
  </ul>
</Panel>
{/if}

<Panel>
  <button class="discovery-toggle ghost" data-testid="discover-devices" onclick={() => { app.ui.showDiscoveredDevices = !app.ui.showDiscoveredDevices; if (app.ui.showDiscoveredDevices) void onDiscoverDevices(); }} aria-expanded={app.ui.showDiscoveredDevices}>
    <span>Discover devices</span>
    <span class="item-meta">{deviceRows.filter(row => row.kind !== "saved" && !(row.kind === "candidate" && row.incomingRequest)).length} available</span>
    <ChevronRight size={16} />
  </button>
  {#if app.ui.showDiscoveredDevices}
    <p class="hint" data-testid="local-discovery-health" role="status">{app.devices.isDiscoveringLanDevices ? "Scanning the local network…" : app.devices.localDiscoveryHealth === "unavailable" ? "LAN discovery unavailable" : "Discovery does not grant access."}</p>
    {#if app.devices.localDiscoveryNotice}<p class="hint" data-testid="local-discovery-notice">{app.devices.localDiscoveryNotice}</p>{/if}
    <ul class="list peer-list">
      {#each deviceRows.filter(row => row.kind !== "saved" && !(row.kind === "candidate" && row.incomingRequest)) as row (row.id)}
        <DeviceListItem {row} {onUseSavedDevice} onConnectDirectTcp={connectDirectTcp}
          {onEditSavedDeviceName} {onSetSavedDeviceIntroducer} {onRemoveSavedDevice}
          onAddAdvertisedDevice={addAdvertisedDevice} />
      {:else}<li class="empty">No new devices discovered.</li>{/each}
    </ul>
  {/if}
</Panel>

{#if advertisedFolders.length}
  <Panel title="Folders offered by introducer">
    <p class="hint">These folders are suggestions only. Nothing is subscribed or made available for browsing until you approve that folder explicitly.</p>
    <ul class="list" data-testid="introduced-folder-offers">
      {#each advertisedFolders as folder (folder.key)}
        <li class="list-item">
          <span>{folder.label}</span>
          {#if folder.syncApproved}
            <span class="hint">Approved</span>
            <button type="button" class="ghost" onclick={() => onRevokeFolderSync(folder)}>Remove approval</button>
          {:else}
            <button type="button" class="ghost" onclick={() => onApproveFolderSync(folder)}>Approve folder</button>
          {/if}
        </li>
      {/each}
    </ul>
  </Panel>
{/if}
<style>
  .this-device-summary { display:flex; align-items:center; gap:0.75rem; padding:0.45rem 0; }
  .device-name { flex:1; min-width:0; }
  .local-details { margin-top:0.35rem; }
  .discovery-toggle { display:flex; width:100%; align-items:center; justify-content:space-between; gap:0.5rem; text-align:left; }
  .peer-list :global(.list-item.peer-layout + .list-item.peer-layout) { border-top:1px solid var(--border-list-divider); }
  .saved-device-editor { display:grid; gap:0.45rem; margin-top:0.75rem; }
  .actions { display:flex; flex-wrap:wrap; gap:0.45rem; }
  label { display:flex; flex-direction:column; gap:0.25rem; }
  .checkbox-row { flex-direction:row; align-items:center; }
</style>
