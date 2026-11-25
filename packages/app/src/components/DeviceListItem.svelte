<script lang="ts">
  import MonitorSmartphone from "lucide-svelte/icons/monitor-smartphone";
  import Plus from "lucide-svelte/icons/plus";
  import ListRow from "./ListRow.svelte";
  import StatusChip from "./StatusChip.svelte";
  import { formatSyncthingDeviceId } from "../app/devicePolicies.ts";
  import { savedPeerUiState } from "../app/connectionNotices.ts";

export interface SavedDeviceRow {
    kind: "saved";
    id: string;
    name: string;
    deviceId: string;
    connectionLabel?: string;
    paused?: boolean;
    selected?: boolean;
    isConnected: boolean;
    isConnecting: boolean;
    directTcpPreparing: boolean;
    connectError: string;
    confirmed: boolean;
    isLanDetected: boolean;
    isIntroducer: boolean;
    awaitingApproval: boolean;
    metaLines: string[];
    detailLines: string[];
  }

  export interface AdvertisedDeviceRow {
    kind: "advertised";
    id: string;
    name: string;
    deviceId: string;
    sourceFolderIds: string[];
    metaLines: string[];
    detailLines: string[];
  }

  export interface LocalCandidateRow {
    kind: "local-candidate";
    id: string;
    name: string;
    deviceId: string;
    metaLines: string[];
    detailLines: string[];
  }

  export interface LanDiscoveredRow {
    kind: "candidate";
    id: string;
    name: string;
    deviceId: string;
    incomingRequest: boolean;
    metaLines: string[];
    detailLines: string[];
  }

  export type DeviceListRow = SavedDeviceRow | AdvertisedDeviceRow | LocalCandidateRow | LanDiscoveredRow;

  interface Props {
    row: DeviceListRow;
    onUseSavedDevice: (deviceId: string) => void;
    onConnectDirectTcp: (deviceId: string) => Promise<void>;
    onEditSavedDeviceName: (deviceId: string) => void;
    onSetSavedDeviceIntroducer: (deviceId: string, next: boolean) => void;
    onRemoveSavedDevice: (deviceId: string) => void;
    onPauseConnection?: () => void;
    onResumeConnection?: () => void;
    onOpenNetwork?: () => void;
    onOpenDiagnostics?: () => void;
    onAddAdvertisedDevice: (deviceId: string) => void;
  }

  let {
    row,
    onUseSavedDevice,
    onConnectDirectTcp,
    onEditSavedDeviceName,
    onSetSavedDeviceIntroducer,
    onRemoveSavedDevice,
    onPauseConnection, onResumeConnection, onOpenNetwork, onOpenDiagnostics,
    onAddAdvertisedDevice,
  }: Props = $props();
  let peerUi = $derived(row.kind === "saved" ? savedPeerUiState(row) : null);
</script>

<ListRow peerLayout>
  <span hidden data-saved-peer-id={row.kind === "saved" ? row.deviceId : undefined} data-selected-peer={row.kind === "saved" && row.selected ? row.deviceId : undefined}></span>
  <div class="item-title-row">
    <MonitorSmartphone size={22} aria-hidden="true" />
    <div class="item-name-wrap"><div class="item-title">{row.name}</div></div>
    {#if row.kind === "saved" && peerUi}
      <StatusChip tone={peerUi.tone} small>{row.paused ? "Paused" : row.connectionLabel ?? (row.connectError && row.confirmed && !row.isConnected && !row.isConnecting ? "Connection error" : peerUi.label)}</StatusChip>
    {:else if row.kind === "candidate" && row.incomingRequest}
      <StatusChip small>Approval requested</StatusChip>
    {:else if row.kind === "advertised"}
      <StatusChip small>Not approved</StatusChip>
    {/if}
  </div>

  {#if row.kind === "saved" && !row.confirmed}
    <div class="item-meta" data-testid="peer-first-connection-guidance">Added locally. Approve this device on the other peer.</div>
  {/if}
  <details class="peer-details">
    <summary>Device details</summary>
    <div class="peer-detail-content">
      <div class="item-meta peer-id-full">{formatSyncthingDeviceId(row.deviceId)}</div>
      {#if row.kind === "saved"}
        {#if row.connectError && !row.isConnected}<div class="item-meta" role="alert">{row.connectError}</div>{/if}
        <div class="peer-actions">
          {#if row.isConnected}<button class="ghost" onclick={() => onUseSavedDevice(row.deviceId)}>Reconnect</button>{/if}
          {#if row.selected && onPauseConnection && onResumeConnection}<button class="ghost" onclick={row.paused ? onResumeConnection : onPauseConnection}>{row.paused ? "Resume synchronization" : "Pause synchronization"}</button>{/if}
          <button class="ghost" aria-label="Edit saved device name" onclick={() => onEditSavedDeviceName(row.deviceId)}>Rename</button>
          <button class="ghost" data-testid="peer-direct-tcp" disabled={row.directTcpPreparing}
            onclick={() => { void onConnectDirectTcp(row.deviceId); }}>{row.directTcpPreparing ? "Finding LAN address…" : "Direct TCP"}</button>
          <button class="ghost" onclick={() => onSetSavedDeviceIntroducer(row.deviceId, !row.isIntroducer)}>{row.isIntroducer ? "Introducer (review)" : "Mark introducer"}</button>
          {#if onOpenNetwork && row.selected}<button class="ghost" onclick={onOpenNetwork}>Connection settings</button>{/if}
          {#if onOpenDiagnostics}<button class="ghost" onclick={onOpenDiagnostics}>Troubleshoot connection</button>{/if}
          <button class="ghost" aria-label="Remove saved device" onclick={() => onRemoveSavedDevice(row.deviceId)}>Remove device</button>
        </div>
      {/if}
      {#each [...row.metaLines, ...row.detailLines] as line, index (index)}
        <div class="item-meta">{line}</div>
      {/each}
    </div>
  </details>

  <svelte:fragment slot="actions">
    {#if row.kind === "candidate" || (row.kind === "saved" && !row.isConnected && !row.paused && peerUi?.canConnect)}
      <button
        class="primary"
        onclick={() => onUseSavedDevice(row.deviceId)}
      >
        {row.kind === "candidate" ? row.incomingRequest ? "Approve peer" : "Add peer" : "Connect"}
      </button>
    {/if}
    {#if row.kind === "saved"}
      <!-- Advanced peer controls are in the disclosure above. -->
    {:else if row.kind === "advertised"}
      <button
        class="primary icon icon-only"
        onclick={() => onAddAdvertisedDevice(row.deviceId)}
        aria-label="Add advertised device"
        title="Add advertised device"
      >
        <Plus size={16} />
      </button>
    {:else}
      <!-- An anonymous LAN endpoint is not a verifiable Syncthing peer identity. -->
    {/if}
  </svelte:fragment>
</ListRow>

<style>
  .peer-actions { display:flex; flex-wrap:wrap; gap:0.4rem; margin:0.45rem 0; }
  .item-title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .item-name-wrap {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    min-width: 0;
  }


  .peer-details {
    margin-top: 0.35rem;
    min-width: 0;
  }

  .peer-details summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 0.79rem;
    padding: 0.3rem 0;
    min-height: 32px;
  }

  .peer-detail-content {
    margin-top: 0.3rem;
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .peer-detail-content .item-meta {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .peer-id-full {
    font-family: var(--font-mono);
  }


</style>
