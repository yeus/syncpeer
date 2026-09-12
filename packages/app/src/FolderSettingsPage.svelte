<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import type { createDocumentFilesystem } from "@syncpeer/core/filesystem";
  let { onBack, onCreate, onUnlock }: {
    onBack: () => void; onCreate: (label: string) => Promise<void>; onUnlock: () => Promise<void>;
  } = $props();
  let status = $state<Awaited<ReturnType<ReturnType<typeof createDocumentFilesystem>["status"]>> | null>(null);
  let label = $state(""), password = $state(""), error = $state(""), busy = $state(false);
  async function refresh() {
    const reply = await invoke<{ result: NonNullable<typeof status> }>("syncpeer_document_command", { request: { operation: "status" } });
    status = reply.result;
  }
  async function submit(unlock: boolean) {
    busy = true; error = "";
    try {
      if (unlock) {
        await invoke("syncpeer_document_command", { request: { operation: "unlock", password } });
        await onUnlock();
      }
      else { await onCreate(label.trim()); label = ""; }
      await refresh();
    } catch { error = "Folder access failed. Check your password and available storage, then retry."; }
    finally { password = ""; busy = false; }
  }
  onMount(() => { void refresh().catch(() => { error = "Folder storage is unavailable."; }); });
</script>

<main class="panel">
  <button onclick={onBack}>Back</button>
  <h1>Folders</h1>
  <p>Folders stay available offline in Android’s file picker. Only downloaded or locally created files appear there. New downloads use encrypted local storage.</p>
  <p>Existing downloads are copied and verified before switching to encrypted storage. Their original copies remain as backups; those copies have not been encrypted or deleted.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if status?.vault.phase === "locked"}
    <form onsubmit={event => { event.preventDefault(); void submit(true); }}>
      <label>Unlock existing storage <input type="password" bind:value={password} autocomplete="current-password" required /></label>
      <button disabled={busy}>Unlock</button>
    </form>
  {:else if status?.vault.phase === "unlocked"}
    <form onsubmit={event => { event.preventDefault(); void submit(false); }}>
      <label>New folder name <input bind:value={label} required /></label>
      <button disabled={busy || !label.trim()}>Create folder</button>
    </form>
    <p>New folders receive a random password stored securely on this device. Creating a local folder does not automatically share it with another device.</p>
  {/if}
  <ul>{#each status?.folders ?? [] as folder (folder.id)}<li>{folder.label}</li>{/each}</ul>
  {#if status?.vault.issue}<p role="status">{status.vault.issue}</p>{/if}
</main>
