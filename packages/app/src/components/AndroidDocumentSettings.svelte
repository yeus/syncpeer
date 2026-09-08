<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import type { createDocumentFilesystem } from "@syncpeer/core/filesystem";
  let { folders, onConnectFolder }: {
    folders: Array<{ id: string; label?: string }>;
    onConnectFolder: (folder: { id: string; label: string; password?: string }) => Promise<void>;
  } = $props();

  let status = $state<Awaited<ReturnType<ReturnType<typeof createDocumentFilesystem>["status"]>> | null>(null);
  let busy = $state(false), error = $state("");
  let password = $state(""), defaultPassword = $state(""), folderPassword = $state(""), folderId = $state(""), folderLabel = $state("");
  async function command(request: Record<string, unknown>) {
    if (busy) return;
    busy = true; error = "";
    try {
      if (request.operation === "connectFolder") {
        await onConnectFolder({ id: folderId, label: folderLabel || folders.find(folder => folder.id === folderId)?.label || folderId,
          ...(folderPassword ? { password: folderPassword } : {}) });
      } else await invoke("syncpeer_document_command", { request });
      const reply = await invoke<{ result: NonNullable<typeof status> }>("syncpeer_document_command", { request: { operation: "status" } });
      if (!reply?.result?.vault?.phase || !Array.isArray(reply.result.folders)) throw new Error("Invalid document status.");
      status = reply.result;
    } catch (failure) { error = failure instanceof Error ? failure.message : "Document access failed. Check your password and update Android System WebView if needed."; }
    finally { password = ""; defaultPassword = ""; folderPassword = ""; busy = false; }
  }
</script>

<section aria-label="Android document vault" data-testid="document-vault-settings">
  <h3>Encrypted documents</h3>
  <p>Experimental encrypted folders available through Android’s file picker. Connect a download folder to use the same files in Syncpeer and other apps. Starred-file updates continue through Syncpeer while it is running; this does not enable whole-folder or background peer synchronization.</p>
  <p>Android Keystore remembers your unlock secret. Automatic unlock is available after the first device unlock following a reboot. Locking here keeps the vault locked until you enter its password.</p>
  <button data-testid="document-vault-status" disabled={busy} onclick={() => command({ operation: "status" })}>Check document vault</button>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if status}
    <p data-testid="document-vault-phase">Vault: {status.vault.phase}{status.vault.remembered ? " · Unlock remembered" : ""}</p>
    {#if status.vault.issue}<p role="status">{status.vault.issue}</p>{/if}
    {#each status.recoveryIssues ?? [] as issue, index (index)}<p role="status">{issue}</p>{/each}
    {#if status.vault.phase === "uninitialized" || status.vault.phase === "locked"}
      <form onsubmit={event => { event.preventDefault(); void command({ operation: status?.vault.phase === "uninitialized" ? "createVault" : "unlock", password }); }}>
        <label>Vault password <input type="password" required bind:value={password} autocomplete={status.vault.phase === "uninitialized" ? "new-password" : "current-password"} /></label>
        <button disabled={busy}>{status.vault.phase === "uninitialized" ? "Create vault" : "Unlock"}</button>
      </form>
    {:else if status.vault.phase === "unlocked"}
      <button disabled={busy} onclick={() => command({ operation: "lock" })}>Lock vault</button>
      <form onsubmit={event => { event.preventDefault(); void command({ operation: "setDefaultPassword", password: defaultPassword }); }}>
        <label>Default folder password <input type="password" required bind:value={defaultPassword} autocomplete="new-password" /></label>
        <button disabled={busy}>Set default for new folders</button>
      </form>
      <form onsubmit={event => { event.preventDefault(); void command({ operation: "register", id: folderId, label: folderLabel, ...(folderPassword ? { password: folderPassword } : {}) }); }}>
        <label>Existing sync folder <select data-testid="document-existing-folder" onchange={event => {
          folderId = event.currentTarget.value;
          folderLabel = folders.find(folder => folder.id === folderId)?.label || folderId;
        }}><option value="">Choose a folder or enter its ID below</option>{#each folders as folder (folder.id)}<option value={folder.id}>{folder.label || folder.id}</option>{/each}</select></label>
        <label>Folder ID <input required bind:value={folderId} /></label>
        <label>Folder label <input required bind:value={folderLabel} /></label>
        <label>Folder password (blank uses default) <input type="password" bind:value={folderPassword} autocomplete="new-password" /></label>
        <button disabled={busy}>Register encrypted folder</button>
        <button type="button" data-testid="document-connect-folder" disabled={busy || !folderId.trim()}
          onclick={() => command({ operation: "connectFolder" })}>Connect downloads and verify existing files</button>
      </form>
      <p>Connecting is an explicit migration: existing copies are preserved as inactive backups. New downloads and picker edits use encrypted storage only. Wait for transfers to finish first. External plaintext folders are not moved automatically.</p>
      <ul>{#each status.folders as folder (folder.id)}<li>{folder.label}{folder.downloads ? " · Downloads connected" : " · Local only"}</li>{/each}</ul>
    {/if}
  {/if}
</section>
