<script lang="ts">
  import { onMount } from "svelte";
  import { defaultFolderSettings, type PairingInvitation, type SyncpeerProfileSettings } from "@syncpeer/core/browser";
  import type { createDocumentFilesystem } from "@syncpeer/core/filesystem";
  let { onBack, onCreate, onUnlock, onUnlockBiometric, onRotateMasterPassword, onMigrate, onSettingsSaved,
    onImport, onStartPairing, onJoinPairing, onPairedDevice, peerId, peerFolders, biometric, command }: {
    onBack: () => void;
    onImport: (peerId: string, folderId: string, password: string) => Promise<void>;
    peerId: string;
    peerFolders: Array<{ id: string; label: string; encrypted?: boolean }>;
    onCreate: (label: string) => Promise<void>;
    onUnlock: () => Promise<void>;
    onUnlockBiometric: () => Promise<void>;
    onRotateMasterPassword: (password: string) => Promise<void>;
    onMigrate: (folderId: string, target: "encrypted" | "plaintext") => Promise<void>;
    onSettingsSaved: (settings: SyncpeerProfileSettings) => void;
    onStartPairing: (advertisedHost: string) => Promise<{ invitation: PairingInvitation;
      completed: Promise<{ remoteDeviceId: string }>; cancel: () => Promise<void> }>;
    onJoinPairing: (invitation: PairingInvitation, password: string, remember: boolean) => Promise<{ remoteDeviceId: string }>;
    onPairedDevice: (deviceId: string) => void;
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
  let importFolderId = $state(""), importPassword = $state(""), importApproved = $state(false);
  let recoveryPassword = $state(""), backupText = $state(""), backupFile = $state<File | null>(null);
  let pairingHost = $state(""), pairingInvitation = $state(""), pairingMessage = $state("");
  let pairingHandle: Awaited<ReturnType<typeof onStartPairing>> | null = null;

  async function inviteDevice() {
    if (!pairingHost.trim()) return;
    busy = true; error = ""; pairingMessage = "";
    try {
      await pairingHandle?.cancel().catch(() => undefined);
      pairingHandle = await onStartPairing(pairingHost.trim());
      pairingInvitation = JSON.stringify(pairingHandle.invitation);
      pairingMessage = "Invitation ready. Copy it to the other device; it expires in five minutes.";
      void pairingHandle.completed.then(({ remoteDeviceId }) => {
        onPairedDevice(remoteDeviceId);
        pairingMessage = "Device paired and approved.";
        pairingInvitation = ""; pairingHandle = null;
      }).catch(failure => {
        error = failure instanceof Error ? failure.message : "Pairing failed.";
        pairingHandle = null;
      });
    } catch (failure) { error = failure instanceof Error ? failure.message : "Pairing invitation failed."; }
    finally { busy = false; }
  }

  async function joinDevice() {
    if (masterPassword.length < 16 || !pairingInvitation.trim()) return;
    busy = true; error = ""; pairingMessage = "";
    try {
      const invitation = JSON.parse(pairingInvitation) as PairingInvitation;
      const result = await onJoinPairing(invitation, masterPassword, rememberMaster);
      pairingInvitation = ""; masterPassword = "";
      pairingMessage = "Personal space joined and device approved.";
      await onUnlock(); await refresh();
      onPairedDevice(result.remoteDeviceId);
    } catch (failure) { error = failure instanceof Error ? failure.message : "Pairing failed."; }
    finally { busy = false; }
  }

  async function transferBackup(restore: boolean) {
    busy = true; error = "";
    try {
      if (restore) {
        if (backupFile && backupFile.size > 12 * 1024 * 1024) throw new Error("Backup is too large.");
        const encoded = backupFile ? await backupFile.text() : backupText;
        if (encoded.length > 12 * 1024 * 1024) throw new Error("Backup is too large.");
        await command({ operation: "restoreRecoveryBackup", backup: JSON.parse(encoded),
          recoveryPassword, password: masterPassword });
        backupText = ""; backupFile = null; masterPassword = "";
        await onUnlock(); await refresh();
      } else {
        backupText = JSON.stringify(await command({ operation: "exportRecoveryBackup", password: recoveryPassword }));
      }
    } catch { error = "Backup operation failed. Check the backup and passwords. Existing data was retained."; }
    finally { recoveryPassword = ""; busy = false; }
  }
  async function importFolder() {
    if (!importApproved || !peerId || !importFolderId) return;
    busy = true; error = "";
    try { await onImport(peerId, importFolderId, importPassword); importPassword = ""; importApproved = false; await refresh(); }
    catch { error = "Folder import failed. Check the connected peer, folder identity and password. Existing data was retained."; }
    finally { busy = false; }
  }
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
      <label>Master password (at least 16 characters) <input type="password" bind:value={masterPassword} autocomplete="new-password" minlength="16" required /></label>
      <label><input type="checkbox" bind:checked={rememberMaster} /> Remember with the operating system’s protected credential store</label>
      <p>Remembering allows background access after restarting the app or rebooting, once the device is unlocked. Without it, enter your master password each time. Explicitly locking always requires the master password again.</p>
      <button type="button" onclick={generatePassword}>Generate local master password</button>
      {#if generatedPassword}
        <p><code>{generatedPassword}</code></p>
        <label><input type="checkbox" bind:checked={generatedSaved} /> I saved this recovery password</label>
      {/if}
      <button disabled={busy || !masterPassword || Boolean(generatedPassword && !generatedSaved)}>Create encrypted profile</button>
    </form>
    <section>
      <h2>Join an existing personal space</h2>
      <p>Paste the short-lived invitation from an already unlocked Syncpeer device. Both devices must confirm the same six-digit code.</p>
      <label>Pairing invitation <textarea rows="6" bind:value={pairingInvitation}></textarea></label>
      <label>New local master password <input type="password" bind:value={masterPassword} autocomplete="new-password" minlength="16" /></label>
      <label><input type="checkbox" bind:checked={rememberMaster} /> Remember on this device</label>
      <button disabled={busy || masterPassword.length < 16 || !pairingInvitation.trim()} onclick={() => void joinDevice()}>Join personal space</button>
      {#if pairingMessage}<p role="status">{pairingMessage}</p>{/if}
    </section>
  {:else if status?.vault.phase === "unlocked"}
    <section>
      <h2>Pair another Syncpeer device</h2>
      <p>Enter this device’s LAN address. Creating an invitation temporarily disconnects the current sync session. The invitation expires after five minutes and transfers secrets only after both devices confirm the same code.</p>
      <label>This device’s LAN host or IP (optional port) <input bind:value={pairingHost} placeholder="192.168.1.20" /></label>
      <button disabled={busy || !pairingHost.trim()} onclick={() => void inviteDevice()}>Create pairing invitation</button>
      {#if pairingInvitation}
        <label>Invitation <textarea readonly rows="6" value={pairingInvitation} onclick={event => event.currentTarget.select()}></textarea></label>
        <button disabled={busy} onclick={() => void navigator.clipboard.writeText(pairingInvitation)}>Copy invitation</button>
        <button disabled={busy} onclick={() => { void pairingHandle?.cancel(); pairingHandle = null; pairingInvitation = ""; pairingMessage = "Pairing invitation cancelled."; }}>Cancel invitation</button>
      {/if}
      {#if pairingMessage}<p role="status">{pairingMessage}</p>{/if}
    </section>
    <section>
      <h2>Register or recover an encrypted peer folder</h2>
      <p>Connect to the peer first. Registration keeps the root browsable; only favorites download automatically. Recover a saved folder password from your personal-space backup, or enter and approve it here.</p>
      <p>Connected peer: <code>{peerId || "None"}</code></p>
      <form onsubmit={event => { event.preventDefault(); void importFolder(); }}>
        <label>Encrypted folder <select bind:value={importFolderId} onchange={() => { importApproved = false; }}>
          <option value="">Choose a folder</option>
          {#each peerFolders.filter(folder => folder.encrypted) as folder (folder.id)}
            <option value={folder.id}>{folder.label} · {folder.id}</option>
          {/each}
        </select></label>
        <label>Folder password (blank uses recovered credentials) <input type="password" bind:value={importPassword} autocomplete="off" /></label>
        <label><input type="checkbox" bind:checked={importApproved} /> I verified this peer and folder ID with the folder owner</label>
        <button disabled={busy || !peerId || !importFolderId || !importApproved}>Approve and register folder</button>
      </form>
    </section>
    <form onsubmit={event => { event.preventDefault(); void submit(false); }}>
      <label>New folder name <input bind:value={label} required /></label>
      <button disabled={busy || !label.trim()}>Create folder</button>
    </form>
    <p>New folders receive a random password stored securely on this device. Creating a local folder does not automatically share it with another device.</p>
    <form onsubmit={event => { event.preventDefault(); void saveMasterPassword(); }}>
      <label>Change personal-space master password <input type="password" bind:value={masterPassword} autocomplete="new-password" minlength="16" required /></label>
      <button disabled={busy || !masterPassword}>Change master password</button>
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
  {#if status?.vault.phase === "unlocked" || status?.vault.phase === "uninitialized"}
    <section>
      <h2>Personal-space backup</h2>
      <p>This password-encrypted backup contains folder credentials and settings. It contains neither downloaded documents nor device identity keys. Keep its recovery password separately.</p>
      <label>Backup recovery password <input type="password" bind:value={recoveryPassword} autocomplete="off" /></label>
      {#if status.vault.phase === "unlocked"}
        <button disabled={busy || !recoveryPassword} onclick={() => void transferBackup(false)}>Export encrypted backup</button>
        {#if backupText}
          <label>Encrypted backup — copy and save this text <textarea readonly rows="6" value={backupText} onclick={event => event.currentTarget.select()}></textarea></label>
          <a download="syncpeer-space-backup.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(backupText)}`}>Save backup file</a>
        {/if}
      {:else}
        <label>Backup file <input type="file" accept="application/json,.json" onchange={event => { backupFile = event.currentTarget.files?.[0] ?? null; }} /></label>
        <label>Or paste encrypted backup <textarea rows="6" bind:value={backupText}></textarea></label>
        <label>New device master password <input type="password" bind:value={masterPassword} autocomplete="new-password" minlength="16" /></label>
        <p>Recovery starts with remembering disabled. Your existing peer connections require approval on this device.</p>
        <button disabled={busy || !recoveryPassword || masterPassword.length < 16 || (!backupFile && !backupText)} onclick={() => void transferBackup(true)}>Import backup into this new profile</button>
      {/if}
    </section>
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
