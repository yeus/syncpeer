<script lang="ts">
  import type { Snippet } from "svelte";
  import ArrowLeft from "lucide-svelte/icons/arrow-left";
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import Users from "lucide-svelte/icons/users";
  import HardDrive from "lucide-svelte/icons/hard-drive";
  import ShieldCheck from "lucide-svelte/icons/shield-check";
  import Network from "lucide-svelte/icons/network";
  import Palette from "lucide-svelte/icons/palette";
  import Activity from "lucide-svelte/icons/activity";
  import Info from "lucide-svelte/icons/info";
  import { settingsSections, type SettingsSection } from "../app/settingsSections.ts";
  let { section, onBack, onSelect, children }: {
    section: SettingsSection; onBack: () => void; onSelect: (section: SettingsSection) => void; children?: Snippet;
  } = $props();
  const icons = { synchronization: RefreshCw, "personal-space": Users, storage: HardDrive,
    security: ShieldCheck, network: Network, appearance: Palette, diagnostics: Activity, about: Info };
  let title = $derived(settingsSections.find(item => item.id === section)?.title ?? "Settings");
</script>
<div class="settings-shell" data-testid="settings-shell">
  <header class="settings-header">
    <button type="button" class="ghost" data-testid="settings-back" aria-label="Back" onclick={onBack}><ArrowLeft size={22} /></button>
    <h1>{title}</h1>
  </header>
  <main class="settings-content" data-testid={`settings-${section}`}>
    {#if section === "overview"}
      <div class="panel settings-list">
        {#each settingsSections as item (item.id)}
          {@const Icon = icons[item.id]}
          <button type="button" class="settings-row ghost" data-testid={item.id === "personal-space" ? "general-settings" : `open-settings-${item.id}`}
            onclick={() => onSelect(item.id)}>
            <Icon size={23} aria-hidden="true" />
            <span><strong>{item.title}</strong><small>{item.description}</small></span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        {/each}
      </div>
    {:else}
      {@render children?.()}
    {/if}
  </main>
</div>
<style>
  .settings-shell { min-height:100%; background:var(--bg-shell); }
  .settings-header { display:flex; align-items:center; gap:0.5rem; padding:0.4rem 0.75rem;
    background:var(--bg-nav); position:sticky; top:0; z-index:5; }
  .settings-header h1 { margin:0; font-size:1.2rem; }
  .settings-header button { min-height:44px; min-width:44px; border:0; }
  .settings-content { width:100%; max-width:960px; box-sizing:border-box; margin:auto; padding:0.75rem; }
  .settings-list { padding:0; }
  .settings-row { display:flex; align-items:center; gap:0.85rem; width:100%; min-height:70px; padding:0.75rem;
    border:0; border-radius:0; text-align:left; background:transparent; color:var(--text-strong); }
  .settings-row + .settings-row { border-top:1px solid var(--border-list-divider); }
  .settings-row span { display:grid; flex:1; gap:0.15rem; min-width:0; }
  .settings-row small { color:var(--text-secondary); font-weight:400; white-space:normal; }
</style>
