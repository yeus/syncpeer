<svelte:options runes={true} />
<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    createSyncpeerBrowserClient,
    createSyncpeerSessionStore,
  } from "@syncpeer/core/browser";
  import DiagnosticsPage from "./DiagnosticsPage.svelte";
  import AppHeader from "./components/AppHeader.svelte";
  import DeviceTab from "./components/DeviceTab.svelte";
  import FavoritesTab from "./components/FavoritesTab.svelte";
  import FoldersTab from "./components/FoldersTab.svelte";
  import PimTab from "./components/PimTab.svelte";
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
    isLanDiscoveredDevice,
    isSavedDeviceAwaitingRemoteApproval,
    isSavedDeviceConnected,
    paginatedDirectoryEntries,
    persistState,
    pushClientLog,
    pushSessionLog,
    visibleBreadcrumbs,
    createInitialState,
  } from "./app/state.ts";
  import AboutPage from "./AboutPage.svelte";
  import { applyTheme } from "./app/theme.ts";
  import FolderOpen from "lucide-svelte/icons/folder-open";
  import Smartphone from "lucide-svelte/icons/smartphone";
  import Star from "lucide-svelte/icons/star";
  import CalendarDays from "lucide-svelte/icons/calendar-days";

  let app = $state(createInitialState());
  let systemPrefersDark = $state(false);
  let contentElement = $state<HTMLElement | null>(null);

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
  let currentFavoriteKeys = $derived(favoriteKeys(app));
  let currentBreadcrumbs = $derived(visibleBreadcrumbs(app));
  let currentRootFolders = $derived(rootFolderEntries(app));
  let currentConnectionModeLabel = $derived(connectionModeLabel(app));
  let currentConnectTargetLabel = $derived(connectTargetLabel(app));
  let currentDirectoryEntries = $derived(paginatedDirectoryEntries(app));
  let currentDirectoryPage = $derived(directoryCurrentPage(app));
  let currentDirectoryTotalPages = $derived(directoryTotalPages(app));
  let contentScrollKey = $derived(
    `${app.currentPage}:${app.activeTab}:${app.session.currentFolderId}:${app.session.currentPath}`,
  );

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let localDiscoveryTimer: ReturnType<typeof setInterval> | null = null;

  const cleanupAppRuntime = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (localDiscoveryTimer) {
      clearInterval(localDiscoveryTimer);
      localDiscoveryTimer = null;
    }
    unsubscribe();
    actions.dispose();
    void client.disconnect();
  };

  import.meta.hot?.dispose(cleanupAppRuntime);

  $effect(() => {
    persistState(app);
  });

  $effect(() => {
    if (typeof document === "undefined") return;
    applyTheme(document.documentElement, app.ui.theme, systemPrefersDark);
  });

  $effect(() => {
    if (
      app.devices.savedDevices.length > 0 &&
      !app.devices.savedDevices.some(
        (device) => device.id === app.devices.selectedSavedDeviceId,
      )
    ) {
      const firstNonLanDiscovered = app.devices.savedDevices.find(
        (device) => !app.devices.lanDiscoveredDeviceIds.has(device.id),
      );
      app.devices.selectedSavedDeviceId = firstNonLanDiscovered?.id ?? "";
    } else if (app.devices.savedDevices.length === 0) {
      app.devices.selectedSavedDeviceId = "";
    }
  });

  $effect(() => {
    if (
      (app.connection.discoveryMode === "automatic" ||
        app.connection.discoveryMode === "global" ||
        app.connection.discoveryMode === "lan") &&
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

  $effect(() => {
    const scrollKey = contentScrollKey;
    const element = contentElement;
    if (!element) return;
    void tick().then(() => {
      if (contentScrollKey !== scrollKey) return;
      element.scrollTop = 0;
    });
  });

  onMount(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => {
      systemPrefersDark = colorScheme.matches;
    };
    updateSystemTheme();
    colorScheme.addEventListener("change", updateSystemTheme);
    actions.setAppVisibility(document.visibilityState === "visible");
    void (async () => {
      await Promise.all([
        actions.hydrate(),
        actions.refreshCurrentDeviceId(),
      ]);
      actions.restoreOfflineSnapshot(undefined, "startup");
      await actions.onAppForeground();
    })();

    const handleOnline = () => {
      void actions.onNetworkOnline();
      void actions.refreshActiveView();
    };
    const handleOffline = () => {
      void sessionStore.actions.setOnline(false);
    };
    const handleVisibilityChange = () => {
      const isVisible = document.visibilityState === "visible";
      actions.setAppVisibility(isVisible);
      if (isVisible) {
        void actions.onAppForeground();
        void actions.refreshActiveView();
      }
    };
    const handleFocus = () => {
      actions.setAppVisibility(true);
      void actions.onAppForeground();
      void actions.refreshActiveView();
    };
    const handlePageShow = () => {
      actions.setAppVisibility(document.visibilityState === "visible");
      void actions.onAppForeground();
      void actions.refreshActiveView();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      colorScheme.removeEventListener("change", updateSystemTheme);
    };
  });

  $effect(() => {
    if (app.currentPage !== "main") return;
    const intervalMs = app.activeTab === "folders" ? 15000 : 60000;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      void actions.refreshActiveView();
    }, intervalMs);
    return () => {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
    };
  });

  $effect(() => {
    if (app.currentPage !== "main") return;
    if (localDiscoveryTimer) clearInterval(localDiscoveryTimer);
    localDiscoveryTimer = setInterval(() => {
      void actions.discoverLocalDevices();
    }, 15000);
    return () => {
      if (localDiscoveryTimer) clearInterval(localDiscoveryTimer);
      localDiscoveryTimer = null;
    };
  });

  onDestroy(cleanupAppRuntime);
</script>

{#if app.currentPage === "main"}
  <div class="app-shell">
    <AppHeader
      phase={app.session.lifecyclePhase}
      connected={app.session.isConnected}
      paused={app.ui.autoConnectPaused}
      expanded={app.ui.isConnectionDetailsExpanded}
      onToggleDetails={() => {
        app.ui.isConnectionDetailsExpanded = !app.ui.isConnectionDetailsExpanded;
      }}
    />
    {#if app.ui.isConnectionDetailsExpanded}
      <section id="connection-details" class="connection-details" data-testid="connection-details">
        <div class="connection-details-main">
          <span>{currentConnectionModeLabel}</span>
          {#if app.session.connectionPath}
            <span>Path: {app.session.connectionPath}</span>
          {/if}
          {#if currentConnectTargetLabel}
            <span>Target: {currentConnectTargetLabel}</span>
          {/if}
        </div>
        {#if app.ui.expertView}
          <div class="connection-details-expert" data-testid="connection-expert-details">
            <span>Phase: {app.session.lifecyclePhase}</span>
            <span>Attempt: {app.session.reconnectAttempt}</span>
            {#if app.session.nextRetryAtMs}
              <span>Next retry: {new Date(app.session.nextRetryAtMs).toLocaleTimeString()}</span>
            {/if}
            {#if app.session.upgradeStatus !== "idle"}
              <span>Upgrade: {app.session.upgradeStatus}</span>
            {/if}
            {#if app.session.closureReason}
              <span>Last closure: {app.session.closureReason}</span>
            {/if}
            <button
              type="button"
              class="ghost expert-connection-control"
              data-testid="expert-connection-control"
              onclick={() => app.ui.autoConnectPaused
                ? actions.connect()
                : actions.disconnect()}
            >
              {app.ui.autoConnectPaused
                ? "Resume automatic connection"
                : "Pause automatic connection"}
            </button>
          </div>
        {/if}
      </section>
    {/if}
    <main class="content" data-testid="app-content" bind:this={contentElement}>
      {#if app.ui.recentError}
        <section class="panel error-banner-panel">
          <p class="error">{app.ui.recentError}</p>
        </section>
      {/if}
      {#if app.ui.downloadNotice}
        <section class="panel download-banner-panel">
          <p class="hint">{app.ui.downloadNotice}</p>
        </section>
      {/if}

      {#if app.approvals.pendingApprovalPromptDeviceId}
        <section class="panel">
          <p class="hint">
            Waiting for remote approval for <strong>{app.approvals.pendingApprovalPromptDeviceId}</strong>.
            The remote peer device should now show a prompt to accept this client. Once
            accepted, Syncpeer will retry automatically.
          </p>
          <div class="item-meta">{app.approvals.pendingApprovalPromptDeviceId}</div>
          <div class="actions">
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

      {#if app.activeTab === "devices"}
        <DeviceTab
          {app}
          advertisedDevices={currentAdvertisedDevices}
          isSavedDeviceConnected={(deviceId) => isSavedDeviceConnected(app, deviceId)}
          isSavedDeviceAwaitingRemoteApproval={(deviceId) =>
            isSavedDeviceAwaitingRemoteApproval(app, deviceId)}
          isLanDiscoveredDevice={(deviceId) => isLanDiscoveredDevice(app, deviceId)}
          currentSourceIsIntroducer={currentSourceIsIntroducer(app)}
          onUseSavedDevice={actions.useSavedDevice}
          onResetDiscoveryServer={actions.resetDiscoveryServer}
          onClearAllCache={actions.clearAllCache}
          onClearOfflineFolderState={actions.clearOfflineFolderState}
          onOpenDiagnosticsPage={actions.openDiagnosticsPage}
          onOpenAboutPage={actions.openAboutPage}
          onCopyCurrentDeviceId={actions.copyCurrentDeviceId}
          onCopySessionLogs={actions.copySessionLogs}
          onEditLocalDeviceName={actions.editLocalDeviceName}
          onRegenerateDeviceId={actions.regenerateDeviceId}
          onCopyIdentityBackupSecret={actions.copyIdentityBackupSecret}
          onRestoreIdentityRecovery={actions.restoreIdentityRecovery}
          onAddSavedDevice={actions.addSavedDevice}
          onApproveAdvertisedDevice={actions.approveAdvertisedDevice}
          onEditSavedDeviceName={actions.editSavedDeviceName}
          onSetSavedDeviceIntroducer={actions.setSavedDeviceIntroducer}
          onRemoveSavedDevice={actions.removeSavedDevice}
          onConnectLocalCandidate={actions.connectViaLanAnonymousCandidate}
          onConnectionSettingsChanged={actions.scheduleConnectionSettingsApply}
        />
      {/if}

      {#if app.activeTab === "pim"}
        <PimTab
          {app}
          onPickAndroidPimDirectory={actions.pickAndroidPimDirectory}
          onInitializePimFolder={actions.initializePimFolder}
          onSyncAndroidPimNow={actions.syncAndroidPimNow}
          onImportProviderPimFromFolder={actions.importProviderPimFromSyncthingFolder}
        />
      {/if}

      {#if app.activeTab === "favorites"}
        <FavoritesTab
          {app}
          onOpenDownloadedFilesPanel={actions.openDownloadedFilesPanel}
          onOpenFavorite={actions.openFavorite}
          onOpenCachedFile={actions.openCachedFile}
          onOpenCachedFileDirectory={actions.openCachedFileDirectory}
          onOpenCachedDirectory={actions.openCachedDirectory}
          onRemoveCachedFile={actions.removeCachedFile}
          onOpenOrDownloadFile={actions.openOrDownloadFile}
          onDownloadFile={actions.downloadFile}
          onCancelDownload={actions.cancelDownload}
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
          onGoToRootView={actions.goToRootView}
          onGoToBreadcrumb={actions.goToBreadcrumb}
          onOpenFolderRoot={actions.openFolderRoot}
          onOpenDirectory={actions.openDirectory}
          onSetDirectoryPage={actions.setDirectoryPage}
          onSetDirectoryPageSize={actions.setDirectoryPageSize}
          onSetDirectorySortMode={actions.setDirectorySortMode}
          onSetDirectoryNameFilter={actions.setDirectoryNameFilter}
          onSetDirectoryViewMode={(mode) => {
            app.ui.directoryViewMode = mode;
          }}
          onOpenCachedDirectory={actions.openCachedDirectory}
          onOpenCachedFile={actions.openCachedFile}
          onOpenCachedFileDirectory={actions.openCachedFileDirectory}
          onOpenOrDownloadFile={actions.openOrDownloadFile}
          onDownloadFile={actions.downloadFile}
          onCancelDownload={actions.cancelDownload}
          onCancelTransfers={actions.cancelTransfers}
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
          directoryViewMode={app.ui.directoryViewMode}
          directorySortMode={app.ui.directorySortMode}
          directoryNameFilter={app.ui.directoryNameFilter}
          {formatBytes}
          {formatModified}
          onHandleUploadClick={actions.handleUploadClick}
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
        data-testid="tab-folders"
        type="button"
        class={`tab-button ${app.activeTab === "folders" ? "active" : ""}`}
        onclick={(event) => actions.switchTab("folders", event)}
      >
        <FolderOpen size={18} aria-hidden="true" />
        <span class="sr-only">Folders</span>
      </button>
      <button
        data-testid="tab-devices"
        type="button"
        class={`tab-button ${app.activeTab === "devices" ? "active" : ""}`}
        onclick={(event) => actions.switchTab("devices", event)}
      >
        <Smartphone size={18} aria-hidden="true" />
        <span class="sr-only">Devices</span>
      </button>
      <button
        data-testid="tab-pim"
        type="button"
        class={`tab-button ${app.activeTab === "pim" ? "active" : ""}`}
        onclick={(event) => actions.switchTab("pim", event)}
      >
        <CalendarDays size={18} aria-hidden="true" />
        <span class="sr-only">PIM</span>
      </button>
    </nav>
  </div>
{:else if app.currentPage === "diagnostics"}
  <DiagnosticsPage
    onBack={actions.closeDiagnosticsPage}
    onLoadCatalog={actions.loadDiagnosticsCatalog}
    onRunTest={actions.runDiagnosticsTestById}
    onRunCategory={actions.runDiagnosticsCategory}
    onRunAll={actions.runAllDiagnostics}
  />
{:else}
  <AboutPage onBack={actions.closeAboutPage} />
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
    padding: 0.5rem 0;
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

  .download-banner-panel {
    margin-bottom: 0.5rem;
    padding: 0.45rem 0.6rem;
  }

  .connection-details {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border-default);
    background: var(--bg-surface-muted);
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  .connection-details-main,
  .connection-details-expert {
    display: flex;
    flex: 1 1 18rem;
    flex-wrap: wrap;
    gap: 0.2rem 0.85rem;
  }

  .connection-details-expert {
    color: var(--text-muted);
    align-items: center;
  }

  .expert-connection-control {
    min-height: 30px;
    padding: 0.2rem 0.5rem;
    font-size: 0.76rem;
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
    grid-template-columns: repeat(4, minmax(0, 1fr));
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
    position: relative;
    background: transparent;
    color: var(--color-primary);
  }

  .tab-button.active::after {
    content: "";
    position: absolute;
    right: 24%;
    bottom: -0.1rem;
    left: 24%;
    height: 2px;
    border-radius: 2px;
    background: var(--color-secondary);
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
      padding: 0.35rem 0 0.5rem;
    }
  }
</style>
