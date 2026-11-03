<script lang="ts">
  import { untrack } from "svelte";
  import { isConfiguredDeviceName } from "../app/suggestedNames.ts";

  let { suggestedName, onSave }: {
    suggestedName: string;
    onSave: (name: string) => void;
  } = $props();

  let name = $state(untrack(() => suggestedName));
  let error = $state("");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!isConfiguredDeviceName(trimmed)) {
      error = "Enter a device name.";
      return;
    }
    error = "";
    onSave(trimmed);
  }
</script>

<main class="first-run" data-testid="device-name-onboarding">
  <form class="name-setup" onsubmit={submit}>
    <h1>Name this device</h1>
    <p>Other devices will recognize it by this name.</p>
    <label for="first-run-device-name">Device name</label>
    <input
      id="first-run-device-name"
      data-testid="local-name-entry"
      bind:value={name}
      oninput={() => { error = ""; }}
      maxlength="64"
      required
      autocomplete="off"
      spellcheck="false"
    />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button type="submit" class="primary" data-testid="save-local-device-name">Continue</button>
  </form>
</main>

<style>
  .first-run {
    display: grid;
    place-items: center;
    min-height: 100vh;
    min-height: 100dvh;
    padding: max(1.5rem, env(safe-area-inset-top))
      max(1.5rem, env(safe-area-inset-right))
      max(1.5rem, env(safe-area-inset-bottom))
      max(1.5rem, env(safe-area-inset-left));
    background: var(--bg-shell);
    color: var(--text-primary);
    box-sizing: border-box;
  }

  .name-setup {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    width: min(100%, 32rem);
  }

  h1 { font-size: clamp(1.8rem, 4vw, 2.5rem); margin: 0; }
  p { margin: 0 0 0.6rem; color: var(--text-secondary); }
  label { font-weight: 600; }
  input { box-sizing: border-box; width: 100%; min-height: 52px; font-size: 1.05rem; }
  button { align-self: flex-start; min-height: 48px; min-width: 10rem; }
  .error { margin: 0; color: var(--state-danger-text); }
</style>
