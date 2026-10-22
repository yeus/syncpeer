<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { FullAutoFill } from "svelte/elements";
  import type { Snippet } from "svelte";
  import Eye from "lucide-svelte/icons/eye";
  import EyeOff from "lucide-svelte/icons/eye-off";

  interface Props {
    value?: string;
    label: string;
    secretLabel?: string;
    id?: string;
    autocomplete?: FullAutoFill;
    disabled?: boolean;
    required?: boolean;
    minlength?: number;
    maxlength?: number;
    placeholder?: string;
    testId?: string;
    autofocus?: boolean;
    onValueChange?: (value: string) => void;
    children?: Snippet;
  }

  let { value = $bindable(""), label, secretLabel = label, id, autocomplete = "off",
    disabled = false, required = false, minlength, maxlength, placeholder, testId,
    autofocus = false, onValueChange, children }: Props = $props();
  const generatedId = $props.id();
  const inputId = $derived(id ?? generatedId);
  let visible = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  onMount(() => {
    if (autofocus) void tick().then(() => input?.focus());
  });
</script>

<div class="password-field">
  <label for={inputId}>{label}</label>
  <div class="password-control">
    <input
      bind:this={input}
      id={inputId}
      type={visible ? "text" : "password"}
      bind:value
      spellcheck={false}
      autocapitalize="off"
      {autocomplete}
      {disabled}
      {required}
      {minlength}
      {maxlength}
      {placeholder}
      data-testid={testId}
      oninput={event => onValueChange?.(event.currentTarget.value)}
    />
    {#if children}{@render children()}{/if}
    <button
      type="button"
      class="visibility-toggle"
      aria-label={`${visible ? "Hide" : "Show"} ${secretLabel}`}
      aria-pressed={visible}
      title={`${visible ? "Hide" : "Show"} ${secretLabel}`}
      data-testid={testId ? `${testId}-visibility` : undefined}
      onclick={() => { visible = !visible; }}
    >
      {#if visible}
        <EyeOff size={16} aria-hidden="true" />
      {:else}
        <Eye size={16} aria-hidden="true" />
      {/if}
    </button>
  </div>
</div>

<style>
  .password-field {
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .password-field label {
    font-size: 0.82rem;
    color: var(--text-secondary);
  }

  .password-control {
    display: flex;
    align-items: stretch;
    gap: 0.35rem;
    min-width: 0;
  }

  .password-control input {
    flex: 1 1 auto;
    min-width: 0;
  }

  .visibility-toggle {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: var(--bg-surface-muted);
    color: var(--text-secondary);
  }
</style>
