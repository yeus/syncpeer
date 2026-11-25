<script lang="ts">
  import type { BreadcrumbSegment } from "@syncpeer/core/browser";
  import ArrowLeft from "lucide-svelte/icons/arrow-left";

  interface Props {
    currentFolderId: string;
    segments: BreadcrumbSegment[];
    onRoot: () => void;
    onSelect: (segment: BreadcrumbSegment) => void;
  }

  let { currentFolderId, segments, onRoot, onSelect }: Props = $props();
</script>

{#if currentFolderId}
<div class="breadcrumbs">
    <button class="crumb-button" data-testid="folder-root-back" aria-label="Back to shared folders" title="Back to shared folders" onclick={onRoot}><ArrowLeft size={18} /></button>
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
</div>
{/if}

<style>
  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.5rem;
    min-width: 0;
  }
</style>
