<script lang="ts">
  import { createOwnedRecoveryKit } from "@syncpeer/core/filesystem";
  import { tick, untrack } from "svelte";
  import { formatProfileCreationError } from "../app/storageErrors.ts";
  import { isConfiguredDeviceName } from "../app/suggestedNames.ts";
  import { generateMasterPassword } from "../app/passwords.ts";
  import { createWorkerPasswordKdf } from "../lib/passwordKdf.ts";

  interface Props {
    mode: "create" | "unlock";
    suggestedName: string;
    initialDeviceName: string;
    command: <T>(request: Record<string, unknown>) => Promise<T>;
    getDefaultDeviceId: () => Promise<string>;
    biometric?: {
      status: () => Promise<{ available: boolean; enabled: boolean }>;
      authenticate: () => Promise<boolean>;
    };
    onDeviceNameSaved: (name: string) => void;
    onReady: () => Promise<void>;
    onOpenSettings: () => void;
  }

  let { mode, suggestedName, initialDeviceName, command, getDefaultDeviceId,
    biometric, onDeviceNameSaved, onReady, onOpenSettings }: Props = $props();

  let step = $state<1 | 2>(1);
  let deviceName = $state(untrack(() => isConfiguredDeviceName(initialDeviceName)
    ? initialDeviceName.trim() : suggestedName));
  let masterPassword = $state("");
  let rememberMaster = $state(false);
  let generatedPassword = $state("");
  let generatedSaved = $state(false);
  let kitPassword = $state("");
  let kitText = $state("");
  let kitSaved = $state(false);
  let unlockPassword = $state("");
  let biometricReady = $state(false);
  let error = $state("");
  let busy = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);
  let unlockInput = $state<HTMLInputElement | null>(null);
  let generatedBox = $state<HTMLDivElement | null>(null);
  let generatedCode = $state<HTMLElement | null>(null);

  $effect(() => {
    if (mode === "create") void tick().then(() => nameInput?.focus());
    else void tick().then(() => unlockInput?.focus());
    if (biometric) void biometric.status()
      .then(status => { biometricReady = status.available && status.enabled; })
      .catch(() => { biometricReady = false; });
  });

  const fail = (message: string) => { error = message; };

  const next = (event: SubmitEvent) => {
    event.preventDefault();
    if (!isConfiguredDeviceName(deviceName)) { fail("Choose a valid device name."); return; }
    if (masterPassword.length < 16) { fail("Use a master password with at least 16 characters."); return; }
    if (generatedPassword && !generatedSaved) { fail("Confirm that you saved the generated master password."); return; }
    error = "";
    step = 2;
  };

  const generatePassword = async () => {
    try {
      generatedPassword = generateMasterPassword();
      masterPassword = generatedPassword;
      generatedSaved = false;
      error = "";
      await tick();
      generatedBox?.scrollIntoView({ block: "nearest" });
    } catch {
      fail("A master password could not be generated on this device. Enter one manually.");
    }
  };

  const copyGeneratedPassword = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable.");
      await navigator.clipboard.writeText(generatedPassword);
      error = "";
    } catch {
      const range = document.createRange();
      if (generatedCode) {
        range.selectNodeContents(generatedCode);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      fail("Copy failed. Select the generated password and copy it manually.");
    }
  };

  const generateKit = async () => {
    if (kitPassword.length < 16) { fail("Use an offline kit password with at least 16 characters."); return; }
    error = "";
    busy = true;
    try {
      const kit = await createOwnedRecoveryKit(crypto.subtle,
        size => crypto.getRandomValues(new Uint8Array(size)), kitPassword,
        createWorkerPasswordKdf());
      kitText = JSON.stringify(kit);
      kitSaved = false;
    } catch (failure) {
      fail(failure instanceof Error ? failure.message : "Recovery kit could not be created.");
    } finally { busy = false; }
  };

  const createSpace = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!kitText || !kitSaved) { fail("Generate and save the offline signing kit first."); return; }
    error = "";
    busy = true;
    try {
      onDeviceNameSaved(deviceName.trim());
      await command({ operation: "createVault", password: masterPassword, remember: rememberMaster,
        localDeviceId: await getDefaultDeviceId(), recoveryKey: JSON.parse(kitText).publicKey });
      masterPassword = ""; generatedPassword = ""; kitText = ""; kitSaved = false;
      await onReady();
    } catch (failure) {
      fail(formatProfileCreationError(failure));
    } finally { busy = false; }
  };

  const unlockSpace = async (event: SubmitEvent) => {
    event.preventDefault();
    error = "";
    busy = true;
    try {
      await command({ operation: "unlock", password: unlockPassword });
      unlockPassword = "";
      await onReady();
    } catch {
      fail("Personal-space unlock failed. Check your password and retry.");
    } finally { busy = false; }
  };

  const unlockBiometric = async () => {
    if (!biometric) return;
    error = "";
    busy = true;
    try {
      if (!await biometric.authenticate()) throw new Error("Biometric authentication was not completed.");
      await command({ operation: "unlockRemembered" });
      await onReady();
    } catch {
      fail("Biometric unlock was not completed.");
    } finally { busy = false; }
  };
</script>

<div class="backdrop">
  <div class="panel card" role="dialog" aria-modal="true"
    aria-labelledby="personal-space-onboarding-title"
    data-testid="personal-space-onboarding">
    <h2 id="personal-space-onboarding-title">
      {mode === "create" ? "Set up your personal space" : "Unlock your personal space"}
    </h2>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}

    {#if mode === "unlock"}
      <p>Encrypted shared folders need the master password for this device.</p>
      <form onsubmit={unlockSpace}>
        <label>Master password
          <input bind:this={unlockInput} type="password" bind:value={unlockPassword}
            autocomplete="current-password" required data-testid="onboarding-unlock-password" />
        </label>
        <div class="actions">
          <button type="submit" disabled={busy || !unlockPassword} data-testid="onboarding-unlock">Unlock</button>
          {#if biometricReady}
            <button type="button" class="ghost" disabled={busy} onclick={unlockBiometric}>
              Use biometrics
            </button>
          {/if}
        </div>
      </form>
      <button type="button" class="link" onclick={onOpenSettings}>
        Join another space, restore a backup, or open settings
      </button>
    {:else if step === 1}
      <p>Choose the name other devices will see and a master password for this device.</p>
      <form onsubmit={next}>
        <label>Device name
          <input bind:this={nameInput} bind:value={deviceName} maxlength="64" data-testid="onboarding-device-name"
            autocomplete="off" spellcheck="false" />
        </label>
        <label>Master password (at least 16 characters)
          <input type="password" bind:value={masterPassword} autocomplete="new-password" minlength="16"
            data-testid="onboarding-master-password" />
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={rememberMaster} />
          Remember with the operating system's protected credential store
        </label>
        <button type="button" class="ghost" data-testid="onboarding-generate-password" onclick={generatePassword}>
          Generate a master password
        </button>
        {#if generatedPassword}
          <div class="generated-block" bind:this={generatedBox}>
            <p class="generated-label">Generated password — save it before continuing.</p>
            <code class="generated" bind:this={generatedCode} data-testid="generated-master-password">{generatedPassword}</code>
            <button type="button" class="ghost" onclick={copyGeneratedPassword}>Copy password</button>
          </div>
          <label class="check">
            <input type="checkbox" bind:checked={generatedSaved} data-testid="onboarding-generated-saved" />
            I saved this generated master password
          </label>
        {/if}
        <div class="actions">
          <button type="submit" disabled={busy} data-testid="onboarding-continue">Continue</button>
          <button type="button" class="ghost" onclick={onOpenSettings}>Join or restore</button>
        </div>
      </form>
    {:else}
      <p>
        Save a separate offline signing kit. It is required to recover this personal space if
        every trusted device is lost, and it is not stored in the app.
      </p>
      <form onsubmit={createSpace}>
        <label>Offline kit password (at least 16 characters)
          <input type="password" bind:value={kitPassword} autocomplete="new-password"
            minlength="16" disabled={Boolean(kitText)} data-testid="onboarding-kit-password" />
        </label>
        {#if kitText}
          <textarea readonly rows="5" value={kitText} onclick={event => event.currentTarget.select()}></textarea>
          <a download="syncpeer-offline-signing-kit.json"
            href={`data:application/json;charset=utf-8,${encodeURIComponent(kitText)}`}>
            Save offline kit file
          </a>
          <label class="check">
            <input type="checkbox" bind:checked={kitSaved} />
            I saved the kit and its password separately from this device
          </label>
          <button type="button" class="ghost" disabled={busy}
            onclick={() => { kitText = ""; kitSaved = false; }}>
            Generate a different kit
          </button>
        {:else}
          <button type="button" disabled={busy || kitPassword.length < 16} data-testid="onboarding-generate-kit" onclick={generateKit}>
            Generate offline signing kit
          </button>
        {/if}
        <div class="actions">
          <button type="submit" disabled={busy || !kitText || !kitSaved} data-testid="onboarding-create">Create personal space</button>
          <button type="button" class="ghost" disabled={busy} onclick={() => { step = 1; error = ""; }}>
            Back
          </button>
        </div>
      </form>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: color-mix(in srgb, var(--bg-shell) 82%, transparent);
    backdrop-filter: blur(6px);
  }

  .card {
    width: min(26rem, 100%);
    max-height: 90dvh;
    overflow-y: auto;
    display: grid;
    gap: 0.7rem;
    padding: 1rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-soft);
  }

  h2 { margin: 0; font-size: 1.1rem; }
  p { margin: 0; color: var(--text-secondary); font-size: 0.84rem; }
  form { display: grid; gap: 0.6rem; }
  label { display: grid; gap: 0.3rem; font-size: 0.82rem; color: var(--text-secondary); }
  .check { display: flex; align-items: flex-start; gap: 0.45rem; }
  .check input { margin-top: 0.15rem; }
  input, textarea { width: 100%; box-sizing: border-box; }
  input { min-height: 42px; }
  textarea { font-family: var(--font-mono); font-size: 0.72rem; resize: vertical; }
  .actions {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    background: var(--bg-surface-soft);
    padding-block: 0.4rem;
  }
  .actions button { flex: 1 1 auto; min-height: 42px; }
  .link { border: 0; background: none; color: var(--color-primary); text-align: left; padding: 0; font-size: 0.8rem; }
  .generated-block {
    display: grid;
    gap: 0.35rem;
    padding: 0.6rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }
  .generated-label { color: var(--state-success-text); font-weight: 700; }
  .generated { font-size: 0.72rem; overflow-wrap: anywhere; padding: 0.4rem; background: var(--bg-surface); border-radius: var(--radius-sm); user-select: all; }
  .form-error { color: var(--state-danger-text); }
</style>
