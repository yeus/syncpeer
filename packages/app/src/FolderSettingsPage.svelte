<script lang="ts">
  import { onMount } from "svelte";
  import { defaultFolderSettings, type SyncpeerProfileSettings } from "@syncpeer/core/browser";
  import type { createDocumentFilesystem } from "@syncpeer/core/filesystem";
  let { onBack, onCreate, onUnlock, onUnlockBiometric, onRotateMasterPassword, onMigrate, onSettingsSaved, biometric, command }: {
    onBack: () => void;
    onCreate: (label: string) => Promise<void>;
    onUnlock: () => Promise<void>;
    onUnlockBiometric: () => Promise<void>;
    onRotateMasterPassword: (password: string) => Promise<void>;
    onMigrate: (folderId: string, target: "encrypted" | "plaintext") => Promise<void>;
    onSettingsSaved: (settings: SyncpeerProfileSettings) => void;
    biometric?: {
      status: () => Promise<{ available: boolean; enabled: boolean }>;
      setEnabled: (enabled: boolean) => Promise<{ available: boolean; enabled: boolean }>;
      authenticate: () => Promise<boolean>;
    };
    command: <T>(request: Record<string, unknown>) => Promise<T>;
  } = $props();
  let status = $state<Awaited<ReturnType<ReturnType<typeof createDocumentFilesystem>["status"]>> | null>(null);
  let label = $state(""), password = $state(""), masterPassword = $state(""), error = $state(""), busy = $state(false), migrating = $state("");
  let biometricState = $state<{ available: boolean; enabled: boolean } | null>(null);
  let settings = $state<SyncpeerProfileSettings | null>(null);
  let patternDrafts = $state<Record<string, string>>({});
  let rememberMaster = $state(false), generatedPassword = $state(""), generatedSaved = $state(false);
  async function refresh() {
    status = await command<NonNullable<typeof status>>({ operation: "status" });
    if (status.vault.phase === "unlocked") {
      settings = await command<SyncpeerProfileSettings>({ operation: "profileSettings" });
      patternDrafts = Object.fromEntries(Object.entries(settings.folders)
        .map(([folderId, folder]) => [folderId, folder.ignorePatterns.join("\n")]));
    }
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
  const updateFolder = (folderId: string, update: (folder: ReturnType<typeof defaultFolderSettings>) => ReturnType<typeof defaultFolderSettings>) => {
    if (!settings) return;
    const current = settings.folders[folderId] ?? defaultFolderSettings();
    void saveSettings({ ...settings, folders: { ...settings.folders, [folderId]: update(current) } });
  };
  const savePatterns = (folderId: string) => updateFolder(folderId, folder => ({ ...folder,
    ignorePatterns: (patternDrafts[folderId] ?? "").split("\n").map(value => value.trim()).filter(Boolean) }));
  const removeExclusion = (folderId: string, path: string, kind: "folder" | "file") =>
    updateFolder(folderId, folder => ({ ...folder, exclusions: folder.exclusions.filter(item =>
      item.path !== path || item.kind !== kind) }));
  async function submit(unlock: boolean) {
    busy = true; error = "";
    try {
      if (unlock) {
        await command({ operation: "unlock", password });
        await onUnlock();
      }
      else { await onCreate(label.trim()); label = ""; }
      await refresh();
    } catch { error = "Folder access failed. Check your password and available storage, then retry."; }
    finally { password = ""; busy = false; }
  }
  async function createProfile() {
    if (!masterPassword || (generatedPassword && !generatedSaved)) return;
    busy = true; error = "";
    try {
      await command({ operation: "createVault", password: masterPassword, remember: rememberMaster });
      generatedPassword = ""; generatedSaved = false; masterPassword = "";
      await onUnlock(); await refresh();
    } catch { error = "The encrypted profile could not be created."; }
    finally { busy = false; }
  }
  function generatePassword() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    generatedPassword = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    masterPassword = generatedPassword; generatedSaved = false;
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
  {:else if status?.vault.phase === "uninitialized"}
    <form onsubmit={event => { event.preventDefault(); void createProfile(); }}>
      <label>Master password <input type="password" bind:value={masterPassword} autocomplete="new-password" required /></label>
      <label><input type="checkbox" bind:checked={rememberMaster} /> Remember with the operating system’s protected credential store</label>
      <button type="button" onclick={generatePassword}>Generate recovery password</button>
      {#if generatedPassword}
        <p><code>{generatedPassword}</code></p>
        <label><input type="checkbox" bind:checked={generatedSaved} /> I saved this recovery password</label>
      {/if}
      <button disabled={busy || !masterPassword || Boolean(generatedPassword && !generatedSaved)}>Create encrypted profile</button>
    </form>
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
    {#if settings}
      <section>
        <h2>Synchronization defaults</h2>
        <label>Version history
          <select value={settings.profile.versioning} onchange={event => void saveSettings({ ...settings!, profile: {
            ...settings!.profile, versioning: event.currentTarget.value as SyncpeerProfileSettings["profile"]["versioning"] } })}>
            <option value="staggered">Staggered (recommended)</option>
            <option value="simple">Simple</option>
            <option value="trash">Trash can</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label><input type="checkbox" checked={settings.profile.preserveLocalChanges}
          onchange={event => void saveSettings({ ...settings!, profile: { ...settings!.profile,
            preserveLocalChanges: event.currentTarget.checked } })} /> Preserve locally initiated replacements and deletions</label>
        <label><input type="checkbox" checked={settings.profile.allowMetered}
          onchange={event => void saveSettings({ ...settings!, profile: { ...settings!.profile,
            allowMetered: event.currentTarget.checked } })} /> Allow background sync on metered/mobile networks</label>
        <label>Cache override (MiB, blank for adaptive 5%)
          <input type="number" min="0" value={settings.profile.cache.overrideBytes === undefined ? "" : settings.profile.cache.overrideBytes / 1048576}
            onchange={event => { const value = event.currentTarget.value.trim(); void saveSettings({ ...settings!, profile: {
              ...settings!.profile, cache: { ...settings!.profile.cache,
                ...(value ? { overrideBytes: Math.floor(Number(value) * 1048576) } : { overrideBytes: undefined }) } } }); }} />
        </label>
      </section>
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
      {#if settings}
        {@const folderSettings = settings.folders[folder.id] ?? defaultFolderSettings()}
        <label><input type="checkbox" checked={folderSettings.paused}
          onchange={event => updateFolder(folder.id, value => ({ ...value, paused: event.currentTarget.checked }))} /> Pause favorite synchronization</label>
        <label>Ignored patterns
          <textarea rows="8" value={patternDrafts[folder.id] ?? folderSettings.ignorePatterns.join("\n")}
            oninput={event => { patternDrafts[folder.id] = event.currentTarget.value; }}></textarea>
        </label>
        <button disabled={busy} onclick={() => savePatterns(folder.id)}>Save ignore patterns</button>
        {#if folderSettings.exclusions.length}
          <p>Explicitly ignored paths:</p>
          <ul>{#each folderSettings.exclusions as exclusion (`${exclusion.kind}:${exclusion.path}`)}
            <li><span>{exclusion.path || "/"} — explicitly ignored</span>
              <button disabled={busy} onclick={() => removeExclusion(folder.id, exclusion.path, exclusion.kind)}>Include again</button></li>
          {/each}</ul>
        {/if}
      {/if}
    </li>
  {/each}</ul>
  {#if status?.vault.issue}<p role="status">{status.vault.issue}</p>{/if}
</main>
