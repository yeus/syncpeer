<script lang="ts">
  import type { BreadcrumbSegment } from "@syncpeer/core/browser";

  interface Props {
    currentFolderId: string;
    segments: BreadcrumbSegment[];
    onRoot: () => void;
    onSelect: (segment: BreadcrumbSegment) => void;
  }

  let { currentFolderId, segments, onRoot, onSelect }: Props = $props();
</script>

<div class="breadcrumbs">
  {#if !currentFolderId}
    <span class="crumb-current">All Syncthing Folders</span>
  {:else}
    <button class="crumb-button" onclick={onRoot}>All Syncthing Folders</button>
    <span class="crumb-separator">&gt;</span>
    {#each segments as segment, index (segment.key)}
      {#if index < segments.length - 1}
        {#if segment.ellipsis}
          <span class="crumb-current">...</span>
        {:else}
          <button class="crumb-button" onclick={() => onSelect(segment)}>
            {segment.label}
          </button>
        {/if}
        <span class="crumb-separator">&gt;</span>
      {:else}
        <span class="crumb-current">{segment.label}</span>
      {/if}
    {/each}
  {/if}
</div>
