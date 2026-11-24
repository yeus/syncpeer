<script lang="ts">
  import type { ServiceSessionPhase, SessionState } from "@syncpeer/core/browser";
  import { connectionStatusLabel, connectionStatusTone } from "../lib/connectionStatus.ts";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import appIcon from "../../../../icon.svg?url";

  interface Props {
    phase: SessionState["phase"];
    connected: boolean;
    peerPhase?: ServiceSessionPhase | null;
    peerError?: string | null;
    paused: boolean;
    expanded: boolean;
    transferSummary?: string;
    transferNotice?: string;
    transferPercent?: number;
    onToggleDetails: () => void;
  }

  let { phase, connected, peerPhase = null, peerError = null, paused, expanded,
    transferSummary = "", transferNotice = "", transferPercent = 0, onToggleDetails }: Props = $props();

  let label = $derived.by(() => connectionStatusLabel({ phase, connected, peerPhase, paused }));

  let tone = $derived(connectionStatusTone({ phase, connected, peerPhase, paused }));
</script>

<header class="app-header">
  <div class="header-row">
  <div class="brand">
    <img src={appIcon} alt="" aria-hidden="true" />
    <span>Syncpeer</span>
  </div>
  <button
    type="button"
    class="connection-status"
    data-testid="connection-status-toggle"
    data-phase={phase}
    data-peer-phase={peerPhase ?? "none"}
    title={peerError ?? undefined}
    aria-expanded={expanded}
    aria-controls="connection-details"
    onclick={onToggleDetails}
  >
    <span class={`status-dot ${tone}`} aria-hidden="true"></span>
    <span data-testid="connection-status">{label}</span>
    <ChevronDown size={16} class={expanded ? "expanded" : ""} aria-hidden="true" />
  </button>
  </div>
  {#if transferSummary || transferNotice}
    <div class="header-transfer" data-testid="header-transfer">
      <div class="transfer-text" role="status" title={transferSummary || transferNotice}>
        {transferSummary || transferNotice}
      </div>
      {#if transferSummary}
        <div class="transfer-track" role="progressbar" aria-label="Download progress"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={transferPercent}>
          <span style:width={`${transferPercent}%`}></span>
        </div>
      {/if}
    </div>
  {/if}
</header>

<style>
  .app-header {
    flex: 0 0 auto;
    background: var(--bg-nav);
    color: var(--text-strong);
  }

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 54px;
    padding: 0.45rem 0.75rem;
  }

  .header-transfer {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0 0.75rem 0.45rem;
    color: var(--text-secondary);
  }

  .transfer-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78rem;
  }

  .transfer-track {
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--bg-surface-muted);
  }

  .transfer-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--color-secondary);
    transition: width 120ms ease;
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
    width: 32px;
    height: 32px;
    border: 0;
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
