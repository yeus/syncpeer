<script lang="ts">
  import type { Snippet } from "svelte";
  import ListRow from "./ListRow.svelte";
  import StatusChip from "./StatusChip.svelte";

  interface Badge {
    label: string;
    tone?: "online" | "offline" | "";
    small?: boolean;
    title?: string;
  }

  interface Props {
    title: string;
    titleTooltip?: string;
    metaLines?: string[];
    badges?: Badge[];
    onTitleClick?: (() => void) | undefined;
    titleDisabled?: boolean;
    children?: Snippet;
    actions?: Snippet;
  }

  let {
    title,
    titleTooltip = "",
    metaLines = [],
    badges = [],
    onTitleClick = undefined,
    titleDisabled = false,
    children,
    actions,
  }: Props = $props();
</script>

<ListRow>
  <div class="item-title-row">
    {#if onTitleClick}
      <button class="item-title" onclick={onTitleClick} disabled={titleDisabled} title={titleTooltip}>
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
