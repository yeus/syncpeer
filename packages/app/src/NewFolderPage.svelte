<script lang="ts">
  import { onMount } from "svelte";
  let { onBack, onOpenGeneralSettings, onCreate, command }: {
    onBack: () => void;
    onOpenGeneralSettings: () => void;
    onCreate: (label: string) => Promise<void>;
    command: <T>(request: Record<string, unknown>) => Promise<T>;
  } = $props();
  let label = $state(""), error = $state(""), busy = $state(false);
  let phase = $state<string | null>(null);
  async function createFolder() {
    busy = true; error = "";
    try { await onCreate(label.trim()); onBack(); }
    catch { error = "Folder creation failed. Check available storage and retry."; }
    finally { busy = false; }
  }
  onMount(() => {
    void command<{ vault: { phase: string } }>({ operation: "status" })
      .then(status => { phase = status.vault.phase; })
      .catch(() => { error = "Folder storage is unavailable."; });
  });
</script>

<main class="panel" data-testid="new-folder-page">
  <button onclick={onBack}>Back</button>
  <h1>New folder</h1>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if phase === "unlocked"}
    <form onsubmit={event => { event.preventDefault(); void createFolder(); }}>
      <label>New folder name <input bind:value={label} required /></label>
      <button disabled={busy || !label.trim()}>Create folder</button>
    </form>
    <p>New folders use encrypted local storage. Approved devices receive the folder credential through your personal space.</p>
  {:else if phase}
    <p>Unlock or create your personal space in general settings before creating a folder.</p>
    <button onclick={onOpenGeneralSettings}>Open general settings</button>
  {/if}
</main>
