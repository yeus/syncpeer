<script lang="ts">
  import type { DocumentVersionRecord } from "@syncpeer/core/browser";

  let { name, items, loading, restoringId, error, onBack, onRestore }: {
    name: string;
    items: DocumentVersionRecord[];
    loading: boolean;
    restoringId: string;
    error: string;
    onBack: () => void;
    onRestore: (versionId: string) => void;
  } = $props();

  const size = (bytes: number) => bytes < 1024 ? `${bytes} B` :
    bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
</script>

<main class="settings-page">
  <button onclick={onBack}>Back</button>
  <h1>Versions</h1>
  <p>{name}</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if loading}
    <p>Loading version history…</p>
  {:else if items.length === 0}
    <p>No retained versions are available on this device.</p>
  {:else}
    <ul>
      {#each items as version (version.id)}
        <li>
          <span>{new Date(version.modifiedMs).toLocaleString()} · {size(version.sizeBytes)}</span>
          <button disabled={Boolean(restoringId)} onclick={() => onRestore(version.id)}>
            {restoringId === version.id ? "Restoring…" : "Restore"}
          </button>
        </li>
      {/each}
    </ul>
    <p>Restoring keeps the current contents in history and publishes the selected bytes as a new change.</p>
  {/if}
</main>

<style>
  p { overflow-wrap: anywhere; }
  ul { margin: 0; list-style: none; padding: 0; display: grid; gap: 0.5rem; }
  li { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 0.65rem; background: var(--bg-surface); border-radius: var(--radius-sm); flex-wrap: wrap; }
</style>
