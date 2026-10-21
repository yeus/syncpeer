<script lang="ts">
  import { onMount } from "svelte";
  import type { PairingInvitation, SyncpeerProfileSettings } from "@syncpeer/core/browser";
  import { createOwnedRecoveryKit, type createDocumentFilesystem } from "@syncpeer/core/filesystem";
  import { formatProfileCreationError } from "./app/storageErrors.ts";
  import { generateMasterPassword } from "./app/passwords.ts";
  import { formatSyncthingDeviceId } from "./app/devicePolicies.ts";
  import { createWorkerPasswordKdf } from "./lib/passwordKdf.ts";
  let { onBack, onOpenFolderSettings, onUnlock, onUnlockBiometric, onRotateMasterPassword, onSettingsSaved,
    onTrustedDevicesChanged, getDefaultDeviceId, onStartPairing, onJoinPairing,
    onPairedDevice, biometric, command }: {
    onBack: () => void;
    onOpenFolderSettings: (folderId: string) => void;
    onUnlock: () => Promise<void>;
    onUnlockBiometric: () => Promise<void>;
    onRotateMasterPassword: (password: string) => Promise<void>;
    onSettingsSaved: (settings: SyncpeerProfileSettings) => void;
    onTrustedDevicesChanged: () => Promise<void>;
    getDefaultDeviceId: () => Promise<string>;
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
  let password = $state(""), masterPassword = $state(""), error = $state(""), busy = $state(false);
  let biometricState = $state<{ available: boolean; enabled: boolean } | null>(null);
  let settings = $state<SyncpeerProfileSettings | null>(null);
  let rememberMaster = $state(false), generatedPassword = $state(""), generatedSaved = $state(false);
  let recoveryPassword = $state(""), backupText = $state(""), backupFile = $state<File | null>(null);
  let kitPassword = $state(""), kitText = $state(""), kitFile = $state<File | null>(null);
  let kitSaved = $state(false);
  let pairingHost = $state(""), pairingInvitation = $state(""), pairingMessage = $state("");
  let trustedDevices = $state<Array<{ id: string; syncthingId: string; state: "active" | "revoked" }>>([]);
  let localTrustedDeviceId = $state<string | null>(null);
  let conflictedFolders = $state<string[]>([]);
  let pairingHandle: Awaited<ReturnType<typeof onStartPairing>> | null = null;

  async function refresh() {
    status = await command<NonNullable<typeof status>>({ operation: "status" });
    if (status.vault.phase !== "unlocked") { settings = null; return; }
    settings = await command<SyncpeerProfileSettings>({ operation: "profileSettings" });
    const membership = await command<{ localDeviceId: string | null; devices: typeof trustedDevices }>
      ({ operation: "ownedDevices" });
    trustedDevices = membership.devices;
    localTrustedDeviceId = membership.localDeviceId;
    const shared = membership.devices.length ? await command<{ conflicts: Array<{ path: string[] }> }>
      ({ operation: "sharedPersonalSpaceSettings" }) : null;
    conflictedFolders = [...new Set(shared?.conflicts.filter(conflict => conflict.path[0] === "folders")
      .map(conflict => conflict.path[1]) ?? [])];
  }
  async function unlock() {
    busy = true; error = "";
    try { await command({ operation: "unlock", password }); await onUnlock(); await refresh(); }
    catch { error = "Personal-space unlock failed. Check your password and retry."; }
    finally { password = ""; busy = false; }
  }

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
        void refresh();
      }).catch(failure => {
        const message = failure instanceof Error ? failure.message : failure;
        error = typeof message === "string" && message.trim() ? message : "Pairing failed.";
        pairingHandle = null;
      });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : failure;
      error = typeof message === "string" && message.trim() ? message : "Pairing invitation failed.";
    }
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
    } catch (failure) { error = failure instanceof Error ? failure.message :
      typeof failure === "string" ? failure : "Pairing failed."; }
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

  async function prepareRecoveryKit() {
    busy = true; error = "";
    try {
      const kit = await createOwnedRecoveryKit(crypto.subtle,
        size => crypto.getRandomValues(new Uint8Array(size)), kitPassword,
        createWorkerPasswordKdf());
      kitText = JSON.stringify(kit);
      kitSaved = false;
    } catch (failure) { error = failure instanceof Error ? failure.message : "Recovery kit could not be created."; }
    finally { kitPassword = ""; busy = false; }
  }

  async function recoverTrustedDevice() {
    busy = true; error = "";
    try {
      if (kitFile && kitFile.size > 16 * 1024) throw new Error("Recovery kit is too large.");
      const encoded = kitFile ? await kitFile.text() : kitText;
      if (encoded.length > 16 * 1024) throw new Error("Recovery kit is too large.");
      await command({ operation: "recoverOwnedDevice", localDeviceId: await getDefaultDeviceId(),
        kit: JSON.parse(encoded), password: kitPassword });
      kitText = ""; kitFile = null;
      await onTrustedDevicesChanged(); await refresh();
    } catch (failure) { error = failure instanceof Error ? failure.message : "Trusted-device recovery failed."; }
    finally { kitPassword = ""; busy = false; }
  }

  async function revokeDevice(deviceId: string) {
    busy = true; error = "";
    try {
      await command({ operation: "revokeOwnedDevice", deviceId });
      await onTrustedDevicesChanged();
      await refresh();
    }
    catch (failure) { error = failure instanceof Error ? failure.message : "The trusted device could not be removed."; }
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

  async function createProfile() {
    if (!masterPassword || !kitText || !kitSaved || (generatedPassword && !generatedSaved)) return;
    busy = true; error = "";
    try {
      await command({ operation: "createVault", password: masterPassword, remember: rememberMaster,
        localDeviceId: await getDefaultDeviceId(), recoveryKey: JSON.parse(kitText).publicKey });
      kitText = ""; kitSaved = false;
      generatedPassword = ""; generatedSaved = false; masterPassword = "";
      await onUnlock(); await refresh();
    } catch (failure) { error = formatProfileCreationError(failure); }
    finally { busy = false; }
  }

  function generatePassword() {
    try {
      generatedPassword = generateMasterPassword();
      masterPassword = generatedPassword;
      generatedSaved = false;
      error = "";
    } catch {
      error = "A master password could not be generated on this device. Enter one manually.";
    }
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

  onMount(() => {
    void refresh().catch(() => { error = "Personal-space settings are unavailable."; });
    void biometric?.status().then(value => { biometricState = value; }).catch(() => {});
  });
</script>
<main class="panel" data-testid="general-settings-page">
  <button onclick={onBack}>Back</button>
  <h1>Settings</h1>
  {#if status && status.vault.phase !== "unlocked"}
    <p class="hint" data-testid="personal-space-required">
      Encrypted shared folders need a master password on this device. Create a new personal space
      below, or join or restore an existing one before opening them.
    </p>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <section data-testid="personal-space-settings">
    <h2>Personal space</h2>
    <p>Your approved devices share an encrypted settings folder containing folder credentials and shared policies. Each device keeps its own local master password.</p>
  {#if status?.vault.phase === "locked"}
    <form onsubmit={event => { event.preventDefault(); void unlock(); }}>
      <label>Unlock personal space <input type="password" bind:value={password} autocomplete="current-password" required /></label>
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
      <p>Create and save a separate offline signing kit before creating this personal space. You need both this kit and a recent personal-space backup if every trusted device is lost. The kit is not saved in this app or included in the backup.</p>
      <label>Offline kit password (at least 16 characters) <input type="password" bind:value={kitPassword} autocomplete="new-password" minlength="16" disabled={Boolean(kitText)} /></label>
      {#if kitText}
        <label>Encrypted offline signing kit — save separately <textarea readonly rows="6" value={kitText} onclick={event => event.currentTarget.select()}></textarea></label>
        <a download="syncpeer-offline-signing-kit.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(kitText)}`}>Save offline kit file</a>
        <label><input type="checkbox" bind:checked={kitSaved} /> I saved the kit and its password separately from this device</label>
        <button type="button" disabled={busy} onclick={() => { kitText = ""; kitSaved = false; }}>Generate a different kit</button>
      {:else}
        <button type="button" disabled={busy || kitPassword.length < 16} onclick={() => void prepareRecoveryKit()}>Generate encrypted offline kit</button>
      {/if}
      <button disabled={busy || !masterPassword || !kitSaved || Boolean(generatedPassword && !generatedSaved)}>Create encrypted profile</button>
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
    {#if conflictedFolders.length}
      <section>
        <h3>Folder settings need a choice</h3>
        <p>Resolve competing updates in the affected folder's settings.</p>
        {#each conflictedFolders as id (id)}
          <button onclick={() => onOpenFolderSettings(id)}>
            Open settings for {status.folders.find(folder => folder.id === id)?.label || id}
          </button>
        {/each}
      </section>
    {/if}
    {#if !localTrustedDeviceId && trustedDevices.length}
      <section>
        <h2>Recover trusted device access</h2>
        <p>This backup has no device identity key. Use the separate offline signing kit to enroll this device and revoke every device in the backup's trusted list. Use the latest backup; an older copy of this space's device membership may conflict with later changes.</p>
        <label>Offline signing kit file <input type="file" accept="application/json,.json" onchange={event => { kitFile = event.currentTarget.files?.[0] ?? null; }} /></label>
        <label>Or paste encrypted kit <textarea rows="6" bind:value={kitText}></textarea></label>
        <label>Offline kit password <input type="password" bind:value={kitPassword} autocomplete="off" /></label>
        <button disabled={busy || !kitPassword || (!kitFile && !kitText)} onclick={() => void recoverTrustedDevice()}>Enroll this replacement device</button>
      </section>
    {/if}
    <section>
      <h2>Pair another Syncpeer device</h2>
      <p>Enter this device’s LAN address or a Syncthing relay URL that both devices can reach. Creating an invitation temporarily disconnects the current sync session. The invitation expires after five minutes and transfers secrets only after both devices confirm the same code.</p>
      <label>LAN host/IP or relay:// URL <input bind:value={pairingHost} placeholder="192.168.1.20" /></label>
      <button disabled={busy || !pairingHost.trim()} onclick={() => void inviteDevice()}>Create pairing invitation</button>
      {#if pairingInvitation}
        <label>Invitation <textarea readonly rows="6" value={pairingInvitation} onclick={event => event.currentTarget.select()}></textarea></label>
        <button disabled={busy} onclick={() => void navigator.clipboard.writeText(pairingInvitation)}>Copy invitation</button>
        <button disabled={busy} onclick={() => { void pairingHandle?.cancel(); pairingHandle = null; pairingInvitation = ""; pairingMessage = "Pairing invitation cancelled."; }}>Cancel invitation</button>
      {/if}
      {#if pairingMessage}<p role="status">{pairingMessage}</p>{/if}
    </section>
    {#if trustedDevices.length}
      <section>
        <h2>Devices with access to this space</h2>
        <p>Each device has its own permanent signing key. Removing a device blocks future trusted-list updates and synchronization after peers receive the revocation.</p>
        <ul>
          {#each trustedDevices as device (device.id)}
            <li>
              <code>{formatSyncthingDeviceId(device.syncthingId)}</code> — {device.id === localTrustedDeviceId ? "this device" : device.state}
              {#if device.state === "active" && device.id !== localTrustedDeviceId}
                <button disabled={busy} onclick={() => void revokeDevice(device.id)}>Remove device</button>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    <form onsubmit={event => { event.preventDefault(); void saveMasterPassword(); }}>
      <label>Change personal-space master password <input type="password" bind:value={masterPassword} autocomplete="new-password" minlength="16" required /></label>
      <button disabled={busy || !masterPassword}>Change master password</button>
    </form>
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
  </section>
  {#if status?.vault.phase === "unlocked"}
    <section data-testid="device-settings">
      <h2>This device</h2>
      <p>These synchronization defaults and biometric unlock settings apply to this device.</p>
    {#if biometricState}
      <p>Biometric unlock is {biometricState.enabled ? "enabled" : "disabled"}.</p>
      <button disabled={busy || !biometricState.available} onclick={() => void toggleBiometric()}>
        {biometricState.enabled ? "Disable biometric unlock" : "Enable biometric unlock"}
      </button>
    {/if}
    {#if settings}
      <section>
        <h3>Synchronization defaults</h3>
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
    </section>
  {/if}
  {#if status?.vault.issue}<p role="status">{status.vault.issue}</p>{/if}
</main>
