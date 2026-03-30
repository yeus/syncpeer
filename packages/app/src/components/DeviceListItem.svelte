<script lang="ts">
  import type { Snippet } from "svelte";
  import ListRow from "./ListRow.svelte";
  import StatusChip from "./StatusChip.svelte";

  export interface DeviceListItemBadge {
    label: string;
    tone?: "online" | "offline" | "";
    small?: boolean;
    title?: string;
  }

  interface Props {
    title: string;
    titleTooltip?: string;
    deviceId?: string;
    metaLines?: string[];
    badges?: DeviceListItemBadge[];
    onTitleClick?: (() => void) | undefined;
    children?: Snippet;
    actions?: Snippet;
  }

  let {
    title,
    titleTooltip = "",
    deviceId = "",
    metaLines = [],
    badges = [],
    onTitleClick = undefined,
    children,
    actions,
  }: Props = $props();
</script>

<ListRow>
  <div class="item-title-row">
    {#if onTitleClick}
      <button class="item-title" onclick={onTitleClick} title={titleTooltip}>
        {title}
      </button>
    {:else}
      <div class="item-title" title={titleTooltip}>{title}</div>
    {/if}

    {#each badges as badge, index (index)}
      <StatusChip tone={badge.tone ?? ""} small={badge.small ?? true} title={badge.title ?? ""}>
        {badge.label}
      </StatusChip>
    {/each}
  </div>

  {#if deviceId}
    <div class="item-meta">{deviceId}</div>
  {/if}

  {#each metaLines as line, index (index)}
    {#if line}
      <div class="item-meta">{line}</div>
    {/if}
  {/each}

  {@render children?.()}

  <svelte:fragment slot="actions">
    {@render actions?.()}
  </svelte:fragment>
</ListRow>
