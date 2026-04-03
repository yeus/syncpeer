<script lang="ts">
  import Plus from "lucide-svelte/icons/plus";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import ListRow from "./ListRow.svelte";
  import StatusChip from "./StatusChip.svelte";

  export interface SavedDeviceRow {
    kind: "saved";
    id: string;
    name: string;
    deviceId: string;
    isConnected: boolean;
    isIntroducer: boolean;
    awaitingApproval: boolean;
    metaLines: string[];
  }

  export interface AdvertisedDeviceRow {
    kind: "advertised";
    id: string;
    name: string;
    deviceId: string;
    sourceFolderIds: string[];
    metaLines: string[];
  }

  export type DeviceListRow = SavedDeviceRow | AdvertisedDeviceRow;

  interface Props {
    row: DeviceListRow;
    disableActions?: boolean;
    onUseSavedDevice: (deviceId: string) => void;
    onEditSavedDeviceName: (deviceId: string) => void;
    onSetSavedDeviceIntroducer: (deviceId: string, next: boolean) => void;
    onRemoveSavedDevice: (deviceId: string) => void;
    onAddAdvertisedDevice: (deviceId: string) => void;
  }

  let {
    row,
    disableActions = false,
    onUseSavedDevice,
    onEditSavedDeviceName,
    onSetSavedDeviceIntroducer,
    onRemoveSavedDevice,
    onAddAdvertisedDevice,
  }: Props = $props();
</script>

<ListRow>
  <div class="item-title-row">
    <div class="item-title">{row.name}</div>

    {#if row.kind === "saved" && row.isIntroducer}
      <StatusChip small>introducer</StatusChip>
    {/if}
    {#if row.kind === "saved" && row.isConnected}
      <StatusChip tone="online" small>online</StatusChip>
    {/if}
    {#if row.kind === "saved" && row.awaitingApproval}
      <StatusChip tone="offline" small title="This peer may still need to approve your device on their Syncthing side.">
        not approved yet
      </StatusChip>
    {/if}
    {#if row.kind === "advertised"}
      <StatusChip tone="offline" small>not approved</StatusChip>
    {/if}
  </div>

  <div class="item-meta">{row.deviceId}</div>

  {#each row.metaLines as line, index (index)}
    {#if line}
      <div class="item-meta">{line}</div>
    {/if}
  {/each}

  <svelte:fragment slot="actions">
    {#if row.kind === "saved"}
      <button
        class="primary"
        onclick={() => onUseSavedDevice(row.deviceId)}
        disabled={disableActions}
      >
        Use
      </button>
      <button
        class="ghost"
        onclick={() => onEditSavedDeviceName(row.deviceId)}
      >
        Edit
      </button>
      <button
        class="ghost"
        onclick={() => onSetSavedDeviceIntroducer(row.deviceId, !row.isIntroducer)}
      >
        {row.isIntroducer ? "Intro On" : "Intro Off"}
      </button>
      <button
        class="icon icon-only"
        onclick={() => onRemoveSavedDevice(row.deviceId)}
        aria-label="Remove saved device"
      >
        <Trash2 size={16} />
      </button>
    {:else}
      <button
        class="primary icon icon-only"
        onclick={() => onAddAdvertisedDevice(row.deviceId)}
        aria-label="Add advertised device"
        title="Add advertised device"
      >
        <Plus size={16} />
      </button>
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
</style>
