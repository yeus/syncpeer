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
          {#if currentConnectTargetLabel}
            <span>Target: {currentConnectTargetLabel}</span>
          {/if}
          {#if currentConnectionModeLabel}
            <span>{currentConnectionModeLabel}</span>
          {/if}
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
  :global(body) {
    margin: 0;
    font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
    background: #f3f5f8;
    color: #1f2933;
  }

  :global(.app-shell) {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, #f7f9fc 0%, #edf2f7 100%);
    padding-top: env(safe-area-inset-top);
    overflow: hidden;
  }

  :global(.content) {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 0.9rem 0.8rem 0.9rem;
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  :global(.panel) {
    background: transparent;
    border: none;
    border-radius: 0;
    box-shadow: none;
    padding: 0.35rem 0;
  }

  .error-banner-panel {
    margin-bottom: 0.35rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #f0c6c6;
    border-radius: 8px;
    background: #fff1f1;
  }

  :global(.panel + .panel) {
    margin-top: 0.45rem;
    padding-top: 0.55rem;
    border-top: 1px solid #d4deea;
  }

  :global(.heading) {
    margin: 0 0 0.35rem;
    font-size: 0.94rem;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  :global(.heading-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
    margin-bottom: 0.35rem;
    flex-wrap: wrap;
  }

  :global(form.settings) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.45rem;
    margin-top: 0.35rem;
  }

  :global(label) {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
    color: #445366;
  }

  :global(.checkbox-row) {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    min-height: 42px;
  }

  :global(.inline-input) {
    margin-top: 0.35rem;
    max-width: 24rem;
  }

  :global(.checkbox-row input[type="checkbox"]) {
    width: 18px;
    height: 18px;
    margin: 0;
  }

  :global(input),
  :global(select) {
    padding: 0.4rem 0.45rem;
    font-size: 0.88rem;
    border: 1px solid #c7d2df;
    border-radius: 8px;
    background: #fff;
  }

  :global(textarea.recovery-secret) {
    width: 100%;
    min-height: 88px;
    resize: vertical;
    padding: 0.4rem 0.45rem;
    font-size: 0.78rem;
    border: 1px solid #c7d2df;
    border-radius: 8px;
    background: #fff;
    box-sizing: border-box;
    font-family: "IBM Plex Mono", monospace;
  }

  :global(.actions) {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.4rem;
    flex-wrap: wrap;
  }

  :global(button) {
    border: 1px solid #a6b7ca;
    border-radius: 8px;
    background: #ffffff;
    color: #1b3049;
    padding: 0.5rem 0.8rem;
    font-size: 0.9rem;
    min-height: 42px;
    cursor: pointer;
    transition:
      box-shadow 120ms ease,
      background-color 120ms ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    touch-action: manipulation;
  }

  :global(button.primary) {
    border-color: #0f4a93;
    background: #0f4a93;
    color: #fff;
  }

  :global(button.ghost) {
    border-color: #c8d4e2;
    background: #f8fbff;
  }

  :global(button.icon) {
    min-width: 2.3rem;
    padding: 0.35rem 0.5rem;
    text-align: center;
  }

  :global(button.icon-only) {
    width: 2.3rem;
    min-width: 2.3rem;
    padding: 0.35rem;
  }

  :global(button:disabled) {
    opacity: 0.55;
    cursor: not-allowed;
  }

  :global(button:active:not(:disabled)) {
    box-shadow: inset 0 0 0 999px rgba(15, 74, 147, 0.08);
  }

  .global-connect {
    margin-bottom: 0.35rem;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.45rem;
  }

  :global(.status-row) {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.8rem;
    color: #4c627a;
    margin-bottom: 0.4rem;
  }

  :global(.identity-inline) {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: flex-start;
    border: 1px solid #dbe3ee;
    border-radius: 10px;
    padding: 0.45rem 0.55rem;
    background: #fbfdff;
    margin-bottom: 0.45rem;
    flex-wrap: wrap;
  }

  :global(.status-chip) {
    display: inline-flex;
    align-items: center;
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  :global(.status-chip.online) {
    background: #d7f4e4;
    color: #0d7044;
  }

  :global(.status-chip.offline) {
    background: #fde3e3;
    color: #9c2d2d;
  }

  :global(.status-chip.small) {
    font-size: 0.68rem;
    padding: 0.08rem 0.35rem;
  }

  :global(details) {
    border: 1px solid #dbe3ee;
    border-radius: 10px;
    padding: 0.32rem 0.45rem;
    background: #fbfdff;
  }

  :global(summary) {
    cursor: pointer;
    font-size: 0.82rem;
    color: #304a66;
    font-weight: 600;
  }

  :global(.saved-device-editor) {
    display: grid;
    gap: 0.45rem;
  }

  :global(.breadcrumbs) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.4rem;
    font-size: 0.87rem;
  }

  :global(.crumb-separator) {
    color: #6f8297;
  }

  :global(.crumb-button) {
    border: none;
    background: none;
    color: #0f4a93;
    padding: 0;
    border-radius: 0;
  }

  :global(.crumb-current) {
    font-weight: 700;
    color: #1d334a;
  }

  :global(.list) {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid #dde5ef;
    border-radius: 8px;
    overflow: hidden;
  }

  :global(.list-item) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.35rem;
    padding: 0.42rem 0.5rem;
    border-bottom: 1px solid #eef2f7;
    background: #fff;
  }

  :global(.list-item:last-child) {
    border-bottom: none;
  }

  :global(.item-main) {
    min-width: 0;
  }

  :global(.item-title-row) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  :global(.item-title) {
    border: none;
    background: none;
    padding: 0;
    text-align: left;
    color: #163554;
    font-size: 0.88rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.item-meta) {
    font-size: 0.74rem;
    color: #61778f;
    overflow-wrap: anywhere;
  }

  :global(.log-error) {
    color: #a61b1b;
  }

  :global(.log-warning) {
    color: #9a5c00;
  }

  :global(.log-details) {
    margin: 0.35rem 0 0;
    font-family: "IBM Plex Mono", monospace;
    font-size: 0.7rem;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
    color: #263b52;
    background: #f4f8fc;
    border: 1px solid #d8e2ee;
    border-radius: 6px;
    padding: 0.35rem 0.4rem;
  }

  :global(.item-actions) {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    align-self: stretch;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  :global(.empty) {
    padding: 0.5rem;
    color: #607286;
    font-size: 0.86rem;
  }

  .error {
    margin: 0;
    color: #a61b1b;
    font-size: 0.84rem;
  }

  :global(.hint) {
    margin-top: 0.35rem;
    font-size: 0.78rem;
    color: #7c2d12;
  }

  .bottom-tabs {
    position: relative;
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    background: #101d2e;
    border-top: 1px solid #1d324e;
    padding: 0.45rem 0.45rem calc(0.45rem + env(safe-area-inset-bottom));
    gap: 0.35rem;
    z-index: 1000;
    pointer-events: auto;
  }

  .tab-button {
    border: 1px solid #4f6785;
    color: #d7e3f2;
    background: #15283f;
    border-radius: 8px;
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
    background: #d6e9ff;
    color: #0d3668;
    border-color: #d6e9ff;
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
    :global(.content) {
      padding: 0.7rem 0.6rem 0.7rem;
    }

    :global(form.settings) {
      grid-template-columns: 1fr;
    }

    :global(.list-item) {
      grid-template-columns: 1fr;
    }

    :global(.item-actions) {
      justify-content: flex-start;
    }
  }
</style>
