<script lang="ts">
  import Pencil from "lucide-svelte/icons/pencil";
  import Plus from "lucide-svelte/icons/plus";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import ListRow from "./ListRow.svelte";
  import StatusChip from "./StatusChip.svelte";
  import { formatSyncthingDeviceId } from "../app/devicePolicies.ts";
  import { savedPeerUiState } from "../app/connectionNotices.ts";

export interface SavedDeviceRow {
    kind: "saved";
    id: string;
    name: string;
    deviceId: string;
    isConnected: boolean;
    isConnecting: boolean;
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
    onEditSavedDeviceName: (deviceId: string) => void;
    onSetSavedDeviceIntroducer: (deviceId: string, next: boolean) => void;
    onRemoveSavedDevice: (deviceId: string) => void;
    onAddAdvertisedDevice: (deviceId: string) => void;
  }

  let {
    row,
    onUseSavedDevice,
    onEditSavedDeviceName,
    onSetSavedDeviceIntroducer,
    onRemoveSavedDevice,
    onAddAdvertisedDevice,
  }: Props = $props();
  let peerUi = $derived(row.kind === "saved" ? savedPeerUiState(row) : null);
</script>

<ListRow peerLayout>
  <div class="item-title-row">
    <div class="item-name-wrap">
      <div class="item-title">{row.name}</div>
      {#if row.kind === "saved"}
        <button
          class="name-edit-button"
          onclick={() => onEditSavedDeviceName(row.deviceId)}
          aria-label="Edit saved device name"
          title="Edit device name"
        >
          <Pencil size={12} />
        </button>
      {/if}
    </div>

    {#if row.kind === "saved" && row.isIntroducer}
      <StatusChip small>introducer</StatusChip>
    {/if}
    {#if row.kind === "saved" && peerUi}
      <StatusChip tone={row.isConnected ? "online" : "offline"} small
        title={!row.confirmed ? "No successful connection yet. Remote approval may still be required; check the other device." : undefined}>
        {peerUi.label}
      </StatusChip>
    {/if}
    {#if row.kind === "saved" && row.isLanDetected}
      <StatusChip small>lan</StatusChip>
    {/if}
    {#if row.kind === "saved" && row.connectError && !row.isConnected}
      <StatusChip tone="offline" small>connection error</StatusChip>
    {/if}
    {#if row.kind === "advertised"}
      <StatusChip tone="offline" small>not approved</StatusChip>
    {/if}
    {#if row.kind === "candidate" && row.incomingRequest}
      <StatusChip tone="offline" small>approval requested</StatusChip>
    {:else if row.kind === "candidate" || row.kind === "local-candidate"}
      <StatusChip small>{row.kind === "candidate" ? "discovered" : "unidentified"}</StatusChip>
    {/if}
  </div>

  {#if row.kind === "saved" && !row.confirmed}
    <div class="item-meta" data-testid="peer-first-connection-guidance">
      Added locally. On the other device, add this device's ID or approve its incoming request.
      {#if row.isConnecting} Connection attempt in progress; remote approval is not yet confirmed.{:else} A connection request may not have reached the other device yet.{/if}
    </div>
  {/if}
  {#if row.kind === "saved" && row.connectError && !row.isConnected}
    <div class="item-meta" role="alert">{row.connectError}</div>
  {/if}
  <div class="item-meta peer-id-summary" title={formatSyncthingDeviceId(row.deviceId)}>
    ID: {row.deviceId.length === 52 ? `${row.deviceId.slice(0, 7)}…${row.deviceId.slice(-7)}` : row.deviceId}
  </div>

  {#each row.metaLines as line, index (index)}
    {#if line}
      <div class="item-meta">{line}</div>
    {/if}
  {/each}
  <details class="peer-details">
    <summary>Device ID and connection details</summary>
    <div class="peer-detail-content">
      <div class="item-meta peer-id-full">{formatSyncthingDeviceId(row.deviceId)}</div>
      {#each row.detailLines as line, index (index)}
        <div class="item-meta">{line}</div>
      {/each}
    </div>
  </details>

  <svelte:fragment slot="actions">
    {#if row.kind === "candidate" || (row.kind === "saved" && peerUi?.canConnect)}
      <button
        class="primary"
        onclick={() => onUseSavedDevice(row.deviceId)}
      >
        {row.kind === "candidate" ? row.incomingRequest ? "Approve peer" : "Add peer" : row.isConnected ? "Reconnect" : "Connect"}
      </button>
      {#if row.kind === "saved"}
        <button
          class="ghost"
          onclick={() => onSetSavedDeviceIntroducer(row.deviceId, !row.isIntroducer)}
        >
          {row.isIntroducer ? "Introducer (review)" : "Mark introducer"}
        </button>
        <button
          class="icon icon-only"
          onclick={() => onRemoveSavedDevice(row.deviceId)}
          aria-label="Remove saved device"
        >
          <Trash2 size={16} />
        </button>
      {/if}
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

  .peer-id-summary {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    margin: 0.25rem 0;
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

  .name-edit-button {
    border: none;
    background: transparent;
    min-height: 1rem;
    width: 1rem;
    min-width: 1rem;
    padding: 0;
    color: var(--text-muted);
    border-radius: var(--radius-xs);
  }

  .name-edit-button:hover:not(:disabled) {
    border-color: transparent;
    background: var(--button-hover-bg);
  }
  @media (pointer: coarse) {
    .name-edit-button { min-width: 44px; min-height: 44px; }
  }
</style>
