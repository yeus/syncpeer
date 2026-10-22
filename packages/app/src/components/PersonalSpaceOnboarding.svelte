<script lang="ts">
  import { createOwnedRecoveryKit } from "@syncpeer/core/filesystem";
  import { generateMnemonic } from "@scure/bip39";
  import { wordlist } from "@scure/bip39/wordlists/english.js";
  import Dice5 from "lucide-svelte/icons/dice-5";
  import Copy from "lucide-svelte/icons/copy";
  import Check from "lucide-svelte/icons/check";
  import { onMount, tick, untrack } from "svelte";
  import { formatProfileCreationError } from "../app/storageErrors.ts";
  import { isConfiguredDeviceName } from "../app/suggestedNames.ts";
  import { generateMasterPassword } from "../app/passwords.ts";
  import { directSubmit, directTap } from "../lib/directTap.ts";
  import { createWorkerPasswordKdf } from "../lib/passwordKdf.ts";
  import PasswordInput from "./PasswordInput.svelte";

  interface Props {
    enableInputDiagnostics?: boolean;
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
    onSkip: () => void;
    onCopyDiagnostics: () => Promise<void>;
    onGenerationEvent?: (stage: string, reason?: string) => void;
    onOpenSettings: () => void;
  }

  let { mode, suggestedName, initialDeviceName, command, getDefaultDeviceId,
    biometric, onDeviceNameSaved, onReady, onOpenSettings, onSkip,
    onCopyDiagnostics, onGenerationEvent, enableInputDiagnostics = false }: Props = $props();

  let step = $state<1 | 2 | 3>(1);
  let deviceName = $state(untrack(() => isConfiguredDeviceName(initialDeviceName)
    ? initialDeviceName.trim() : suggestedName));
  let masterPassword = $state("");
  let rememberMaster = $state(false);
  let passwordConfirmed = $state(false);
  let passwordCopied = $state(false);
  let recoveryPhrase = $state("");
  let kitText = $state("");
  let kitSaved = $state(false);
  let unlockPassword = $state("");
  let biometricReady = $state(false);
  let error = $state("");
  let generationStatus = $state("");
  let diagnosticsStatus = $state("");
  let busy = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);
  let dialogCard = $state<HTMLDivElement | null>(null);
  const traceEnabled = untrack(() => typeof navigator !== "undefined" &&
    (enableInputDiagnostics || /Android/i.test(navigator.userAgent)));
  let traceSeconds = $state(0);
  let traceEvents = $state({ touch: 0, pointer: 0, click: 0 });
  let traceLastTarget = $state("none");
  let traceLastAction = $state("none");
  let traceLastEvent = $state("none");

  const eventTargetLabel = (event: Event): string => {
    const element = event.target instanceof Element ? event.target : null;
    const button = element?.closest("button");
    if (button) {
      const testId = button.getAttribute("data-testid");
      if (testId === "onboarding-skip") return "skip";
      if (testId === "onboarding-generate-password") return "generate";
      return "other button";
    }
    return element?.closest(".onboarding-card") ? "dialog (not button)" : "outside dialog";
  };

  onMount(() => {
    if (!traceEnabled) return;
    // Capture events before bubbling or WebView delegation. No field values,
    // device identifiers, coordinates or passwords are recorded.
    const record = (event: Event) => {
      if (event.type === "touchstart") traceEvents = { ...traceEvents, touch: traceEvents.touch + 1 };
      if (event.type === "pointerdown") traceEvents = { ...traceEvents, pointer: traceEvents.pointer + 1 };
      if (event.type === "click") traceEvents = { ...traceEvents, click: traceEvents.click + 1 };
      traceLastEvent = event.type;
      traceLastTarget = eventTargetLabel(event);
    };
    const names = ["touchstart", "pointerdown", "click"] as const;
    for (const name of names) window.addEventListener(name, record, { capture: true, passive: true });
    const timer = window.setInterval(() => { traceSeconds += 1; }, 1000);
    return () => {
      window.clearInterval(timer);
      for (const name of names) window.removeEventListener(name, record, { capture: true });
    };
  });

  const skipOnboarding = () => {
    traceLastAction = "skip handler entered";
    onSkip();
  };

  // One-time initialization must not be dependency-tracked. On Android the
  // biometric status lookup reads reactive state, which previously caused this
  // $effect to reschedule itself until Svelte aborted the entire effect queue.
  onMount(() => {
    if (mode === "create" && !window.matchMedia("(pointer: coarse)").matches) {
      void tick().then(() => nameInput?.focus());
    }
    if (biometric) {
      void biometric.status()
        .then(status => { biometricReady = status.available && status.enabled; })
        .catch(() => { biometricReady = false; });
    }
  });

  const reportGeneration = (stage: string, reason?: string) => {
    // Diagnostics are best-effort and must never block password creation.
    try { onGenerationEvent?.(stage, reason); } catch { /* Keep setup usable. */ }
  };

  const fail = (message: string) => { error = message; };

  const showStep = async (target: 1 | 2 | 3) => {
    error = "";
    step = target;
    // The generated-password view scrolls down; a new step must start at its heading.
    await tick();
    if (dialogCard) dialogCard.scrollTop = 0;
  };

  const next = (event: SubmitEvent) => {
    event.preventDefault();
    if (!isConfiguredDeviceName(deviceName)) { fail("Choose a valid device name."); return; }
    if (masterPassword.length < 16) { fail("Use a master password with at least 16 characters."); return; }
    passwordConfirmed = false;
    void showStep(2);
  };

  const confirmPasswordSaved = () => {
    passwordConfirmed = true;
    void showStep(3);
  };

  const generatePassword = async () => {
    traceLastAction = "generate handler entered";
    reportGeneration("requested");
    let next: string;
    try {
      next = generateMasterPassword();
    } catch (failure) {
      const reason = failure instanceof Error ? failure.name : typeof failure;
      generationStatus = `Secure random generation failed (${reason}).`;
      reportGeneration("random-failed", reason);
      fail("Could not generate a secure password. You can enter one manually, or copy setup diagnostics.");
      return;
    }
    masterPassword = next;
    passwordConfirmed = false;
    passwordCopied = false;
    error = "";
    generationStatus = "";
    reportGeneration("generated");
  };

  const copyDiagnostics = async () => {
    try {
      await onCopyDiagnostics();
      diagnosticsStatus = "Copy requested. You can also skip setup to open Session Logs.";
    } catch {
      diagnosticsStatus = "Copy is unavailable. Skip setup to open Session Logs.";
    }
  };

  const copyMasterPassword = async () => {
    if (!masterPassword) { fail("Enter or generate a password first."); return; }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable.");
      await navigator.clipboard.writeText(masterPassword);
      passwordCopied = true;
      error = "";
    } catch {
      document.querySelector<HTMLInputElement>("[data-testid='onboarding-master-password']")?.select();
      fail("Clipboard unavailable. Select the password in the field to copy it manually.");
    }
  };

  const generateKit = async () => {
    error = "";
    busy = true;
    try {
      // 128 bits of browser CSPRNG entropy, encoded as 12 standard BIP39 English words.
      const phrase = generateMnemonic(wordlist, 128);
      const kit = await createOwnedRecoveryKit(crypto.subtle,
        size => crypto.getRandomValues(new Uint8Array(size)), phrase,
        createWorkerPasswordKdf());
      recoveryPhrase = phrase;
      kitText = JSON.stringify(kit);
      kitSaved = false;
    } catch (failure) {
      recoveryPhrase = "";
      fail(failure instanceof Error ? failure.message : "Recovery kit could not be created.");
    } finally { busy = false; }
  };

  const createSpace = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!kitText) { fail("Generate your recovery phrase and kit first."); return; }
    if (!kitSaved) { fail("Confirm you saved the recovery phrase and kit file before creating your space."); return; }
    if (!passwordConfirmed) { fail("Confirm you saved your master password first."); return; }
    error = "";
    busy = true;
    try {
      onDeviceNameSaved(deviceName.trim());
      await command({ operation: "createVault", password: masterPassword, remember: rememberMaster,
        localDeviceId: await getDefaultDeviceId(), recoveryKey: JSON.parse(kitText).publicKey });
      masterPassword = ""; recoveryPhrase = ""; kitText = ""; kitSaved = false;
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

<div class="onboarding-backdrop">
  <div class="onboarding-card" bind:this={dialogCard} role="dialog" aria-modal="true"
    aria-labelledby="personal-space-onboarding-title"
    data-testid="personal-space-onboarding">
    <header class="dialog-heading">
      <span class="eyebrow">{mode === "unlock" ? "WELCOME BACK" : `SETUP · ${step} / 3`}</span>
      <h2 id="personal-space-onboarding-title">
        {mode === "unlock" ? "Unlock your personal space" : step === 1 ? "Secure this device"
          : step === 2 ? "Save your master password" : "Save your recovery keys"}
      </h2>
      <p>{mode === "unlock" ? "Unlock to access your encrypted folders." : step === 1
        ? "Name your device and choose a master password."
        : step === 2 ? "Store the password from the previous step somewhere safe before continuing."
        : "Keep the 12-word phrase and encrypted kit file together, separate from this device."}</p>
    </header>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if traceEnabled}
      <details class="input-diagnostics" open={enableInputDiagnostics} data-testid="onboarding-input-diagnostics">
        <summary>Input diagnostics</summary>
        <span data-testid="onboarding-trace-heartbeat">JS: {traceSeconds}s</span>
        <span data-testid="onboarding-trace-events">Touch: {traceEvents.touch} · Pointer: {traceEvents.pointer} · Click: {traceEvents.click}</span>
        <span data-testid="onboarding-trace-target">Last event: {traceLastEvent} on {traceLastTarget}</span>
        <span data-testid="onboarding-trace-action">Last action: {traceLastAction}</span>
      </details>
    {/if}
    {#if mode === "unlock"}
      <form onsubmit={unlockSpace}>
        <PasswordInput label="Master password" secretLabel="personal-space master password" bind:value={unlockPassword}
          autocomplete="current-password" required autofocus testId="onboarding-unlock-password" />
        <div class="actions">
          <button class="primary" type="submit" use:directSubmit disabled={busy || !unlockPassword} data-testid="onboarding-unlock">Unlock</button>
          {#if biometricReady}
            <button type="button" class="ghost" disabled={busy} use:directTap={unlockBiometric}>
              Use biometrics
            </button>
          {/if}
        </div>
      </form>
    {:else if step === 1}
      <form onsubmit={next}>
        <label>Device name
          <input bind:this={nameInput} bind:value={deviceName} maxlength="64" data-testid="onboarding-device-name"
            autocomplete="off" spellcheck="false" />
        </label>
        <PasswordInput label="Master password (at least 16 characters)" secretLabel="master password" bind:value={masterPassword}
          autocomplete="new-password" minlength={16} testId="onboarding-master-password"
          onValueChange={() => { passwordConfirmed = false; passwordCopied = false; generationStatus = ""; }}>
          <button type="button" class="field-tool" title="Generate a strong password" aria-label="Generate a strong password"
            data-testid="onboarding-generate-password" use:directTap={generatePassword}><Dice5 size={19} aria-hidden="true" /></button>
          <button type="button" class="field-tool" title={passwordCopied ? "Password copied" : "Copy master password"}
            aria-label={passwordCopied ? "Password copied" : "Copy master password"}
            data-testid="onboarding-copy-password" use:directTap={copyMasterPassword}>
            {#if passwordCopied}<Check size={18} aria-hidden="true" />{:else}<Copy size={18} aria-hidden="true" />{/if}
          </button>
        </PasswordInput>
        <label class="check">
          <input type="checkbox" bind:checked={rememberMaster} />
          Remember in operating system's credential store
        </label>
        {#if generationStatus}<p role="status" class="generation-status" data-testid="onboarding-generation-status">{generationStatus}</p>{/if}
        <button type="submit" class="primary" use:directSubmit disabled={busy} data-testid="onboarding-continue">Continue</button>
      </form>
    {:else if step === 2}
      <div class="confirmation">
        <p>This password protects your encrypted personal space. Syncpeer cannot recover it for you.</p>
        <button type="button" class="primary" data-testid="onboarding-confirm-password"
          use:directTap={confirmPasswordSaved}>I've saved my master password</button>
        <button type="button" class="ghost" use:directTap={() => showStep(1)}>Back to password</button>
      </div>
    {:else}
      <form onsubmit={createSpace}>
        {#if kitText}
          <div class="recovery-phrase" data-testid="onboarding-recovery-phrase">
            {#each recoveryPhrase.split(" ") as word, index (index)}
              <span><small>{index + 1}.</small> {word}</span>
            {/each}
          </div>
          <textarea hidden readonly value={kitText} data-testid="onboarding-kit-json"></textarea>
          <div class="kit-actions">
            <a download="syncpeer-offline-signing-kit.json" data-testid="onboarding-kit-download"
              href={`data:application/json;charset=utf-8,${encodeURIComponent(kitText)}`}>
              Download encrypted recovery kit
            </a>
            <button type="button" class="link" disabled={busy}
              use:directTap={() => { kitText = ""; recoveryPhrase = ""; kitSaved = false; }}>
              Regenerate
            </button>
          </div>
          <p class="foot-hint">Both the file and phrase are required after losing every trusted device, along with a recent space backup.</p>
          <button type="button" class={kitSaved ? "confirmed" : "ghost"} data-testid="onboarding-kit-confirm"
            use:directTap={() => { kitSaved = true; error = ""; }}>
            {kitSaved ? "Recovery kit saved ✓" : "I've saved the phrase and kit file"}
          </button>
        {:else}
          <button type="button" disabled={busy} data-testid="onboarding-generate-kit" use:directTap={generateKit}>
            {busy ? "Generating recovery keys…" : "Generate recovery phrase and kit"}
          </button>
        {/if}
        <div class="actions">
          <button type="submit" class="primary" use:directSubmit disabled={busy} data-testid="onboarding-create">Create personal space</button>
          <button type="button" class="ghost" disabled={busy} use:directTap={() => showStep(2)}>Back</button>
        </div>
      </form>
    {/if}
    <footer class="dialog-footer">
      {#if mode === "unlock" || step === 1}
        <div class="secondary-actions">
          <button type="button" class="link" use:directTap={onOpenSettings}>Join or restore an existing space</button>
          <button type="button" class="link" disabled={busy} use:directTap={copyDiagnostics}
            data-testid="onboarding-copy-diagnostics">Copy setup diagnostics</button>
        </div>
      {/if}
      {#if diagnosticsStatus}<p role="status">{diagnosticsStatus}</p>{/if}
      <button type="button" class="skip" disabled={busy} data-testid="onboarding-skip" use:directTap={skipOnboarding}>Skip for now</button>
    </footer>
  </div>
</div>

<style>
  .dialog-heading { display: grid; gap: 0.25rem; }
  .eyebrow { font-size: 0.68rem; color: var(--text-muted); font-weight: 700; letter-spacing: 0.08em; }
  h2 { margin: 0; font-size: 1.1rem; color: var(--text-strong); }
  p { margin: 0; color: var(--text-secondary); font-size: 0.81rem; line-height: 1.4; }
  form, .confirmation { display: grid; gap: 0.55rem; min-width: 0; }
  label { display: grid; gap: 0.3rem; font-size: 0.81rem; color: var(--text-secondary); }
  .check { display: flex; align-items: center; gap: 0.55rem; line-height: 1.3; }
  .check input { flex: 0 0 auto; width: 1.1rem; height: 1.1rem; margin: 0; }
  input { width: 100%; min-width: 0; min-height: 44px; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .actions button { flex: 1 1 auto; min-height: 44px; }
  .field-tool { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; padding: 0.4rem; border: 0; border-radius: var(--radius-sm); background: var(--bg-surface-muted); color: var(--text-secondary); }
  .generation-status { color: var(--state-success-text); }
  .form-error { color: var(--state-danger-text); }
  .kit-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; }
  .kit-actions a { font-size: 0.85rem; }
  .recovery-phrase { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.35rem 0.45rem; padding: 0.55rem; border-radius: var(--radius-sm); background: var(--bg-surface-muted); font-family: var(--font-mono); font-size: 0.77rem; }
  .recovery-phrase span { white-space: nowrap; }
  .recovery-phrase small { color: var(--text-muted); }
  .foot-hint { font-size: 0.75rem; }
  .confirmed { color: var(--state-success-text); background: var(--bg-surface-muted); }
  .dialog-footer { display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 0.5rem; align-items: center; padding-top: 0.45rem; background: var(--bg-surface); border-top: 1px solid var(--border-soft); }
  .dialog-footer p { grid-column: 1 / -1; }
  .secondary-actions { display: flex; flex-wrap: wrap; gap: 0.3rem 0.65rem; }
  .link { border: 0; background: none; color: var(--color-primary); min-height: 32px; text-align: left; padding: 0; font-size: 0.78rem; }
  .skip { border: none; background: none; text-decoration: underline; text-underline-offset: 0.2em; color: var(--text-secondary); min-height: 32px; white-space: nowrap; justify-self: end; }
  .input-diagnostics { font-size: 0.68rem; line-height: 1.3; font-family: var(--font-mono); color: var(--text-muted); }
  .input-diagnostics[open] { display: grid; gap: 0.12rem; padding: 0.4rem; background: var(--bg-surface-muted); border-radius: var(--radius-sm); }
  .input-diagnostics summary { cursor: pointer; font-family: var(--font-sans); color: var(--text-secondary); }
  @media (max-width: 400px) { .recovery-phrase { gap: 0.35rem; font-size: 0.69rem; } .dialog-footer { grid-template-columns: 1fr; } .skip { justify-self: end; } }
</style>
