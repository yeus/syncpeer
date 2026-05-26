<script lang="ts">
  import Panel from "./Panel.svelte";

  interface Props {
    app: any;
    onPickAndroidPimDirectory: () => void;
    onInitializePimFolder: () => void;
    onSyncAndroidPimNow: () => void;
    onImportProviderPimFromFolder: () => void;
  }

  let {
    app,
    onPickAndroidPimDirectory,
    onInitializePimFolder,
    onSyncAndroidPimNow,
    onImportProviderPimFromFolder,
  }: Props = $props();

  let statusRows = $derived.by(() => [
    { label: "PIM enabled", value: app.pim.enabled ? "Yes" : "No" },
    { label: "Contacts sync", value: app.pim.contactsEnabled ? "On" : "Off" },
    { label: "Calendar sync", value: app.pim.calendarEnabled ? "On" : "Off" },
    {
      label: "Connected folder",
      value: app.session.currentFolderId ? String(app.session.currentFolderId) : "None",
    },
    { label: "PIM root", value: String(app.pim.syncFolderPath || "Not set") },
  ]);
</script>

<Panel title="PIM Settings">
  <form class="settings-grid">
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={app.pim.enabled} />
      <span>Enable Contacts + Calendar Sync (PIM)</span>
    </label>

    <label class="checkbox-row">
      <input
        type="checkbox"
        bind:checked={app.pim.contactsEnabled}
        disabled={!app.pim.enabled}
      />
      <span>Sync Contacts</span>
    </label>

    <label class="checkbox-row">
      <input
        type="checkbox"
        bind:checked={app.pim.calendarEnabled}
        disabled={!app.pim.enabled}
      />
      <span>Sync Calendar</span>
    </label>

    <label>
      PIM Sync Folder Mode
      <select bind:value={app.pim.syncFolderMode} disabled={!app.pim.enabled}>
        <option value="choose">Choose existing Syncthing folder</option>
        <option value="create">Create dedicated Syncthing folder</option>
      </select>
    </label>

    <label>
      PIM Folder Path / Folder ID
      <input
        type="text"
        bind:value={app.pim.syncFolderPath}
        placeholder={app.pim.syncFolderMode === "create"
          ? "e.g. syncpeer-pim"
          : "e.g. /storage/emulated/0/Sync/pim or existing folder ID"}
        disabled={!app.pim.enabled}
      />
    </label>

    <label>
      Standards Storage Mode
      <select bind:value={app.pim.standardsMode} disabled>
        <option value="one_entry_per_file">One entry per file (.vcf/.ics canonical)</option>
      </select>
    </label>

    <label class="checkbox-row">
      <input
        type="checkbox"
        bind:checked={app.pim.autoMergeSilent}
        disabled={!app.pim.enabled}
      />
      <span>Silent auto-merge (no user conflict prompts)</span>
    </label>

    <label class="checkbox-row">
      <input
        type="checkbox"
        bind:checked={app.pim.androidContactsIntegration}
        disabled={!app.pim.enabled || !app.pim.contactsEnabled}
      />
      <span>Android Contacts integration</span>
    </label>

    <label class="checkbox-row">
      <input
        type="checkbox"
        bind:checked={app.pim.androidCalendarIntegration}
        disabled={!app.pim.enabled || !app.pim.calendarEnabled}
      />
      <span>Android Calendar integration</span>
    </label>
  </form>

  <div class="actions">
    <button
      type="button"
      class="ghost"
      onclick={onPickAndroidPimDirectory}
      disabled={!app.pim.enabled}
    >
      Pick Android PIM Directory
    </button>
    <button
      type="button"
      class="ghost"
      onclick={onInitializePimFolder}
      disabled={!app.pim.enabled || !app.session.isConnected || !app.session.currentFolderId}
    >
      Initialize PIM In Open Folder
    </button>
    <button
      type="button"
      class="ghost"
      onclick={onSyncAndroidPimNow}
      disabled={!app.pim.enabled || !app.session.isConnected || !app.session.currentFolderId}
    >
      Sync Android PIM Now
    </button>
    <button
      type="button"
      class="ghost"
      onclick={onImportProviderPimFromFolder}
      disabled={!app.pim.enabled || !app.session.isConnected || !app.session.currentFolderId}
    >
      Import Provider Files To Android
    </button>
  </div>
</Panel>

<Panel title="PIM Status">
  <div class="status-list">
    {#each statusRows as row}
      <p class="status-line"><strong>{row.label}:</strong> {row.value}</p>
    {/each}
    <p class="hint">
      LAN discovery mode: {String(app.connection.discoveryMode)}. This tab keeps PIM setup separate from device-level settings.
    </p>
  </div>
</Panel>

<style>
  .settings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.8rem;
  }

  .settings-grid label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }

  .settings-grid input,
  .settings-grid select {
    border: 1px solid var(--border-soft);
    border-radius: 0.55rem;
    padding: 0.45rem 0.6rem;
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .checkbox-row {
    flex-direction: row !important;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.2rem;
  }

  .actions {
    margin-top: 0.8rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  .actions button {
    border: 1px solid var(--border-soft);
    background: var(--bg-elevated);
    color: var(--text-primary);
    border-radius: 0.55rem;
    padding: 0.45rem 0.7rem;
    cursor: pointer;
  }

  .status-list {
    display: grid;
    gap: 0.45rem;
  }

  .status-line {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

  .hint {
    margin: 0.25rem 0 0;
    color: var(--text-secondary);
    font-size: 0.86rem;
  }
</style>
