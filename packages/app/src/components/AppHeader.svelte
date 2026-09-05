<script lang="ts">
  import type { SessionState } from "@syncpeer/core/browser";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import appIcon from "../../../../icon.svg?url";

  interface Props {
    phase: SessionState["phase"];
    connected: boolean;
    paused: boolean;
    expanded: boolean;
    onToggleDetails: () => void;
  }

  let { phase, connected, paused, expanded, onToggleDetails }: Props = $props();

  let label = $derived.by(() => {
    if (connected) return "Connected";
    if (paused) return "Paused";
    if (phase === "connecting") return "Connecting";
    if (phase === "reconnecting") return "Reconnecting";
    if (phase === "waiting") return "Retry scheduled";
    if (phase === "suspended") return "Suspended";
    if (phase === "stopping") return "Stopping";
    if (phase === "error") return "Connection error";
    return "Disconnected";
  });

  let tone = $derived(connected ? "online" : phase === "error" ? "error" : "offline");
</script>

<header class="app-header">
  <div class="brand">
    <img src={appIcon} alt="" aria-hidden="true" />
    <span>Syncpeer</span>
  </div>
  <button
    type="button"
    class="connection-status"
    data-testid="connection-status-toggle"
    data-phase={phase}
    aria-expanded={expanded}
    aria-controls="connection-details"
    onclick={onToggleDetails}
  >
    <span class={`status-dot ${tone}`} aria-hidden="true"></span>
    <span data-testid="connection-status">{label}</span>
    <ChevronDown size={16} class={expanded ? "expanded" : ""} aria-hidden="true" />
  </button>
</header>

<style>
  .app-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 58px;
    padding: 0.45rem 0.75rem;
    border-bottom: 1px solid var(--border-default);
    background: var(--bg-nav);
    color: var(--text-strong);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
    font-size: 1.05rem;
    font-weight: 750;
  }

  .brand img {
    width: 38px;
    height: 38px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: #fff;
  }

  .connection-status {
    min-height: 40px;
    padding: 0.35rem 0.45rem;
    border-color: transparent;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.82rem;
  }

  .status-dot {
    width: 0.58rem;
    height: 0.58rem;
    border-radius: 50%;
    background: var(--state-offline-text);
  }

  .status-dot.online {
    background: var(--state-success-dot);
  }

  .status-dot.error {
    background: var(--state-danger-text);
  }

  :global(.connection-status svg) {
    transition: transform 120ms ease;
  }

  :global(.connection-status svg.expanded) {
    transform: rotate(180deg);
  }
</style>
