<script lang="ts">
  import { tick, untrack } from "svelte";
  import { isConfiguredDeviceName } from "../app/suggestedNames.ts";

  interface Props {
    suggestedName: string;
    onSave: (name: string) => void;
  }

  let { suggestedName, onSave }: Props = $props();
  let draft = $state(untrack(() => suggestedName));
  let error = $state("");
  let input = $state<HTMLInputElement | null>(null);

  $effect(() => {
    void tick().then(() => input?.focus());
  });

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!isConfiguredDeviceName(name)) {
      error = name ? "Choose a different device name." : "Enter a device name.";
      return;
    }
    error = "";
    onSave(name);
  };
</script>

<div class="backdrop">
  <div
    class="panel card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="device-name-title"
    data-testid="device-name-onboarding"
  >
    <h2 id="device-name-title">Name this device</h2>
    <p>This name is shown to other Syncpeer devices when you connect or pair.</p>
    <form onsubmit={submit}>
      <label for="device-name-input">Device name</label>
      <input
        id="device-name-input"
        bind:this={input}
        bind:value={draft}
        maxlength="64"
        autocomplete="off"
        spellcheck="false"
      />
      {#if error}<p class="form-error">{error}</p>{/if}
      <button type="submit">Continue</button>
    </form>
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
    width: min(28rem, 100%);
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-soft);
  }

  h2 {
    margin: 0;
    font-size: 1.1rem;
  }

  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.84rem;
  }

  form {
    display: grid;
    gap: 0.6rem;
  }

  label {
    display: grid;
    gap: 0.3rem;
    font-weight: 700;
  }

  input {
    min-height: 44px;
  }

  .form-error {
    color: var(--state-danger-text);
  }
</style>
