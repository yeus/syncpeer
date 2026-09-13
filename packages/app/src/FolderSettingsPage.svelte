<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import type { createDocumentFilesystem } from "@syncpeer/core/filesystem";
  let { onBack, onCreate, onUnlock, onUnlockBiometric, onRotateMasterPassword, onMigrate, biometric }: {
    onBack: () => void;
    onCreate: (label: string) => Promise<void>;
    onUnlock: () => Promise<void>;
    onUnlockBiometric: () => Promise<void>;
    onRotateMasterPassword: (password: string) => Promise<void>;
    onMigrate: (folderId: string, target: "encrypted" | "plaintext") => Promise<void>;
    biometric?: {
      status: () => Promise<{ available: boolean; enabled: boolean }>;
      setEnabled: (enabled: boolean) => Promise<{ available: boolean; enabled: boolean }>;
      authenticate: () => Promise<boolean>;
    };
  } = $props();
  let status = $state<Awaited<ReturnType<ReturnType<typeof createDocumentFilesystem>["status"]>> | null>(null);
  let label = $state(""), password = $state(""), masterPassword = $state(""), error = $state(""), busy = $state(false), migrating = $state("");
  let biometricState = $state<{ available: boolean; enabled: boolean } | null>(null);
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
  async function saveMasterPassword() {
    if (!masterPassword) return;
    busy = true; error = "";
    try { await onRotateMasterPassword(masterPassword); masterPassword = ""; await refresh(); }
    catch { error = "Master password could not be changed."; }
    finally { busy = false; }
  }
  async function toggleBiometric() {
    if (!biometric || !biometricState) return;
    busy = true; error = "";
    try {
      const next = await biometric.setEnabled(!biometricState.enabled);
      if (next.enabled) {
        try { await biometric.authenticate(); }
        catch (error) {
          await biometric.setEnabled(false);
          throw error;
        }
      }
      biometricState = next;
    } catch {
      biometricState = await biometric.status().catch(() => biometricState);
      error = "Biometric unlock could not be enabled. Check that a device lock or enrolled biometric is available.";
    }
    finally { busy = false; }
  }
  async function migrate(folderId: string, target: "encrypted" | "plaintext") {
    migrating = folderId; error = "";
    try { await onMigrate(folderId, target); await refresh(); }
    catch { error = "Folder migration was not completed. Existing data was retained; check the password and available storage, then retry."; }
    finally { migrating = ""; }
  }
  onMount(() => {
    void refresh().catch(() => { error = "Folder storage is unavailable."; });
    void biometric?.status().then(value => { biometricState = value; }).catch(() => {});
  });
</script>

<main class="panel">
  <button onclick={onBack}>Back</button>
  <h1>Folders</h1>
  <p>Folders stay available offline in Android’s file picker. Only downloaded or locally created files appear there. New downloads use encrypted local storage.</p>
  <p>Existing downloads are copied and verified before switching to encrypted storage. The old copy is removed only after verification succeeds.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if status?.vault.phase === "locked"}
    <form onsubmit={event => { event.preventDefault(); void submit(true); }}>
      <label>Unlock existing storage <input type="password" bind:value={password} autocomplete="current-password" required /></label>
      <button disabled={busy}>Unlock</button>
    </form>
    {#if biometricState?.available && biometricState.enabled}
      <button disabled={busy} onclick={() => { busy = true; error = ""; void onUnlockBiometric().then(refresh).catch(() => { error = "Biometric unlock was not completed."; }).finally(() => { busy = false; }); }}>
        Unlock with biometrics
      </button>
    {/if}
  {:else if status?.vault.phase === "unlocked"}
    <form onsubmit={event => { event.preventDefault(); void submit(false); }}>
      <label>New folder name <input bind:value={label} required /></label>
      <button disabled={busy || !label.trim()}>Create folder</button>
    </form>
    <p>New folders receive a random password stored securely on this device. Creating a local folder does not automatically share it with another device.</p>
    <form onsubmit={event => { event.preventDefault(); void saveMasterPassword(); }}>
      <label>Set local master password <input type="password" bind:value={masterPassword} autocomplete="new-password" required /></label>
      <button disabled={busy || !masterPassword}>Save master password</button>
    </form>
    {#if biometricState}
      <p>Biometric unlock is {biometricState.enabled ? "enabled" : "disabled"}.</p>
      <button disabled={busy || !biometricState.available} onclick={() => void toggleBiometric()}>
        {biometricState.enabled ? "Disable biometric unlock" : "Enable biometric unlock"}
      </button>
    {/if}
  {/if}
  <ul>{#each status?.folders ?? [] as folder (folder.id)}
    <li>
      <span>{folder.label}</span>
      {#if status?.vault.phase === "unlocked"}
        {#if folder.downloads}
          <button disabled={busy || migrating === folder.id} onclick={() => void migrate(folder.id, "plaintext")}>Move to plaintext storage</button>
        {:else}
          <button disabled={busy || migrating === folder.id} onclick={() => void migrate(folder.id, "encrypted")}>Use encrypted storage</button>
        {/if}
      {/if}
    </li>
  {/each}</ul>
  {#if status?.vault.issue}<p role="status">{status.vault.issue}</p>{/if}
</main>
