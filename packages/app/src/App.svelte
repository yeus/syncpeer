<svelte:options runes={true} />
<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import {
    createSyncpeerBrowserClient,
    createSyncpeerSessionStore,
    cachedFileKey,
    folderPasswordScopedKey,
    type SyncpeerProfileSettings,
  } from "@syncpeer/core/browser";
  import DiagnosticsPage from "./DiagnosticsPage.svelte";
  import AppHeader from "./components/AppHeader.svelte";
  import DeviceTab from "./components/DeviceTab.svelte";
  import FavoritesTab from "./components/FavoritesTab.svelte";
  import FoldersTab from "./components/FoldersTab.svelte";
  import PimTab from "./components/PimTab.svelte";
  import { createTauriAdapters } from "./lib/tauriAdapters.js";
  import { getAppBuildInfo } from "./lib/appInfo.ts";
  import {
    createAppActions,
    formatBytes,
    formatModified,
    rootFolderEntries,
  } from "./app/actions.ts";
  import { createNavigableAppActions } from "./app/navigation.ts";
  import { createDiagnosticsActions } from "./app/diagnosticsActions.ts";
  import {
    importProviderPimFromSyncthingFolder,
    initializePimFolder,
    pickAndroidPimDirectory,
    syncAndroidPimNow,
  } from "./app/pimActions.ts";
  import { createTransferRuntime } from "./app/transferRuntime.ts";
  import {
    activeFolderPasswords,
    connectionDetails,
    advertisedDevices,
    applySessionState,
    activeDownloadProgressPercent as downloadProgressPercent,
    activeDownloadSummary as downloadSummary,
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
    isLanDiscoveredDevice,
    isSavedDeviceAwaitingRemoteApproval,
    isSavedDeviceConnected,
    paginatedDirectoryEntries,
    persistState,
    pushClientLog,
    pushSessionLog,
    visibleBreadcrumbs,
    createInitialState,
    applySensitiveAppState,
    readLegacySensitiveState,
    readLegacyFolderPasswords,
    sensitiveAppState,
  } from "./app/state.ts";
  import { createEncryptedUiStateStore } from "./app/encryptedUiState.ts";
  import AboutPage from "./AboutPage.svelte";
  import FolderSettingsPage from "./FolderSettingsPage.svelte";
  import GeneralSettingsPage from "./GeneralSettingsPage.svelte";
  import NewFolderPage from "./NewFolderPage.svelte";
  import VersionsPage from "./VersionsPage.svelte";
  import { applyTheme } from "./app/theme.ts";
  import { documentStoragePreparationIssue } from "./app/storageErrors.ts";
  import { isConfiguredDeviceName, suggestedClientName } from "./app/suggestedNames.ts";
  import PersonalSpaceOnboarding from "./components/PersonalSpaceOnboarding.svelte";
  import { requestLocalDataReset } from "./app/localReset.ts";
  import FolderOpen from "lucide-svelte/icons/folder-open";
  import Smartphone from "lucide-svelte/icons/smartphone";
  import Star from "lucide-svelte/icons/star";
  import CalendarDays from "lucide-svelte/icons/calendar-days";

  type SyncpeerTestWindow = Window & {
    __syncpeerSetDownloadProgress?: (
      folderId: string,
      path: string,
      text: string,
      percent: number,
    ) => void;
    __syncpeerClearDownloadProgress?: () => void;
    __syncpeerDigestCachedFile?: (path: string) => Promise<string | null>;
    __syncpeerFolderProbe?: (folderId: string) => {
      page: string;
      activeTab: string;
      localRegistered: boolean;
      sessionRegistered: boolean;
      rootRegistered: boolean;
      rootCount: number;
      selectedFolder: boolean;
    };
    __syncpeerStateProbe?: () => {
      currentFolderId: string;
      currentPath: string;
      isConnected: boolean;
      isRefreshing: boolean;
      uploadMessage: string;
      uploadProgressActive: boolean;
      logs: Array<{ event: string; message: string }>;
    };
    __syncpeerStoreStateProbe?: () => {
      currentFolderId: string;
      currentPath: string;
      phase: string;
      hasRemoteFs: boolean;
      directoryStatus: string;
      requestEpoch: number;
    };
    __syncpeerReadCachedDocument?: (folderId: string, path: string) => Promise<number[] | null>;
    __syncpeerSetRelayPoolUrl?: (url: string) => void;
  };
  let app = $state(createInitialState());
  let systemPrefersDark = $state(false);
  let contentElement = $state<HTMLElement | null>(null);
  let privateStorageRecoveryMessage = $state<string | null>(null);
  let privateStorageResetPending = $state(false);
  let privateStorageResetError = $state("");
  let startupReady = $state(false);
  let vaultOnboardingMode = $state<"create" | "unlock" | null>(null);
  let skippedVaultOnboarding = $state(false);
  let skippedDeviceNamePrompt = $state(false);
  const showDeviceNamePrompt = $derived(
    startupReady &&
    app.currentPage === "main" &&
    !vaultOnboardingMode &&
    !skippedDeviceNamePrompt &&
    !app.ui.deviceNameConfirmed &&
    !isConfiguredDeviceName(app.connection.deviceName)
  );
  const onboardingSuggestedName = $derived(
    isConfiguredDeviceName(app.connection.deviceName)
      ? app.connection.deviceName.trim()
      : suggestedClientName()
  );

  async function resetPrivateStorage() {
    privateStorageResetPending = true;
    privateStorageResetError = "";
    try {
      await requestLocalDataReset({
        invoke: (command, args) => invoke(command, args),
        prompt: message => window.prompt(message),
        clearLocalState: () => window.localStorage.clear(),
      });
    } catch {
      privateStorageResetError = "Syncpeer could not reset its private local data. Nothing outside the app was changed.";
    } finally {
      privateStorageResetPending = false;
    }
  }

  const { hostAdapter, platformAdapter, documentCommand, connectDocumentFolder, disconnectDocumentFolder, syncDocumentFolders, folderCredentials, biometric, logFile } = createTauriAdapters({
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
  const appInfo = getAppBuildInfo();
  const transferRuntime = createTransferRuntime({
    state: app,
    client,
    runtimeSurface: appInfo.runtimeSurface,
  });
  const baseActions = createAppActions({
    state: app,
    client,
    sessionStore,
    transfers: transferRuntime,
    savePasswords: folderCredentials ? async passwords => {
      if (!app.passwords.secureStorage) throw new Error("Unlock folder storage before changing passwords.");
      await folderCredentials.save(passwords);
    } : undefined,
    logFile,
  });
  const actions = createNavigableAppActions({
    state: app,
    actions: baseActions,
    history: window.history,
    location: window.location,
    events: window,
  });
  const diagnosticsActions = createDiagnosticsActions({
    state: app,
    client,
    appInfo,
  });
  const pimDependencies = { state: app, client, sessionStore };

  let uiStateLoaded = false;

  const encryptedUiState = createEncryptedUiStateStore({
    command: documentCommand,
    readLegacy: readLegacySensitiveState,
    apply: value => applySensitiveAppState(app, value),
    onFailure: (event, error) => {
      try {
        pushSessionLog(app, "warning", event,
          "Encrypted app state could not be saved; the next change retries.",
          { message: error instanceof Error ? error.message : String(error) });
      } catch { /* Diagnostics must not block the app. */ }
    },
  });

  async function loadEncryptedUiState() {
    if (uiStateLoaded || !folderCredentials) return;
    const status = await documentCommand<{ vault: { phase: string } }>({ operation: "status" });
    if (status.vault.phase !== "unlocked") return;
    uiStateLoaded = await encryptedUiState.load();
  }

  const persistSensitiveState = () => encryptedUiState.scheduleSave(sensitiveAppState(app));

  const saveDeviceName = (name: string) => {
    app.connection.deviceName = name;
    app.ui.deviceNameConfirmed = true;
    persistState(app);
    persistSensitiveState();
  };

  async function loadFolderCredentials() {
    if (!folderCredentials) return;
    const status = await documentCommand<{ vault: { phase: string } }>({ operation: "status" });
    if (status.vault.phase !== "unlocked") return;
    await loadEncryptedUiState();
    const saved = await folderCredentials.load();
    const pending = { ...readLegacyFolderPasswords(), ...app.passwords.saved };
    for (const [id, password] of Object.entries(pending)) {
      if (saved[id] !== undefined && saved[id] !== password) throw new Error("Conflicting saved folder passwords require review.");
    }
    const merged = { ...pending, ...saved };
    await folderCredentials.merge(merged);
    const verifiedPasswords = await folderCredentials.load();
    if (Object.entries(merged).some(([id, value]) => verifiedPasswords[id] !== value)) {
      throw new Error("Encrypted credentials could not be verified; legacy data was retained.");
    }
    app.passwords.saved = merged;
    app.passwords.drafts = { ...merged };
    app.passwords.secureStorage = true;
    persistState(app, true);
    const knownFolders = Object.values(app.offline.snapshots).flatMap(snapshot => snapshot.folders)
      .map(folder => ({ ...folder, needsPassword: true }));
    app.localFolders = (await syncDocumentFolders(knownFolders, {})).map(folder => ({ ...folder, readOnly: false }));
    app.localFolders = (await syncDocumentFolders(app.session.folders, activeFolderPasswords(app)))
      .map(folder => ({ ...folder, readOnly: false }));
  }

  function applyProfileSettings(settings: SyncpeerProfileSettings) {
    app.favorites.exclusions = Object.values(settings.folders).flatMap(folder => folder.exclusions);
    app.favorites.ignorePatternsByFolder = Object.fromEntries(Object.entries(settings.folders)
      .map(([folderId, folder]) => [folderId, [...folder.ignorePatterns]]));
    app.favorites.pausedFolderIds = new Set(Object.entries(settings.folders)
      .filter(([, folder]) => folder.paused).map(([folderId]) => folderId));
  }

  async function unlockWithBiometric() {
    if (!biometric) throw new Error("Biometric unlock is unavailable.");
    if (!await biometric.authenticate()) throw new Error("Biometric authentication was not completed.");
    await documentCommand({ operation: "unlockRemembered" });
    await loadFolderCredentials();
  }

  async function rotateMasterPassword(password: string) {
    await documentCommand({ operation: "changeMasterPassword", password });
    await loadFolderCredentials();
  }

  async function importPeerFolder(peerId: string, folderId: string, password: string) {
    if (!app.session.isConnected || app.session.remoteDevice?.id !== peerId || !folderCredentials) {
      throw new Error("Reconnect to the approved peer first.");
    }
    const passwords = activeFolderPasswords(app);
    const recovered = password || passwords[folderId];
    if (!recovered) throw new Error("A folder password is required.");
    const overview = await client.connectAndGetOverview({ ...connectionDetails(app),
      folderPasswords: { ...passwords, [folderId]: recovered } });
    const folder = overview.folders.find(value => value.id === folderId);
    if (app.session.remoteDevice?.id !== peerId || !folder?.encrypted || folder.needsPassword) {
      throw new Error("The approved encrypted folder could not be unlocked.");
    }
    await connectDocumentFolder({ id: folder.id, label: folder.label || folder.id, password: recovered });
    const saved = { ...await folderCredentials.load(), [folderPasswordScopedKey(peerId, folderId)]: recovered };
    await folderCredentials.save(saved);
    await loadFolderCredentials();
    await sessionStore.actions.setFolderPasswords(activeFolderPasswords(app));
    await sessionStore.actions.refreshOverview(connectionDetails(app));
  }

  async function migrateDocumentFolder(folderId: string, target: "encrypted" | "plaintext") {
    if (target === "encrypted") {
      const folder = app.session.folders.find(value => value.id === folderId) ?? app.localFolders.find(value => value.id === folderId);
      await connectDocumentFolder({ id: folderId, label: folder?.label ?? folderId, password: activeFolderPasswords(app)[folderId] });
    } else await disconnectDocumentFolder(folderId);
    app.localFolders = (await syncDocumentFolders(app.session.folders, activeFolderPasswords(app)))
      .map(folder => ({ ...folder, readOnly: false }));
  }

  const unsubscribe = sessionStore.subscribe((next) => {
    applySessionState(app, next);
    void syncDocumentFolders(next.folders, activeFolderPasswords(app)).then(folders => {
      app.localFolders = folders.map(folder => ({ id: folder.id, label: folder.label, readOnly: false }));
      privateStorageRecoveryMessage = null;
    }).catch(async error => {
      const issue = documentStoragePreparationIssue(next.folders.length, error);
      app.ui.recentError = issue.message;
      privateStorageRecoveryMessage = issue.canResetPrivateStorage ? issue.message : null;
      try { app.localFolders = (await syncDocumentFolders([], {})).map(folder => ({ ...folder, readOnly: false })); }
      catch { /* Keep the last known roots if the service itself is unavailable. */ }
    });
    actions.syncNavigationRoute();
    if (
      next.phase === "connected" &&
      !next.pending.loadingDirectory &&
      (next.directory.status === "ready" || !next.currentFolderId)
    ) {
      void actions.restoreNavigationRoute(true);
    }
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
  let activeDownloads = $derived(Object.values(app.favorites.activeDownloads));
  let activeDownloadProgressPercent = $derived(downloadProgressPercent(activeDownloads));
  let activeDownloadSummary = $derived(downloadSummary(activeDownloads));
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
    encryptedUiState.cancelPendingSave();
    unsubscribe();
    actions.dispose();
    transferRuntime.dispose();
    void client.disconnect();
  };

  import.meta.hot?.dispose(cleanupAppRuntime);

  $effect(() => {
    persistState(app);
    persistSensitiveState();
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
    const stopNavigation = actions.startNavigation();
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => {
      systemPrefersDark = colorScheme.matches;
    };
    updateSystemTheme();
    colorScheme.addEventListener("change", updateSystemTheme);
    actions.setAppVisibility(document.visibilityState === "visible");
    void (async () => {
      const initialVault = await documentCommand<{ vault: { phase: string } }>({ operation: "status" })
        .catch(() => null);
      if (initialVault?.vault.phase === "unlocked") await loadFolderCredentials();
      else if (initialVault?.vault.phase === "locked" && biometric &&
        await biometric.status().then(status => status.enabled).catch(() => false)) {
        await unlockWithBiometric().catch(() => undefined);
      }
      await Promise.all([
        actions.hydrate(),
        actions.refreshCurrentDeviceId(),
      ]);
      actions.restoreOfflineSnapshot(undefined, "startup");
      await actions.restoreNavigationRoute(false);
      await actions.onAppForeground();
      await actions.restoreNavigationRoute(true);
      const finalVault = await documentCommand<{ vault: { phase: string } }>({ operation: "status" })
        .catch(() => null);
      if (finalVault && finalVault.vault.phase !== "unlocked") {
        pushSessionLog(app, "info", "app.personal_space.required",
          "Personal space must be created or unlocked.", { phase: finalVault.vault.phase });
        vaultOnboardingMode = finalVault.vault.phase === "locked" ? "unlock" : "create";
      }
    })().catch(() => {
      app.ui.recentError = "Unlock your personal space in Settings to restore saved passwords.";
    }).finally(() => {
      startupReady = true;
    });

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

    if (import.meta.env.SYNCPEER_LAN_E2E === true) {
      const testWindow = window as SyncpeerTestWindow;
      testWindow.__syncpeerSetRelayPoolUrl = (url: string) => {
        app.connection.relayPoolUrl = url;
      };
      testWindow.__syncpeerReadCachedDocument = async (folderId, path) => {
        const record = (await platformAdapter.listCachedFiles?.() ?? [])
          .find(file => file.folderId === folderId && file.path === path);
        if (!record?.localPath || !platformAdapter.readBinaryFile) return null;
        return Array.from(await platformAdapter.readBinaryFile(record.localPath));
      };
      testWindow.__syncpeerSetDownloadProgress = (
        folderId: string,
        path: string,
        text: string,
        percent: number,
      ) => {
        app.favorites.isDownloading = true;
        app.favorites.activeDownloads = {
          ...app.favorites.activeDownloads,
          [cachedFileKey(folderId, path)]: {
            name: path.split("/").pop() || path,
            text,
            progressPercent: Math.max(0, Math.min(100, percent)),
          },
        };
      };
      testWindow.__syncpeerClearDownloadProgress = () => {
        app.favorites.isDownloading = false;
        app.favorites.activeDownloads = {};
        app.ui.downloadNotice = "";
      };
      testWindow.__syncpeerDigestCachedFile = async (path: string) => {
        const matches = (await platformAdapter.listCachedFiles?.() ?? []).filter(file => file.path === path);
        if (matches.length !== 1 || !platformAdapter.digestCachedFiles) return null;
        return (await platformAdapter.digestCachedFiles([{ folderId: matches[0].folderId, path }]))[0]?.hash ?? null;
      };
      testWindow.__syncpeerStateProbe = () => ({
        currentFolderId: app.session.currentFolderId,
        currentPath: app.session.currentPath,
        isConnected: app.session.isConnected,
        isRefreshing: app.session.isRefreshing,
        uploadMessage: app.ui.uploadMessage,
        uploadProgressActive: app.ui.uploadProgressActive,
        logs: app.logs.items.slice(0, 20).map(({ event, message }) => ({ event, message })),
      });
      testWindow.__syncpeerStoreStateProbe = () => {
        const state = sessionStore.getState();
        return {
          currentFolderId: state.currentFolderId,
          currentPath: state.currentPath,
          phase: state.phase,
          hasRemoteFs: state.remoteFs !== null,
          directoryStatus: state.directory.status,
          requestEpoch: state.requestEpoch,
        };
      };
    }
    if (import.meta.env.DEV) {
      (window as SyncpeerTestWindow).__syncpeerFolderProbe = (folderId: string) => ({
        page: app.currentPage,
        activeTab: app.activeTab,
        localRegistered: app.localFolders.some(folder => folder.id === folderId),
        sessionRegistered: app.session.folders.some(folder => folder.id === folderId),
        rootRegistered: currentRootFolders.some(folder => folder.id === folderId),
        rootCount: currentRootFolders.length,
        selectedFolder: Boolean(app.session.currentFolderId),
      });
      (window as SyncpeerTestWindow).__syncpeerReadCachedDocument = async (folderId, path) => {
        const record = (await platformAdapter.listCachedFiles?.() ?? [])
          .find(file => file.folderId === folderId && file.path === path);
        if (!record?.localPath || !platformAdapter.readBinaryFile) return null;
        return Array.from(await platformAdapter.readBinaryFile(record.localPath));
      };
    }
    return () => {
      if (import.meta.env.SYNCPEER_LAN_E2E === true) {
        const testWindow = window as SyncpeerTestWindow;
        delete testWindow.__syncpeerSetRelayPoolUrl;
        delete testWindow.__syncpeerSetDownloadProgress;
        delete testWindow.__syncpeerClearDownloadProgress;
        delete testWindow.__syncpeerDigestCachedFile;
        delete testWindow.__syncpeerReadCachedDocument;
        delete testWindow.__syncpeerStateProbe;
        delete testWindow.__syncpeerStoreStateProbe;
      }
      if (import.meta.env.DEV) {
        const testWindow = window as SyncpeerTestWindow;
        delete testWindow.__syncpeerFolderProbe;
        delete testWindow.__syncpeerReadCachedDocument;
      }
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      colorScheme.removeEventListener("change", updateSystemTheme);
      stopNavigation();
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
      {#if skippedVaultOnboarding}
        <section class="panel" data-testid="setup-skipped-notice">
          <p><strong>Personal space not set up.</strong> You can inspect devices and copy session logs. Encrypted shared folders require setup or unlock.</p>
          <div class="actions">
            <button class="primary" type="button" data-testid="resume-personal-space-setup" onclick={async () => {
              const status = await documentCommand<{ vault: { phase: string } }>({ operation: "status" }).catch(() => null);
              if (!status) { app.ui.recentError = "Personal-space status is unavailable."; return; }
              skippedVaultOnboarding = false;
              if (status.vault.phase !== "unlocked") vaultOnboardingMode = status.vault.phase === "locked" ? "unlock" : "create";
            }}>Resume setup</button>
            <button type="button" onclick={() => void actions.copySessionLogs()}>Copy Logs</button>
          </div>
        </section>
      {/if}
      {#if app.ui.showStabilityNotice}
        <section class="panel" data-testid="stability-notice">
          <p>Syncpeer is still experimental. Keep a verified copy of important files on another Syncthing peer or in a separate backup; do not rely on this app as your only copy.</p>
          <button type="button" class="ghost" onclick={() => {
            app.ui.showStabilityNotice = false;
            persistState(app);
          }}>I understand</button>
        </section>
      {/if}
      {#if app.ui.recentError}
        <section class="panel error-banner-panel">
          <p class="error">{app.ui.recentError}</p>
          {#if privateStorageRecoveryMessage === app.ui.recentError}
            <div class="actions">
              <button
                type="button"
                data-testid="reset-unrecognized-private-storage"
                disabled={privateStorageResetPending}
                onclick={resetPrivateStorage}
              >{privateStorageResetPending ? "Resetting…" : "Reset Syncpeer local data"}</button>
            </div>
            {#if privateStorageResetError}<p class="error">{privateStorageResetError}</p>{/if}
          {/if}
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
          showDeviceNamePrompt={showDeviceNamePrompt}
          suggestedDeviceName={onboardingSuggestedName}
          onSaveDeviceName={saveDeviceName}
          onDismissDeviceNamePrompt={() => {
            skippedDeviceNamePrompt = true;
            pushSessionLog(app, "info", "app.device_name.deferred", "Device naming deferred for this session.");
          }}
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
          onOpenGeneralSettings={folderCredentials ? actions.openGeneralSettings : undefined}
          onCopyCurrentDeviceId={actions.copyCurrentDeviceId}
          onCopySessionLogs={actions.copySessionLogs}
          onSaveSessionLogs={logFile ? actions.saveSessionLogs : undefined}
          onShareSessionLogs={logFile ? actions.shareSessionLogs : undefined}
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
          onPickAndroidPimDirectory={() => pickAndroidPimDirectory(pimDependencies)}
          onInitializePimFolder={() => initializePimFolder(pimDependencies)}
          onSyncAndroidPimNow={() => syncAndroidPimNow(pimDependencies)}
          onImportProviderPimFromFolder={() =>
            importProviderPimFromSyncthingFolder(pimDependencies)}
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
          onCancelDownload={transferRuntime.cancelDownload}
          onRemoveFavorite={actions.removeFavorite}
          onRetryFavorite={actions.retryFavorite}
          onResolveFavoriteConflict={actions.resolveFavoriteConflict}
          onClearAllCache={actions.clearAllCache}
          {formatBytes}
          {formatModified}
        />
      {/if}

      {#if app.activeTab === "folders"}
        {#if appInfo.runtimeSurface === "android-ui" || appInfo.runtimeSurface === "desktop-ui"}
          <button class="new-folder-action" data-testid="new-folder" onclick={actions.openNewFolder}>New folder</button>
        {/if}
        <FoldersTab
          {app}
          breadcrumbs={currentBreadcrumbs}
          rootFolders={currentRootFolders}
          favoriteKeys={currentFavoriteKeys}
          onGoToRootView={actions.goToRootView}
          onGoToBreadcrumb={actions.goToBreadcrumb}
          onOpenFolderRoot={actions.openFolderRoot}
          onOpenFolderSettings={actions.openFolderSettings}
          onOpenVersions={actions.openVersions}
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
          onCancelDownload={transferRuntime.cancelDownload}
          onCancelTransfers={transferRuntime.cancelAll}
          onToggleFavorite={actions.toggleFavorite}
          isFolderLocked={(folderId) => folderIsLocked(app, folderId)}
          folderLockLabel={(folderId) => folderLockLabel(app, folderId)}
          folderState={(folderId) => folderState(app, folderId)}
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

    {#if app.ui.downloadNotice || activeDownloadSummary}
      <aside class="transfer-float" data-testid="transfer-float" aria-live="polite">
        <div class="transfer-float-text">
          {activeDownloadSummary || app.ui.downloadNotice}
        </div>
        {#if activeDownloadSummary}
          <div class="transfer-float-track" aria-hidden="true">
            <span
              style={`width: ${activeDownloadProgressPercent}%`}
            ></span>
          </div>
        {/if}
      </aside>
    {/if}

    <nav class="bottom-tabs" aria-label="Main navigation">
      <button
        type="button"
        class={`tab-button ${app.activeTab === "favorites" ? "active" : ""}`}
        aria-current={app.activeTab === "favorites" ? "page" : undefined}
        onclick={(event) => actions.switchTab("favorites", event)}
      >
        <Star size={18} aria-hidden="true" />
        <span class="tab-label">Favorites</span>
      </button>
      <button
        data-testid="tab-folders"
        type="button"
        class={`tab-button ${app.activeTab === "folders" ? "active" : ""}`}
        aria-current={app.activeTab === "folders" ? "page" : undefined}
        onclick={(event) => actions.switchTab("folders", event)}
      >
        <FolderOpen size={18} aria-hidden="true" />
        <span class="tab-label">Folders</span>
      </button>
      <button
        data-testid="tab-devices"
        type="button"
        class={`tab-button ${app.activeTab === "devices" ? "active" : ""}`}
        aria-current={app.activeTab === "devices" ? "page" : undefined}
        onclick={(event) => actions.switchTab("devices", event)}
      >
        <Smartphone size={18} aria-hidden="true" />
        <span class="tab-label">Devices</span>
      </button>
      <button
        data-testid="tab-pim"
        type="button"
        class={`tab-button ${app.activeTab === "pim" ? "active" : ""}`}
        aria-current={app.activeTab === "pim" ? "page" : undefined}
        onclick={(event) => actions.switchTab("pim", event)}
      >
        <CalendarDays size={18} aria-hidden="true" />
        <span class="tab-label">PIM</span>
      </button>
    </nav>
  </div>
{:else if app.currentPage === "diagnostics"}
  <DiagnosticsPage
    onBack={actions.closeDiagnosticsPage}
    onLoadCatalog={diagnosticsActions.loadDiagnosticsCatalog}
    onRunTest={diagnosticsActions.runDiagnosticsTestById}
    onRunCategory={diagnosticsActions.runDiagnosticsCategory}
    onRunAll={diagnosticsActions.runAllDiagnostics}
  />
{:else if app.currentPage === "general-settings"}
  <GeneralSettingsPage onBack={actions.closeGeneralSettings} onUnlock={loadFolderCredentials} onUnlockBiometric={unlockWithBiometric}
    onOpenFolderSettings={actions.openFolderSettings}
    command={documentCommand}
    onStartPairing={advertisedHost => client.startPairingInvitation({ advertisedHost, port: 0,
      confirm: code => window.confirm(`Confirm that both devices display pairing code ${code}.`) })}
    onJoinPairing={(invitation, password, remember) => client.joinPairingInvitation({ invitation, password, remember,
      confirm: code => window.confirm(`Confirm that both devices display pairing code ${code}.`) })}
    onTrustedDevicesChanged={() => client.disconnect()}
    getDefaultDeviceId={() => client.getDefaultDeviceId()}
    onPairedDevice={deviceId => {
      app.devices.newSavedDeviceId = deviceId;
      app.devices.newSavedDeviceCustomName = "Paired Syncpeer device";
      actions.addSavedDevice();
    }}
    onSettingsSaved={applyProfileSettings}
    onRotateMasterPassword={rotateMasterPassword} {biometric} />
{:else if app.currentPage === "folder-settings"}
  {@const selectedFolder = folderState(app, app.folderSettingsId)
    ?? app.localFolders.find(folder => folder.id === app.folderSettingsId)}
  {#key app.folderSettingsId}
    <FolderSettingsPage folderId={app.folderSettingsId} folderLabel={selectedFolder?.label ?? app.folderSettingsId}
      encrypted={Boolean(selectedFolder?.encrypted)} managedStorage={Boolean(folderCredentials)}
      passwordDraft={app.passwords.drafts[app.folderSettingsId] ?? activePasswords[app.folderSettingsId] ?? ""}
      passwordSaved={activePasswords[app.folderSettingsId] ?? ""} passwordError={selectedFolder?.passwordError ?? ""}
      actionError={app.ui.recentError ?? ""}
      onBack={actions.closeFolderSettings} onOpenGeneralSettings={actions.openGeneralSettings}
      onUpdatePassword={actions.updateFolderPasswordDraft} onSavePassword={actions.saveFolderPassword}
      onClearPassword={actions.clearFolderPassword}
      command={documentCommand} onImport={importPeerFolder}
      peerId={app.session.isConnected ? app.session.remoteDevice?.id ?? "" : ""}
      onRelease={(folderId, mode, confirmedText) => client.releaseLocalCopy(folderId, mode, confirmedText)}
      onSettingsSaved={applyProfileSettings} onMigrate={migrateDocumentFolder} />
  {/key}
{:else if app.currentPage === "new-folder"}
  <NewFolderPage onBack={actions.closeNewFolder} onOpenGeneralSettings={actions.openGeneralSettings}
    command={documentCommand} onCreate={async label => {
      const id = crypto.randomUUID();
      await connectDocumentFolder({ id, label });
      app.favorites.items = await client.upsertFavorite({ key: `folder:${id}:`, folderId: id,
        path: "", name: label, kind: "folder" });
      app.localFolders = (await syncDocumentFolders([], {})).map(folder => ({ ...folder, readOnly: false }));
      await actions.starredSync();
    }} />
{:else if app.currentPage === "versions"}
  <VersionsPage name={app.versions.name} items={app.versions.items} loading={app.versions.loading}
    restoringId={app.versions.restoringId} error={app.versions.error}
    onBack={actions.closeVersions} onRestore={actions.restoreVersion} />
{:else}
  <AboutPage onBack={actions.closeAboutPage} />
{/if}

{#if vaultOnboardingMode}
  <PersonalSpaceOnboarding
    mode={vaultOnboardingMode}
    suggestedName={onboardingSuggestedName}
    initialDeviceName={app.connection.deviceName}
    command={documentCommand}
    getDefaultDeviceId={() => client.getDefaultDeviceId()}
    biometric={biometric}
    onDeviceNameSaved={saveDeviceName}
    onSkip={() => {
      skippedVaultOnboarding = true;
      vaultOnboardingMode = null;
      try { pushSessionLog(app, "info", "app.personal_space.skipped", "Setup skipped for this session."); } catch { /* Do not block dismissal. */ }
    }}
    onCopyDiagnostics={async () => {
      pushSessionLog(app, "info", "app.personal_space.diagnostics", "Onboarding diagnostics requested.", {
        secureContext: window.isSecureContext,
        secureRandomAvailable: typeof globalThis.crypto?.getRandomValues === "function",
      });
      await actions.copySessionLogs();
    }}
    onGenerationEvent={(stage, reason) => {
      try {
        pushSessionLog(app, stage.endsWith("-failed") ? "warning" : "info",
          "app.personal_space.password_generation", "Password generation state changed.", { stage, reason });
      } catch { /* Diagnostics must not block setup. */ }
    }}
    onReady={async () => {
      skippedVaultOnboarding = false;
      vaultOnboardingMode = null;
      await loadFolderCredentials().catch(error => {
        app.ui.recentError = error instanceof Error ? error.message : String(error);
      });
      // Restored peers only exist after unlock; the startup foreground pass ran
      // before the vault was unlocked, so resume discovery and auto-connect here.
      void actions.onAppForeground();
    }}
    onOpenSettings={() => {
      skippedVaultOnboarding = false;
      vaultOnboardingMode = null;
      actions.openGeneralSettings();
    }}
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
    padding: 0.75rem;
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

  .connection-details {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 0;
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
    border-top: 0;
    padding: 0.45rem 0.45rem calc(0.45rem + env(safe-area-inset-bottom));
    gap: 0.35rem;
    z-index: 1000;
    pointer-events: auto;
  }

  .transfer-float {
    position: fixed;
    right: max(0.75rem, env(safe-area-inset-right));
    bottom: calc(4.45rem + env(safe-area-inset-bottom));
    left: max(0.75rem, env(safe-area-inset-left));
    z-index: 1100;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-width: 32rem;
    margin: 0 auto;
    padding: 0.5rem 0.6rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
    box-shadow: var(--shadow-soft);
    color: var(--text-secondary);
    pointer-events: none;
  }

  .transfer-float-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78rem;
  }

  .transfer-float-track {
    height: 2px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--bg-surface-muted);
  }

  .transfer-float-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--color-secondary);
    transition: width 120ms ease;
  }

  .tab-button {
    border: 0;
    color: var(--text-muted);
    background: transparent;
    border-radius: var(--radius-sm);
    font-weight: 700;
    gap: 0.4rem;
    font-size: 0.8rem;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
  }

  .tab-button.active {
    position: relative;
    background: var(--color-secondary-soft);
    color: var(--text-strong);
  }

  .tab-button.active::after {
    content: "";
    position: absolute;
    right: calc(50% - 0.65rem);
    bottom: 0.2rem;
    left: calc(50% - 0.65rem);
    height: 2px;
    border-radius: 2px;
    background: var(--color-secondary);
  }

  .new-folder-action { margin: 0 0 0.5rem; color: var(--color-primary); }

  .tab-label { white-space: nowrap; }

  @media (max-width: 640px) {
    .content {
      padding: 0.5rem;
    }
    .tab-button {
      flex-direction: column;
      gap: 0.2rem;
      padding: 0.35rem 0.2rem 0.55rem;
      font-size: 0.68rem;
    }
  }
</style>
