<svelte:options runes={true} />
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    createSyncpeerBrowserClient,
    createSyncpeerSessionStore,
  } from "@syncpeer/core/browser";
  import DiagnosticsPage from "./DiagnosticsPage.svelte";
  import DeviceTab from "./components/DeviceTab.svelte";
  import FavoritesTab from "./components/FavoritesTab.svelte";
  import FoldersTab from "./components/FoldersTab.svelte";
  import { createTauriAdapters } from "./lib/tauriAdapters.js";
  import {
    createAppActions,
    formatBytes,
    formatModified,
    rootFolderEntries,
  } from "./app/actions.ts";
  import {
    activeFolderPasswords,
    advertisedDevices,
    advertisedFolders,
    applySessionState,
    connectTargetLabel,
    directoryCurrentPage,
    directoryTotalPages,
    connectionModeLabel,
    currentSourceIsIntroducer,
    downloadButtonLabel,
    favoriteKeys,
    folderIsLocked,
    folderLockLabel,
    folderState,
    isFolderPasswordInputVisible,
    isSavedDeviceAwaitingRemoteApproval,
    isSavedDeviceConnected,
    paginatedDirectoryEntries,
    persistState,
    pushClientLog,
    pushSessionLog,
    visibleBreadcrumbs,
    createInitialState,
  } from "./app/state.ts";
  import FolderOpen from "lucide-svelte/icons/folder-open";
  import Settings from "lucide-svelte/icons/settings";
  import Star from "lucide-svelte/icons/star";

  let app = $state(createInitialState());

  const { hostAdapter, platformAdapter } = createTauriAdapters({
    onLog: (entry) => pushClientLog(app, entry),
  });
  const client = createSyncpeerBrowserClient({
    hostAdapter,
    platformAdapter,
    onLog: (entry) => pushClientLog(app, entry),
  });
  const sessionStore = createSyncpeerSessionStore({
    transport: client,
    onTrace: (event) => {
      pushSessionLog(app, event.level, event.event, event.message, event.details);
    },
  });
  const actions = createAppActions({ state: app, client, sessionStore });

  const unsubscribe = sessionStore.subscribe((next) => {
    applySessionState(app, next);
  });

  let activePasswords = $derived(activeFolderPasswords(app));
  let currentAdvertisedDevices = $derived(advertisedDevices(app));
  let currentAdvertisedFolders = $derived(advertisedFolders(app));
  let currentFavoriteKeys = $derived(favoriteKeys(app));
  let currentBreadcrumbs = $derived(visibleBreadcrumbs(app));
  let currentRootFolders = $derived(rootFolderEntries(app));
  let currentConnectionModeLabel = $derived(connectionModeLabel(app));
  let currentConnectTargetLabel = $derived(connectTargetLabel(app));
  let currentDirectoryEntries = $derived(paginatedDirectoryEntries(app));
  let currentDirectoryPage = $derived(directoryCurrentPage(app));
  let currentDirectoryTotalPages = $derived(directoryTotalPages(app));

  $effect(() => {
    persistState(app);
  });

  $effect(() => {
    if (
      app.devices.savedDevices.length > 0 &&
      !app.devices.savedDevices.some(
        (device) => device.id === app.devices.selectedSavedDeviceId,
      )
    ) {
      app.devices.selectedSavedDeviceId = app.devices.savedDevices[0].id;
    } else if (app.devices.savedDevices.length === 0) {
      app.devices.selectedSavedDeviceId = "";
    }
  });

  $effect(() => {
    if (
      app.connection.discoveryMode === "global" &&
      app.connection.host === "127.0.0.1"
    ) {
      app.connection.host = "";
    }
  });

  $effect(() => {
    void sessionStore.actions.setFolderPasswords(activePasswords);
  });

  $effect(() => {
    if (app.ui.recentError && app.ui.recentError !== app.ui.lastLoggedError) {
      app.ui.lastLoggedError = app.ui.recentError;
      pushSessionLog(app, "error", "ui.error", app.ui.recentError);
    }
  });

  onMount(() => {
    void actions.hydrate();
    void actions.refreshCurrentDeviceId();
    actions.restoreOfflineSnapshot(undefined, "startup");
  });

  const refreshTimer = setInterval(() => {
    void actions.refreshActiveView();
  }, 3000);

  onDestroy(() => {
    clearInterval(refreshTimer);
    unsubscribe();
    void client.disconnect();
  });
</script>

{#if app.currentPage === "main"}
  <div class="app-shell">
    <main class="content">
      {#if app.ui.recentError}
        <section class="panel error-banner-panel">
          <p class="error">{app.ui.recentError}</p>
        </section>
      {/if}

      {#if app.approvals.pendingApprovalPromptDeviceId}
        <section class="panel">
          <p class="hint">
            Waiting for remote approval for <strong>{app.approvals.pendingApprovalPromptDeviceId}</strong>.
            The remote peer device should now show a prompt to accept this client. Accept
            it there, then connect again.
          </p>
          <div class="item-meta">{app.approvals.pendingApprovalPromptDeviceId}</div>
          <div class="actions">
            <button
              class="primary"
              onclick={() => actions.connect(app.approvals.pendingApprovalPromptDeviceId)}
              disabled={app.session.isConnecting}
            >
              {app.session.isConnecting &&
              app.session.activeConnectDeviceId === app.approvals.pendingApprovalPromptDeviceId
                ? "Connecting..."
                : "Connect Again"}
            </button>
            <button
              class="ghost"
              onclick={() => {
                app.approvals.pendingApprovalPromptDeviceId = "";
              }}
              disabled={app.session.isConnecting}
            >
              Dismiss
            </button>
          </div>
        </section>
      {/if}

      {#if !app.session.isConnected}
        <div class="global-connect">
          <button class="primary" onclick={() => actions.connect()} disabled={app.session.isConnecting}>
            {app.session.isConnecting ? "Connecting..." : "Connect"}
          </button>
          <div class="global-connect-meta">
            {#if currentConnectTargetLabel}
              <p>Target: {currentConnectTargetLabel}</p>
            {/if}
            {#if currentConnectionModeLabel}
              <p>{currentConnectionModeLabel}</p>
            {/if}
          </div>
        </div>
      {/if}

      {#if app.activeTab === "devices"}
        <DeviceTab
          {app}
          connectionModeLabel={currentConnectionModeLabel}
          advertisedDevices={currentAdvertisedDevices}
          advertisedFolders={currentAdvertisedFolders}
          isSavedDeviceConnected={(deviceId) => isSavedDeviceConnected(app, deviceId)}
          isSavedDeviceAwaitingRemoteApproval={(deviceId) =>
            isSavedDeviceAwaitingRemoteApproval(app, deviceId)}
          currentSourceIsIntroducer={currentSourceIsIntroducer(app)}
          onConnect={() => actions.connect()}
          onDisconnect={actions.disconnect}
          onUseSavedDevice={actions.useSavedDevice}
          onResetDiscoveryServer={actions.resetDiscoveryServer}
          onClearAllCache={actions.clearAllCache}
          onClearOfflineFolderState={actions.clearOfflineFolderState}
          onOpenDiagnosticsPage={actions.openDiagnosticsPage}
          onCopyCurrentDeviceId={actions.copyCurrentDeviceId}
          onCopySessionLogs={actions.copySessionLogs}
          onEditLocalDeviceName={actions.editLocalDeviceName}
          onRegenerateDeviceId={actions.regenerateDeviceId}
          onCopyIdentityBackupSecret={actions.copyIdentityBackupSecret}
          onRestoreIdentityRecovery={actions.restoreIdentityRecovery}
          onAddSavedDevice={actions.addSavedDevice}
          onApproveAdvertisedDevice={actions.approveAdvertisedDevice}
          onApproveFolderSync={actions.approveFolderSync}
          onConnectToSavedDevice={(deviceId) => actions.connect(deviceId)}
          onEditSavedDeviceName={actions.editSavedDeviceName}
          onSetSavedDeviceIntroducer={actions.setSavedDeviceIntroducer}
          onRemoveSavedDevice={actions.removeSavedDevice}
          onRefreshOverview={actions.refreshOverview}
          onOpenFolderRoot={actions.openFolderRoot}
        />
      {/if}

      {#if app.activeTab === "favorites"}
        <FavoritesTab
          {app}
          onOpenDownloadedFilesPanel={actions.openDownloadedFilesPanel}
          onOpenFavorite={actions.openFavorite}
          onOpenCachedFile={actions.openCachedFile}
          onOpenCachedFileDirectory={actions.openCachedFileDirectory}
          onRemoveCachedFile={actions.removeCachedFile}
          onDownloadFile={actions.downloadFile}
          onRemoveFavorite={actions.removeFavorite}
          onClearAllCache={actions.clearAllCache}
          {formatBytes}
          {formatModified}
        />
      {/if}

      {#if app.activeTab === "folders"}
        <FoldersTab
          {app}
          breadcrumbs={currentBreadcrumbs}
          rootFolders={currentRootFolders}
          favoriteKeys={currentFavoriteKeys}
          onRefreshActiveView={actions.refreshActiveView}
          onGoToRootView={actions.goToRootView}
          onGoToBreadcrumb={actions.goToBreadcrumb}
          onOpenFolderRoot={actions.openFolderRoot}
          onOpenDirectory={actions.openDirectory}
          onSetDirectoryPage={actions.setDirectoryPage}
          onSetDirectoryPageSize={actions.setDirectoryPageSize}
          onOpenCachedDirectory={actions.openCachedDirectory}
          onOpenCachedFile={actions.openCachedFile}
          onOpenCachedFileDirectory={actions.openCachedFileDirectory}
          onDownloadFile={actions.downloadFile}
          onToggleFavorite={actions.toggleFavorite}
          onSetPasswordVisible={actions.setFolderPasswordInputVisible}
          onUpdateFolderPasswordDraft={actions.updateFolderPasswordDraft}
          onSaveFolderPassword={actions.saveFolderPassword}
          onClearFolderPassword={actions.clearFolderPassword}
          isFolderLocked={(folderId) => folderIsLocked(app, folderId)}
          folderLockLabel={(folderId) => folderLockLabel(app, folderId)}
          folderState={(folderId) => folderState(app, folderId)}
          isPasswordInputVisible={(folderId) => isFolderPasswordInputVisible(app, folderId)}
          activeFolderPasswords={activePasswords}
          downloadButtonLabel={(folderId, path) => downloadButtonLabel(app, folderId, path)}
          entries={currentDirectoryEntries}
          directoryPage={currentDirectoryPage}
          directoryTotalPages={currentDirectoryTotalPages}
          directoryPageSize={app.ui.directoryPageSize}
          {formatBytes}
          {formatModified}
          onHandleUploadSelected={actions.handleUploadSelected}
        />
      {/if}
    </main>

    <nav class="bottom-tabs">
      <button
        type="button"
        class={`tab-button ${app.activeTab === "favorites" ? "active" : ""}`}
        onclick={(event) => actions.switchTab("favorites", event)}
      >
        <Star size={18} aria-hidden="true" />
        <span class="sr-only">Favorites</span>
      </button>
      <button
        type="button"
        class={`tab-button ${app.activeTab === "folders" ? "active" : ""}`}
        onclick={(event) => actions.switchTab("folders", event)}
      >
        <FolderOpen size={18} aria-hidden="true" />
        <span class="sr-only">Folders</span>
      </button>
      <button
        type="button"
        class={`tab-button ${app.activeTab === "devices" ? "active" : ""}`}
        onclick={(event) => actions.switchTab("devices", event)}
      >
        <Settings size={18} aria-hidden="true" />
        <span class="sr-only">Settings</span>
      </button>
    </nav>
  </div>
{:else}
  <DiagnosticsPage
    onBack={actions.closeDiagnosticsPage}
    onRun={actions.runFolderDiagnosticsTest}
  />
{/if}

<style>
  .app-shell {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg-shell);
    padding-top: env(safe-area-inset-top);
    overflow: hidden;
  }

  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 0.9rem 0.0rem;
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  .error-banner-panel {
    margin-bottom: 0.5rem;
    padding: 0.5rem 0.6rem;
    border-color: var(--state-danger-border);
    background: var(--state-danger-bg);
  }

  .global-connect {
    margin-bottom: 0.55rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.55rem;
  }

  .global-connect button {
    flex: 0 0 auto;
  }

  .global-connect-meta {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
    flex: 1 1 20rem;
  }

  .global-connect-meta p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.84rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .error {
    margin: 0;
    color: var(--state-danger-text);
    font-size: 0.84rem;
  }

  .bottom-tabs {
    position: relative;
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    background: var(--bg-nav);
    backdrop-filter: blur(12px);
    border-top: 1px solid var(--border-default);
    padding: 0.45rem 0.45rem calc(0.45rem + env(safe-area-inset-bottom));
    gap: 0.35rem;
    z-index: 1000;
    pointer-events: auto;
  }

  .tab-button {
    border: 1px solid transparent;
    color: var(--text-muted);
    background: transparent;
    border-radius: var(--radius-sm);
    font-weight: 700;
    letter-spacing: 0.02em;
    font-size: 0.9rem;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
  }

  .tab-button.active {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    border-color: var(--border-accent);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 640px) {
    .content {
      padding: 0.7rem 0.6rem 0.7rem;
    }
  }
</style>
