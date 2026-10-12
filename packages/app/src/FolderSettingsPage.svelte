<script lang="ts">
  import { onMount } from "svelte";
  import { defaultFolderSettings, type PersonalSpaceSettings, type SyncpeerProfileSettings } from "@syncpeer/core/browser";
  import type { createDocumentFilesystem } from "@syncpeer/core/filesystem";
  import { safeNativeFailureText } from "./app/storageErrors.ts";
  let { folderId, folderLabel, encrypted, passwordDraft, passwordSaved, passwordError, actionError,
    managedStorage, onBack, onOpenGeneralSettings, onUpdatePassword, onSavePassword, onClearPassword,
    onImport, peerId, onMigrate, onRelease, onSettingsSaved, command }: {
    folderId: string;
    folderLabel: string;
    encrypted: boolean;
    passwordDraft: string;
    passwordSaved: string;
    passwordError: string;
    actionError: string;
    managedStorage: boolean;
    onBack: () => void;
    onOpenGeneralSettings: () => void;
    onUpdatePassword: (folderId: string, password: string) => void;
    onSavePassword: (folderId: string) => Promise<void>;
    onClearPassword: (folderId: string) => Promise<void>;
    onImport: (peerId: string, folderId: string, password: string) => Promise<void>;
    peerId: string;
    onMigrate: (folderId: string, target: "encrypted" | "plaintext") => Promise<void>;
    onRelease: (folderId: string, mode: "safe" | "dangerous", confirmedText: string) => Promise<void>;
    onSettingsSaved: (settings: SyncpeerProfileSettings) => void;
    command: <T>(request: Record<string, unknown>) => Promise<T>;
  } = $props();
  let status = $state<Awaited<ReturnType<ReturnType<typeof createDocumentFilesystem>["status"]>> | null>(null);
  let error = $state(""), busy = $state(false), migrating = $state("");
  let settings = $state<SyncpeerProfileSettings | null>(null);
  let sharedSettings = $state<PersonalSpaceSettings | null>(null);
  let sharedConflicts = $state<Array<{ path: string[]; heads: string[];
    changes: Array<{ id: string; deviceId: string; value?: unknown; deleted?: true }> }>>([]);
  let trustedDevices = $state<Array<{ id: string; syncthingId: string; state: "active" | "revoked" }>>([]);
  let localTrustedDeviceId = $state<string | null>(null);
  let newHolderId = $state("");
  let newHolderKind = $state<"syncpeer" | "syncthing">("syncpeer");
  let unsafeReleaseText = $state("");
  let releaseHistory = $state<Array<{ kind: "safe"; proposal: { folderId: string } } |
    { kind: "dangerous"; exception: { folderId: string; guaranteeBroken: true } }>>([]);
  let patternDraft = $state("");
  let importPassword = $state(""), importApproved = $state(false);
  let folder = $derived(status?.folders.find(value => value.id === folderId));

  async function changePassword(mode: "save" | "forget") {
    busy = true; error = "";
    try {
      if (mode === "save") await onSavePassword(folderId);
      else await onClearPassword(folderId);
      if (managedStorage) await refresh();
    } catch { error = "Folder password could not be saved."; }
    finally { busy = false; }
  }

  async function refresh() {
    status = await command<NonNullable<typeof status>>({ operation: "status" });
    if (status.vault.phase !== "unlocked") { settings = null; sharedSettings = null; sharedConflicts = []; return; }
    releaseHistory = await command<typeof releaseHistory>({ operation: "localReleaseHistory" });
    settings = await command<SyncpeerProfileSettings>({ operation: "profileSettings" });
    patternDraft = settings.folders[folderId]?.ignorePatterns.join("\n") ?? "";
    const membership = await command<{ localDeviceId: string | null; devices: typeof trustedDevices }>
      ({ operation: "ownedDevices" });
    trustedDevices = membership.devices;
    localTrustedDeviceId = membership.localDeviceId;
    if (membership.devices.length) {
      const shared = await command<{ settings: PersonalSpaceSettings | null; conflicts: typeof sharedConflicts }>
        ({ operation: "sharedPersonalSpaceSettings" });
      sharedSettings = shared.settings;
      sharedConflicts = shared.conflicts.filter(conflict =>
        conflict.path[0] === "folders" && conflict.path[1] === folderId);
    } else { sharedSettings = null; sharedConflicts = []; }
  }

  async function importFolder() {
    if (!importApproved || !peerId || !folderId) return;
    busy = true; error = "";
    try { await onImport(peerId, folderId, importPassword); importPassword = ""; importApproved = false; await refresh(); }
    catch { error = "Folder import failed. Check the connected peer, folder identity and password. Existing data was retained."; }
    finally { busy = false; }
  }

  async function saveSettings(next: SyncpeerProfileSettings) {
    busy = true; error = "";
    try {
      await command({ operation: "saveProfileSettings", settings: next });
      settings = next;
      onSettingsSaved(next);
    } catch { error = "Settings could not be saved."; }
    finally { busy = false; }
  }

  async function saveSharedSetting(path: string[], value: unknown) {
    busy = true; error = "";
    try {
      await command({ operation: "savePersonalSpaceSetting", path, value });
      await refresh();
    } catch (failure) { error = failure instanceof Error ? failure.message : "Shared settings could not be saved."; }
    finally { busy = false; }
  }

  async function chooseConflict(path: string[], selectedHead: string) {
    busy = true; error = "";
    try {
      await command({ operation: "resolvePersonalSpaceConflict", path, selectedHead });
      await refresh();
    } catch (failure) { error = failure instanceof Error ? failure.message : "Shared-settings conflict could not be resolved."; }
    finally { busy = false; }
  }

  function saveRetention(folderId: string, minimumCopies: number,
    holders: Array<{ id: string; kind: "syncpeer" | "syncthing" }>) {
    const revision = sharedSettings?.folders[folderId]?.retentionRevision ?? 1;
    void saveSharedSetting(["folders", folderId, "retention"],
      { minimumCopies, retentionRevision: revision + 1, holders });
  }

  async function migrate(folderId: string, target: "encrypted" | "plaintext") {
    migrating = folderId; error = "";
    try { await onMigrate(folderId, target); await refresh(); }
    catch (failure) {
      const reason = safeNativeFailureText(failure);
      error = `Folder migration was not completed.${reason ? ` Reason: ${reason}.` : ""} Existing data was retained; check the password and available storage, then retry.`;
    }
    finally { migrating = ""; }
  }

  async function releaseLocalCopy(folderId: string, mode: "safe" | "dangerous") {
    const confirmedText = unsafeReleaseText;
    if (mode === "dangerous" && confirmedText !== "RELEASE LOCAL COPY") return;
    if (!window.confirm(mode === "safe"
      ? "Release this device's local copy? Syncpeer will first verify enough complete online copies."
      : "This may permanently lose the folder if other copies are unavailable. Release only this device's local copy?")) return;
    busy = true; error = "";
    try { await onRelease(folderId, mode, confirmedText); unsafeReleaseText = ""; await refresh(); }
    catch (failure) {
      await refresh().catch(() => undefined);
      error = failure instanceof Error ? failure.message : String(failure);
    }
    finally { busy = false; }
  }

  const updateFolder = (folderId: string, update: (folder: ReturnType<typeof defaultFolderSettings>) => ReturnType<typeof defaultFolderSettings>) => {
    if (!settings) return;
    const current = settings.folders[folderId] ?? defaultFolderSettings();
    void saveSettings({ ...settings, folders: { ...settings.folders, [folderId]: update(current) } });
  };
  const savePatterns = (folderId: string) => updateFolder(folderId, folder => ({ ...folder,
    ignorePatterns: (patternDraft).split("\n").map(value => value.trim()).filter(Boolean) }));
  const removeExclusion = (folderId: string, path: string, kind: "folder" | "file") =>
    updateFolder(folderId, folder => ({ ...folder, exclusions: folder.exclusions.filter(item =>
      item.path !== path || item.kind !== kind) }));

  onMount(() => {
    if (managedStorage) void refresh().catch(() => { error = "Folder settings are unavailable."; });
  });
</script>
<main class="panel" data-testid="folder-settings-page" data-folder-id={folderId}>
  <button onclick={onBack}>Back</button>
  <h1>Folder settings</h1>
  <p>{folderLabel || folderId}</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if actionError}<p role="alert">{actionError}</p>{/if}
  {#if encrypted}
    <section>
      <h2>Folder password</h2>
      {#if passwordError}<p role="alert">{passwordError}</p>{/if}
      <label>Folder Password
        <input data-testid={`folder-password-${folderId}`} type="password"
          value={passwordDraft} autocomplete="off"
          oninput={event => onUpdatePassword(folderId, event.currentTarget.value)} />
      </label>
      <button disabled={busy} data-testid={`unlock-folder-${folderId}`} onclick={() => void changePassword("save")}
        aria-label="Unlock folder">Save and unlock folder</button>
      <button onclick={() => void changePassword("forget")} disabled={busy || !passwordSaved}
        aria-label="Forget saved folder password">Forget saved folder password</button>
    </section>
  {/if}
  {#if managedStorage && status && status.vault.phase !== "unlocked"}
    <p>Unlock or create your personal space in general settings to manage this folder.</p>
    <button onclick={onOpenGeneralSettings}>Open general settings</button>
  {:else if managedStorage && status?.vault.phase === "unlocked"}
    {#if sharedConflicts.length}
      <section>
        <h2>Shared settings need a choice</h2>
        <p>Devices changed the same setting independently. Choose one value to create an explicit merged update; no conflicting value is applied automatically.</p>
        {#each sharedConflicts as conflict (conflict.path.join("/"))}
          <p>{conflict.path.join(" / ")}</p>
          {#each conflict.changes as change (change.id)}
            <button disabled={busy} onclick={() => void chooseConflict(conflict.path, change.id)}>
              Use {change.deleted ? "deleted value" : conflict.path[2] === "credential" ? "folder credential" : JSON.stringify(change.value)} from {change.deviceId.slice(0, 8)}
            </button>
          {/each}
        {/each}
      </section>
    {/if}
    {#if !folder && peerId && encrypted}
      <section>
        <h2>Register or recover this encrypted peer folder</h2>
        <p>Registration keeps the root browsable; only favorites download automatically.</p>
        <form onsubmit={event => { event.preventDefault(); void importFolder(); }}>
          <label>Folder password (blank uses recovered credentials)
            <input type="password" bind:value={importPassword} autocomplete="off" /></label>
          <label><input type="checkbox" bind:checked={importApproved} /> I verified this peer and folder ID with the folder owner</label>
          <button disabled={busy || !importApproved}>Approve and register folder</button>
        </form>
      </section>
    {/if}
  {#if folder}
    {@const lastRelease = releaseHistory.filter(value =>
      (value.kind === "safe" ? value.proposal.folderId : value.exception.folderId) === folder.id).at(-1)}
  <ul>
    <li>
      <span>{folder.label}</span>
      {#if status?.pendingLocalReleases.includes(folder.id)}
        <p>Local-copy cleanup is unfinished. Syncpeer will retry after the next unlock; this folder cannot be reattached yet.</p>
      {:else if folder.browseOnly}<p>Browse-only: no complete local copy is stored or shared.</p>{/if}
      {#if folder.browseOnly && lastRelease?.kind === "dangerous"}
        <p>Copy guarantee broken: this device released its copy without verifying enough other complete online copies.</p>
      {/if}
      {#if status?.vault.phase === "unlocked"}
        {#if folder.downloads}
          <button disabled={busy || migrating === folder.id} onclick={() => void migrate(folder.id, "plaintext")}>Move to plaintext storage</button>
          <p>Release this device's copy but keep the folder registered for remote browsing and later re-download.</p>
          <button disabled={busy} onclick={() => void releaseLocalCopy(folder.id, "safe")}>Release after verifying online copies</button>
          <p>If enough complete copies cannot be verified online, releasing anyway can permanently lose data.</p>
          <label>Type RELEASE LOCAL COPY to accept that risk
            <input value={unsafeReleaseText}
              oninput={event => { unsafeReleaseText = event.currentTarget.value; }} />
          </label>
          <button disabled={busy || unsafeReleaseText !== "RELEASE LOCAL COPY"}
            onclick={() => void releaseLocalCopy(folder.id, "dangerous")}>Release anyway (unsafe)</button>
        {:else}
          <button disabled={busy || migrating === folder.id || status?.pendingLocalReleases.includes(folder.id)}
            onclick={() => void migrate(folder.id, "encrypted")}>Reattach encrypted local storage</button>
        {/if}
      {/if}
    </li>
  </ul>
  {/if}
      {#if settings}
        {@const folderSettings = settings.folders[folderId] ?? defaultFolderSettings()}
        {#if sharedSettings && localTrustedDeviceId}
          {@const retention = sharedSettings.folders[folderId]}
          <section>
            <h3>Whole-folder retention policy</h3>
            <label>Minimum complete copies
              <input type="number" min="1" value={retention?.minimumCopies ?? 2} disabled={busy}
                onchange={event => saveRetention(folderId, Number(event.currentTarget.value), retention?.holders ?? [])} />
            </label>
            <p>Named holders (policy only; a complete copy still needs current evidence):</p>
            <ul>{#each retention?.holders ?? [] as holder (holder.id)}
              <li>{holder.id} ({holder.kind})
                <button disabled={busy} onclick={() => saveRetention(folderId, retention?.minimumCopies ?? 2,
                  (retention?.holders ?? []).filter(item => item.id !== holder.id))}>Remove holder</button></li>
            {/each}</ul>
            <label>Holder type <select value={newHolderKind}
              onchange={event => {
                newHolderKind = event.currentTarget.value as "syncpeer" | "syncthing";
                newHolderId = "";
              }}>
              <option value="syncpeer">Syncpeer</option><option value="syncthing">Syncthing</option>
            </select></label>
            {#if newHolderKind === "syncpeer"}
              <label>Personal-space device
                <select value={newHolderId}
                  onchange={event => { newHolderId = event.currentTarget.value; }}>
                  <option value="">Select a trusted device</option>
                  {#each trustedDevices.filter(device => device.state === "active") as device (device.id)}
                    <option value={device.id}>{device.id === localTrustedDeviceId ? "This device" : device.syncthingId}</option>
                  {/each}
                </select>
              </label>
            {:else}
              <label>Syncthing device ID <input value={newHolderId}
                oninput={event => { newHolderId = event.currentTarget.value; }} /></label>
            {/if}
            <button disabled={busy || !newHolderId.trim()} onclick={() => {
              const id = newHolderId.trim();
              if (!id) return;
              saveRetention(folderId, retention?.minimumCopies ?? 2,
                [...retention?.holders ?? [], { id, kind: newHolderKind }]);
              newHolderId = "";
            }}>Add holder</button>
          </section>
        {/if}
        <label><input type="checkbox" checked={folderSettings.paused}
          onchange={event => updateFolder(folderId, value => ({ ...value, paused: event.currentTarget.checked }))} /> Pause favorite synchronization</label>
        <label>Ignored patterns
          <textarea rows="8" value={patternDraft}
            oninput={event => { patternDraft = event.currentTarget.value; }}></textarea>
        </label>
        <button disabled={busy} onclick={() => savePatterns(folderId)}>Save ignore patterns</button>
        {#if folderSettings.exclusions.length}
          <p>Explicitly ignored paths:</p>
          <ul>{#each folderSettings.exclusions as exclusion (`${exclusion.kind}:${exclusion.path}`)}
            <li><span>{exclusion.path || "/"} — explicitly ignored</span>
              <button disabled={busy} onclick={() => removeExclusion(folderId, exclusion.path, exclusion.kind)}>Include again</button></li>
          {/each}</ul>
        {/if}
      {/if}
  {/if}
  {#if status?.vault.issue}<p role="status">{status.vault.issue}</p>{/if}
</main>
