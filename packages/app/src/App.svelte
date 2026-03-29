<svelte:options runes={true} />
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    createSyncpeerBrowserClient,
    getDefaultDiscoveryServer,
    normalizeDiscoveryServer,
    buildConnectionDetails,
    fromConnectionSettings,
    toConnectionSettings,
    breadcrumbSegments,
    cachedFileKey,
    collectAdvertisedDevices,
    collectAdvertisedFolders,
    favoriteKey,
    folderDisplayName,
    formatEta,
    formatRate,
    isValidSyncthingDeviceId,
    normalizeDeviceId,
    normalizeFolderPasswords,
    normalizePath,
    normalizeSavedDevices,
    normalizeSyncApprovedIntroducedFolderKeys,
    resolveDirectoryPath,
    sleep,
    syncApprovedFolderKey,
    type BreadcrumbSegment,
    type CachedFileRecord,
    type ConnectOptions,
    type DiscoveryMode,
    type RemoteFsLike,
    type SavedDeviceLike,
    type StoredConnectionSettingsLike,
    type UiLogEntry,
    type FileEntry,
    type FolderInfo,
    type FolderSyncState,
    type RemoteDeviceInfo,
  } from "@syncpeer/core/browser";
  import {
    reportUiError,
    createTauriAdapters,
  } from "./lib/tauriAdapters.js";
  import {
    Download,
    ExternalLink,
    FolderOpen,
    KeyRound,
    RefreshCw,
    Settings,
    Star,
    StarOff,
    Trash2,
    Unlock,
  } from "lucide-svelte";

  type Tab = "favorites" | "folders" | "devices";

  interface RootFolderEntry {
    type: "root-folder";
    id: string;
    name: string;
    readOnly: boolean;
  }

  interface FavoriteItem {
    key: string;
    folderId: string;
    path: string;
    name: string;
    kind: "folder" | "file";
  }

  type StoredConnectionSettings = StoredConnectionSettingsLike;
  type SavedDevice = SavedDeviceLike;

  interface PersistedAppState {
    activeTab: Tab;
    selectedSavedDeviceId: string;
    connection: StoredConnectionSettings;
    savedDevices: SavedDevice[];
    syncApprovedIntroducedFolderKeys?: string[];
    acceptedIntroducedFolderKeys?: string[];
    folderPasswords?: Record<string, string>;
  }

  interface SessionLogItem {
    id: string;
    timestampMs: number;
    level: "info" | "warning" | "error";
    event: string;
    message: string;
    details?: unknown;
  }

  interface AdvertisedDeviceItem {
    id: string;
    name: string;
    sourceFolderIds: string[];
    accepted: boolean;
  }

  interface AdvertisedFolderItem {
    key: string;
    folderId: string;
    label: string;
    sourceDeviceId: string;
    syncApproved: boolean;
  }

  const APP_STATE_STORAGE_KEY = "syncpeer.ui.state.v1";
  const REFRESH_MS = 3000;
  const MAX_VISIBLE_CRUMBS = 4;
  const FOLDER_PASSWORD_SCOPE_SEPARATOR = ":";

  const parseJson = <T,>(raw: string | null): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const loadPersistedAppState = (): PersistedAppState | null => {
    if (typeof window === "undefined") return null;
    return parseJson<PersistedAppState>(
      window.localStorage.getItem(APP_STATE_STORAGE_KEY),
    );
  };

  const persistAppState = (state: PersistedAppState): void => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      APP_STATE_STORAGE_KEY,
      JSON.stringify(state),
    );
  };

  const isScopedFolderPasswordKey = (value: string): boolean => {
    const separatorIndex = value.indexOf(FOLDER_PASSWORD_SCOPE_SEPARATOR);
    if (separatorIndex <= 0) return false;
    const possibleDeviceId = normalizeDeviceId(value.slice(0, separatorIndex));
    if (!possibleDeviceId) return false;
    const scopedFolderId = value
      .slice(separatorIndex + FOLDER_PASSWORD_SCOPE_SEPARATOR.length)
      .trim();
    return scopedFolderId !== "";
  };

  const folderPasswordScopedKey = (
    sourceDeviceId: string,
    folderId: string,
  ): string => {
    const normalizedFolderId = folderId.trim();
    if (!normalizedFolderId) return "";
    const normalizedDeviceId = normalizeDeviceId(sourceDeviceId);
    if (!normalizedDeviceId) return normalizedFolderId;
    return `${normalizedDeviceId}${FOLDER_PASSWORD_SCOPE_SEPARATOR}${normalizedFolderId}`;
  };

  const resolveFolderPasswordsForDevice = (
    passwordStore: Record<string, string>,
    sourceDeviceId: string,
  ): Record<string, string> => {
    const normalizedDeviceId = normalizeDeviceId(sourceDeviceId);
    const scopedPrefix =
      normalizedDeviceId === ""
        ? ""
        : `${normalizedDeviceId}${FOLDER_PASSWORD_SCOPE_SEPARATOR}`;
    const resolved: Record<string, string> = {};

    if (scopedPrefix !== "") {
      for (const [storedKey, storedPassword] of Object.entries(passwordStore)) {
        if (!storedKey.startsWith(scopedPrefix)) continue;
        const folderId = storedKey.slice(scopedPrefix.length).trim();
        if (!folderId) continue;
        resolved[folderId] = storedPassword;
      }
    }

    // Backward compatibility with old non-scoped storage.
    for (const [storedKey, storedPassword] of Object.entries(passwordStore)) {
      const folderId = storedKey.trim();
      if (!folderId || isScopedFolderPasswordKey(folderId)) continue;
      if (!(folderId in resolved)) {
        resolved[folderId] = storedPassword;
      }
    }

    return resolved;
  };

  const folderState = (folderId: string): FolderInfo | undefined =>
    folders.find((folder) => folder.id === folderId);
  const folderIsLocked = (folderId: string): boolean => {
    const folder = folderState(folderId);
    return !!folder?.encrypted && !!folder?.needsPassword;
  };
  const folderLockLabel = (folderId: string): string => {
    const folder = folderState(folderId);
    if (!folder?.encrypted) return "";
    if (folder.passwordError) return "password error";
    return folder.needsPassword ? "locked" : "unlocked";
  };

  const persistedState = loadPersistedAppState();
  const initialSettings = fromConnectionSettings(
    persistedState?.connection ?? null,
  );

  let activeTab = $state<Tab>(
    persistedState?.activeTab === "devices" ||
      persistedState?.activeTab === "folders"
      ? persistedState.activeTab
      : "favorites",
  );

  let connection = $state<StoredConnectionSettings>({
    host: initialSettings.host,
    port: initialSettings.port,
    cert: initialSettings.cert,
    key: initialSettings.key,
    remoteId: initialSettings.remoteId,
    deviceName: initialSettings.deviceName,
    timeoutMs: initialSettings.timeoutMs,
    discoveryMode: initialSettings.discoveryMode,
    discoveryServer: initialSettings.discoveryServer,
    enableRelayFallback: initialSettings.enableRelayFallback,
    autoAcceptNewDevices: initialSettings.autoAcceptNewDevices,
    autoAcceptIntroducedFolders: initialSettings.autoAcceptIntroducedFolders,
  });

  let remoteFs = $state<RemoteFsLike | null>(null);
  let isConnected = $state(false);
  let isConnecting = $state(false);
  let isRefreshing = $state(false);
  let isLoadingDirectory = $state(false);
  let isDownloading = $state(false);
  let activeDownloadKey = $state("");
  let activeDownloadText = $state("");
  let isOpeningCachedFile = $state(false);
  let isRemovingCachedFile = $state(false);
  let isClearingCache = $state(false);
  let isLoadingDownloadedFiles = $state(false);
  let showDownloadedFiles = $state(false);
  let isSettingsExpanded = $state(false);
  let uploadMessage = $state("");
  let lastUpdatedAt = $state("");
  let activeConnectDeviceId = $state("");

  let folders = $state<FolderInfo[]>([]);
  let entries = $state<FileEntry[]>([]);
  let remoteDevice = $state<RemoteDeviceInfo | null>(null);
  let folderSyncStates = $state<FolderSyncState[]>([]);
  let currentFolderVersionKey = $state("");

  let currentFolderId = $state("");
  let currentPath = $state("");
  let directoryLoadSeq = $state(0);

  const initialSavedDevices = normalizeSavedDevices(persistedState?.savedDevices);
  let favorites = $state<FavoriteItem[]>([]);
  let savedDevices = $state<SavedDevice[]>(initialSavedDevices);
  let syncApprovedIntroducedFolderKeys = $state<Set<string>>(normalizeSyncApprovedIntroducedFolderKeys(
    persistedState?.syncApprovedIntroducedFolderKeys ??
      persistedState?.acceptedIntroducedFolderKeys,
  ));
  let selectedSavedDeviceId = $state(
    normalizeDeviceId(persistedState?.selectedSavedDeviceId || initialSavedDevices[0]?.id || ""),
  );
  const initialFolderPasswords = normalizeFolderPasswords(
    persistedState?.folderPasswords,
  );
  let folderPasswords = $state(initialFolderPasswords);
  let folderPasswordDrafts = $state<Record<string, string>>({
    ...initialFolderPasswords,
  });
  let folderPasswordInputVisible = $state<Record<string, boolean>>({});
  const activeFolderPasswordScopeDeviceId = (): string =>
    normalizeDeviceId(remoteDevice?.id ?? connection.remoteId ?? selectedSavedDeviceId);
  let activeFolderPasswords = $derived(resolveFolderPasswordsForDevice(
    folderPasswords,
    activeFolderPasswordScopeDeviceId(),
  ));
  let newSavedDeviceName = $state("");
  let newSavedDeviceId = $state("");
  let cachedFileKeys = $state(new Set<string>());
  let downloadedFiles = $state<CachedFileRecord[]>([]);
  let newSavedDeviceIsIntroducer = $state(false);

  let connectionModeLabel = $state("");
  let connectionPath = $state("");
  let connectionTransport = $state<"direct-tcp" | "relay" | "">("");
  let recentError = $state<string | null>(null);
  let sessionLogs = $state<SessionLogItem[]>([]);
  let isLogPanelExpanded = $state(false);
  let lastLoggedError = $state("");
  let identityRecoverySecret = $state("");
  let exportedIdentityDeviceId = $state("");
  let exportedIdentitySecret = $state("");
  let isExportingIdentityRecovery = $state(false);
  let isRestoringIdentityRecovery = $state(false);
  let remoteApprovalPendingIds = $state<Set<string>>(new Set());

  let error = $state<string | null>(null);
  let nextSessionLogId = $state(1);

  const pushSessionLog = (
    level: "info" | "warning" | "error",
    event: string,
    message: string,
    details?: unknown,
  ) => {
    const entry: SessionLogItem = {
      id: `${Date.now()}-${nextSessionLogId}`,
      timestampMs: Date.now(),
      level,
      event,
      message,
      details,
    };
    nextSessionLogId += 1;
    sessionLogs = [entry, ...sessionLogs].slice(0, 300);
  };

  const classifyUiLogLevel = (
    entry: UiLogEntry,
    details: Record<string, unknown> | undefined,
  ): "info" | "warning" | "error" => {
    if (
      entry.event === "tauri.invoke.error" &&
      isConnecting &&
      (details?.command === "syncpeer_tls_open" ||
        details?.command === "syncpeer_relay_open")
    ) {
      return "warning";
    }
    if (
      entry.event === "core.discovery.candidate.failed" ||
      entry.event === "core.discovery.relay.failed"
    ) {
      return "warning";
    }
    return entry.level;
  };

  const pushClientLog = (entry: UiLogEntry) => {
    const details =
      entry.details !== undefined &&
      entry.details !== null &&
      typeof entry.details === "object"
        ? (entry.details as Record<string, unknown>)
        : undefined;
    const level = classifyUiLogLevel(entry, details);
    const messageCandidate = details?.message;
    const message =
      typeof messageCandidate === "string" && messageCandidate.trim() !== ""
        ? messageCandidate
        : entry.event;
    pushSessionLog(level, entry.event, message, entry.details);
  };

  const setError = (event: string, rawError: unknown, context?: unknown) => {
    const message =
      rawError instanceof Error ? rawError.message : String(rawError);
    error = message;
    pushSessionLog("error", event, message, context);
  };

  const shouldHintRemoteApprovalPending = (message: string): boolean => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("may be waiting for you to accept this device") ||
      normalized.includes("remote peer rejected this device") ||
      normalized.includes("unknown device") ||
      normalized.includes("not configured") ||
      normalized.includes("not in config")
    );
  };

  const setRemoteApprovalPending = (
    deviceId: string,
    pending: boolean,
  ): void => {
    const normalized = normalizeDeviceId(deviceId);
    if (!normalized) return;
    const next = new Set(remoteApprovalPendingIds);
    if (pending) {
      next.add(normalized);
    } else {
      next.delete(normalized);
    }
    remoteApprovalPendingIds = next;
  };

  const isSavedDeviceAwaitingRemoteApproval = (deviceId: string): boolean =>
    remoteApprovalPendingIds.has(normalizeDeviceId(deviceId));

  const { hostAdapter, platformAdapter } = createTauriAdapters({
    onLog: pushClientLog,
  });
  const client = createSyncpeerBrowserClient({
    hostAdapter,
    platformAdapter,
    onLog: pushClientLog,
  });

  const refreshTimer = setInterval(() => {
    void refreshActiveView();
  }, REFRESH_MS);

  onDestroy(() => {
    clearInterval(refreshTimer);
    void client.disconnect?.();
  });

  onMount(() => {
    void hydratePersistedState();
  });

  const connectionDetails = (): ConnectOptions =>
    buildConnectionDetails(connection, activeFolderPasswords);

  const clearDirectoryView = (): void => {
    currentFolderId = "";
    currentPath = "";
    entries = [];
    currentFolderVersionKey = "";
  };

  const resetConnectionRuntimeState = (): void => {
    isConnected = false;
    remoteFs = null;
    remoteDevice = null;
    folders = [];
    entries = [];
    folderSyncStates = [];
    connectionPath = "";
    connectionTransport = "";
    activeConnectDeviceId = "";
    recentError = null;
  };

  const applyOverviewSnapshot = (
    overview: {
      folders: FolderInfo[];
      device: RemoteDeviceInfo | null;
      folderSyncStates: FolderSyncState[];
      connectedVia: string;
      transportKind: "direct-tcp" | "relay";
    },
  ): void => {
    folders = overview.folders;
    remoteDevice = overview.device;
    folderSyncStates = overview.folderSyncStates ?? [];
    connectionPath = overview.connectedVia;
    connectionTransport = overview.transportKind;
  };

  const ensureCurrentFolderExists = (): void => {
    if (!currentFolderId) return;
    if (!folders.some((folder) => folder.id === currentFolderId)) {
      clearDirectoryView();
    }
  };

  const waitForFoldersToPopulate = async (timeoutMs = 4000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isConnected) {
      if (folders.length > 0) return;
      const overview = await client.connectAndGetOverview(connectionDetails());
      applyOverviewSnapshot(overview);
      ensureCurrentFolderExists();
      if (folders.length > 0) return;
      await sleep(200);
    }
  };

  const waitForFolderIndexToArrive = async (
    folderId: string,
    timeoutMs = 3500,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isConnected) {
      const syncState = folderSyncStates.find((item) => item.folderId === folderId);
      if (syncState?.indexReceived) return true;
      const versions = await Promise.race<FolderSyncState[] | null>([
        client.connectAndGetFolderVersions(connectionDetails()),
        sleep(1200).then(() => null),
      ]);
      if (!versions) {
        pushSessionLog(
          "warning",
          "folder.index.poll.timeout",
          `Timed out fetching folder sync states for ${folderId}.`,
        );
        await sleep(150);
        continue;
      }
      folderSyncStates = versions;
      if (versions.find((item) => item.folderId === folderId)?.indexReceived) {
        return true;
      }
      await sleep(150);
    }
    const received = !!folderSyncStates.find((item) => item.folderId === folderId)?.indexReceived;
    if (!received) {
      pushSessionLog(
        "warning",
        "folder.index.not_received",
        `Folder index not received yet for ${folderId}.`,
      );
    }
    return received;
  };

  const rootFolderEntries = (): RootFolderEntry[] =>
    folders
      .map((folder) => ({
        type: "root-folder" as const,
        id: folder.id,
        name: folderDisplayName(folder),
        readOnly: folder.readOnly,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  const folderVersionKey = (folderId: string): string => {
    const syncState = folderSyncStates.find(
      (state) => state.folderId === folderId,
    );
    if (!syncState) return "";
    return `${syncState.remoteIndexId}:${syncState.remoteMaxSequence}`;
  };

  const downloadButtonLabel = (folderId: string, path: string): string => {
    const keyValue = cachedFileKey(folderId, path);
    if (keyValue !== activeDownloadKey) return "Download";
    return activeDownloadText || "Downloading...";
  };
  const inferPlatformLabel = (): string => {
    if (typeof navigator === "undefined") return "device";
    const uaDataPlatform =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? "";
    const platform = `${uaDataPlatform} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
    if (platform.includes("android")) return "android";
    if (
      platform.includes("iphone") ||
      platform.includes("ipad") ||
      platform.includes("ios")
    ) {
      return "ios";
    }
    if (platform.includes("mac")) return "mac";
    if (platform.includes("win")) return "windows";
    if (platform.includes("linux")) return "linux";
    return "device";
  };
  const suggestedClientName = (): string => {
    if (typeof window !== "undefined") {
      const host = window.location.hostname.trim().toLowerCase();
      if (
        host &&
        host !== "localhost" &&
        host !== "127.0.0.1" &&
        host !== "tauri.localhost"
      ) {
        return `syncpeer-${host}`;
      }
    }
    return `syncpeer-${inferPlatformLabel()}`;
  };
  const ensureClientNameBeforeConnect = (): boolean => {
    const currentName = connection.deviceName.trim();
    if (currentName !== "" && currentName !== "syncpeer-ui") {
      connection.deviceName = currentName;
      return true;
    }
    const chosen =
      typeof window !== "undefined"
        ? window.prompt(
            "Name this Syncpeer client (shown to remote devices):",
            suggestedClientName(),
          )
        : suggestedClientName();
    if (chosen === null) {
      error = "Connection cancelled. Client name is required.";
      return false;
    }
    const normalized = chosen.trim();
    if (!normalized) {
      error = "Client name is required.";
      return false;
    }
    connection.deviceName = normalized;
    return true;
  };
  const isSavedDeviceConnected = (deviceId: string): boolean =>
    isConnected &&
    normalizeDeviceId(remoteDevice?.id ?? connection.remoteId) ===
      normalizeDeviceId(deviceId);
  const isIntroducerDevice = (deviceId: string): boolean => {
    const normalized = normalizeDeviceId(deviceId);
    return savedDevices.some(
      (device) =>
        normalizeDeviceId(device.id) === normalized && device.isIntroducer,
    );
  };
  const currentSourceDeviceId = (): string =>
    normalizeDeviceId(remoteDevice?.id ?? connection.remoteId);
  const currentSourceIsIntroducer = (): boolean =>
    isConnected && isIntroducerDevice(currentSourceDeviceId());
  const upsertSavedDeviceEntry = (deviceId: string, deviceName?: string): boolean => {
    const normalizedId = normalizeDeviceId(deviceId);
    if (!normalizedId) return false;
    const displayName = (deviceName ?? "").trim() || normalizedId;
    const existing = savedDevices.find((device) => device.id === normalizedId);
    if (existing) {
      savedDevices = savedDevices
        .map((device) =>
          device.id === normalizedId
            ? { ...device, name: displayName }
            : device,
        )
        .sort((a, b) => a.name.localeCompare(b.name));
    } else {
      savedDevices = [
        ...savedDevices,
        {
          id: normalizedId,
          name: displayName,
          createdAtMs: Date.now(),
          isIntroducer: false,
        },
      ].sort((a, b) => a.name.localeCompare(b.name));
    }
    return true;
  };
  const setSavedDeviceIntroducer = (deviceId: string, isIntroducer: boolean): void => {
    const normalizedId = normalizeDeviceId(deviceId);
    savedDevices = savedDevices
      .map((device) =>
        normalizeDeviceId(device.id) === normalizedId
          ? { ...device, isIntroducer }
          : device,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  const applyAutoAcceptForAdvertisedDevices = (
    availableFolders: FolderInfo[],
    sourceDeviceId: string,
    sourceIsIntroducer: boolean,
  ): void => {
    if (!connection.autoAcceptNewDevices) return;
    const nextAdvertised = collectAdvertisedDevices(
      availableFolders,
      savedDevices,
      sourceDeviceId,
      sourceIsIntroducer,
    );
    const pending = nextAdvertised.filter((device) => !device.accepted);
    if (pending.length === 0) return;
    for (const device of pending) {
      if (!isValidSyncthingDeviceId(device.id)) continue;
      upsertSavedDeviceEntry(device.id, device.name);
    }
  };
  const applyAutoAcceptForAdvertisedFolders = (
    availableFolders: FolderInfo[],
    sourceDeviceId: string,
    sourceIsIntroducer: boolean,
  ): void => {
    if (!connection.autoAcceptIntroducedFolders) return;
    const nextAdvertised = collectAdvertisedFolders(
      availableFolders,
      sourceDeviceId,
      sourceIsIntroducer,
      syncApprovedIntroducedFolderKeys,
    );
    const pending = nextAdvertised.filter((folder) => !folder.syncApproved);
    if (pending.length === 0) return;
    const next = new Set(syncApprovedIntroducedFolderKeys);
    for (const folder of pending) {
      next.add(folder.key);
    }
    syncApprovedIntroducedFolderKeys = next;
  };
  const updateFolderPasswordDraft = (folderId: string, password: string): void => {
    folderPasswordDrafts = {
      ...folderPasswordDrafts,
      [folderId]: password,
    };
  };
  const handleFolderPasswordInput = (folderId: string, event: Event): void => {
    const target = event.currentTarget;
    updateFolderPasswordDraft(
      folderId,
      target instanceof HTMLInputElement ? target.value : "",
    );
  };
  const isFolderPasswordInputVisible = (folderId: string): boolean => {
    if (folderPasswordInputVisible[folderId]) return true;
    if (!folderState(folderId)?.encrypted) return false;
    if (folderIsLocked(folderId)) return true;
    if (folderState(folderId)?.passwordError) return true;
    return !activeFolderPasswords[folderId];
  };
  const openFolderPasswordInput = (folderId: string): void => {
    folderPasswordInputVisible = {
      ...folderPasswordInputVisible,
      [folderId]: true,
    };
  };
  const hideFolderPasswordInput = (folderId: string): void => {
    folderPasswordInputVisible = {
      ...folderPasswordInputVisible,
      [folderId]: false,
    };
  };
  const saveFolderPassword = async (folderId: string): Promise<void> => {
    const password = (folderPasswordDrafts[folderId] ?? "").trim();
    const scopedKey = folderPasswordScopedKey(
      activeFolderPasswordScopeDeviceId(),
      folderId,
    );
    if (!password) {
      const next = { ...folderPasswords };
      delete next[folderId];
      if (scopedKey) {
        delete next[scopedKey];
      }
      folderPasswords = next;
      hideFolderPasswordInput(folderId);
      return;
    }
    folderPasswords = {
      ...folderPasswords,
      [scopedKey || folderId]: password,
    };
    hideFolderPasswordInput(folderId);
    if (isConnected) {
      await refreshOverview();
      if (!folderIsLocked(folderId)) {
        try {
          await remoteFs?.readDir(folderId, "");
        } catch {
          // Keep the action resilient; periodic refresh will retry.
        }
        if (currentFolderId === folderId) {
          await loadCurrentDirectory();
        }
      }
    }
  };
  const clearFolderPassword = async (folderId: string): Promise<void> => {
    const scopedKey = folderPasswordScopedKey(
      activeFolderPasswordScopeDeviceId(),
      folderId,
    );
    const next = { ...folderPasswords };
    delete next[folderId];
    if (scopedKey) {
      delete next[scopedKey];
    }
    folderPasswords = next;
    folderPasswordDrafts = {
      ...folderPasswordDrafts,
      [folderId]: "",
    };
    openFolderPasswordInput(folderId);
    if (isConnected) {
      await refreshOverview();
    }
  };

  let favoriteKeys = $derived(new Set(favorites.map((item) => item.key)));
  let advertisedDevices = $derived(collectAdvertisedDevices(
    folders,
    savedDevices,
    currentSourceDeviceId(),
    currentSourceIsIntroducer(),
  ));
  let advertisedFolders = $derived(collectAdvertisedFolders(
    folders,
    currentSourceDeviceId(),
    currentSourceIsIntroducer(),
    syncApprovedIntroducedFolderKeys,
  ));
  let visibleBreadcrumbs = $derived(breadcrumbSegments(
    currentFolderId,
    currentPath,
    folders,
    MAX_VISIBLE_CRUMBS,
  ));

  $effect(() => {
    persistAppState({
      activeTab,
      selectedSavedDeviceId,
      connection: toConnectionSettings(connection),
      savedDevices,
      syncApprovedIntroducedFolderKeys: [...syncApprovedIntroducedFolderKeys].sort(),
      folderPasswords,
    });
  });

  $effect(() => {
    if (
      savedDevices.length > 0 &&
      !savedDevices.some((device) => device.id === selectedSavedDeviceId)
    ) {
      selectedSavedDeviceId = savedDevices[0].id;
    } else if (savedDevices.length === 0) {
      selectedSavedDeviceId = "";
    }
  });

  $effect(() => {
    if (connection.discoveryMode === "global" && connection.host === "127.0.0.1") {
      connection.host = "";
    }
  });

  $effect(() => {
    if (error && error !== lastLoggedError) {
      lastLoggedError = error;
      pushSessionLog("error", "ui.error", error);
    }
  });

  $effect(() => {
    const normalizedId = normalizeDeviceId(newSavedDeviceId);
    if (!normalizedId) return;
    const advertised = advertisedDevices.find(
      (device) => normalizeDeviceId(device.id) === normalizedId,
    );
    if (!advertised?.name) return;
    if (!newSavedDeviceName.trim()) {
      newSavedDeviceName = advertised.name;
    }
  });

  async function hydratePersistedState() {
    try {
      favorites = await client.listFavorites();
      const fileFavoritesByFolder = new Map<string, string[]>();
      for (const favorite of favorites) {
        if (favorite.kind !== "file") continue;
        if (!fileFavoritesByFolder.has(favorite.folderId)) {
          fileFavoritesByFolder.set(favorite.folderId, []);
        }
        fileFavoritesByFolder.get(favorite.folderId)?.push(favorite.path);
      }
      for (const [folderId, paths] of fileFavoritesByFolder) {
        await refreshCachedStatuses(folderId, paths);
      }
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("hydrate_state.failed", rawError);
    }
  }

  async function refreshCachedStatuses(folderId: string, paths: string[]) {
    if (!folderId || paths.length === 0) return;
    try {
      const statuses = await client.getCachedStatuses(
        folderId,
        paths.map((item) => normalizePath(item)),
      );
      const next = new Set(cachedFileKeys);
      for (const status of statuses) {
        const keyValue = cachedFileKey(folderId, status.path);
        if (status.available) {
          next.add(keyValue);
        } else {
          next.delete(keyValue);
        }
      }
      cachedFileKeys = next;
    } catch (rawError: unknown) {
      reportUiError("refresh_cached_statuses.failed", rawError, {
        folderId,
        count: paths.length,
      });
    }
  }

  async function refreshFolderRootCachedStatuses(folderIds: string[]) {
    const uniqueFolderIds = [...new Set(folderIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueFolderIds.length === 0) return;
    try {
      const responses = await Promise.all(
        uniqueFolderIds.map(async (folderId) => ({
          folderId,
          statuses: await client.getCachedStatuses(folderId, [""]),
        })),
      );
      const next = new Set(cachedFileKeys);
      for (const response of responses) {
        const keyValue = cachedFileKey(response.folderId, "");
        const available = response.statuses[0]?.available ?? false;
        if (available) {
          next.add(keyValue);
        } else {
          next.delete(keyValue);
        }
      }
      cachedFileKeys = next;
    } catch (rawError: unknown) {
      reportUiError("refresh_folder_root_cached_statuses.failed", rawError, {
        count: uniqueFolderIds.length,
      });
    }
  }

  async function toggleFavorite(
    folderId: string,
    path: string,
    name: string,
    kind: FavoriteItem["kind"],
  ): Promise<void> {
    const keyValue = favoriteKey(folderId, path, kind);
    const exists = favorites.some((item) => item.key === keyValue);
    const previous = favorites;
    if (exists) {
      favorites = favorites.filter((item) => item.key !== keyValue);
      try {
        await client.removeFavorite(keyValue);
      } catch (rawError: unknown) {
        favorites = previous;
        const message =
          rawError instanceof Error ? rawError.message : String(rawError);
        error = message;
        reportUiError("favorite.remove.failed", rawError, { key: keyValue });
      }
      return;
    }
    favorites = [
      ...favorites,
      {
        key: keyValue,
        folderId,
        path: normalizePath(path),
        name,
        kind,
      },
    ].sort((a, b) => a.name.localeCompare(b.name));
    try {
      await client.upsertFavorite({
        key: keyValue,
        folderId,
        path: normalizePath(path),
        name,
        kind,
      });
      if (kind === "file") {
        await refreshCachedStatuses(folderId, [path]);
      }
    } catch (rawError: unknown) {
      favorites = previous;
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("favorite.upsert.failed", rawError, { key: keyValue });
    }
  }

  const removeFavorite = async (favorite: FavoriteItem): Promise<void> => {
    const previous = favorites;
    favorites = favorites.filter((item) => item.key !== favorite.key);
    try {
      await client.removeFavorite(favorite.key);
    } catch (rawError: unknown) {
      favorites = previous;
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("favorite.remove.failed", rawError, { key: favorite.key });
    }
  };

  async function connect(targetDeviceId?: string) {
    error = null;
    recentError = null;
    uploadMessage = "";
    if (!ensureClientNameBeforeConnect()) {
      activeConnectDeviceId = "";
      return;
    }
    if (targetDeviceId) {
      selectedSavedDeviceId = targetDeviceId;
      connection.remoteId = targetDeviceId;
      connection.discoveryMode = "global";
      connection.host = "";
      activeConnectDeviceId = targetDeviceId;
    }
    if (
      connection.discoveryMode === "global" &&
      normalizeDeviceId(connection.remoteId) === "" &&
      selectedSavedDeviceId
    ) {
      connection.remoteId = selectedSavedDeviceId;
    }
    if (
      connection.discoveryMode === "global" &&
      normalizeDeviceId(connection.remoteId) === ""
    ) {
      const message =
        "Global discovery requires a Remote Device ID. Add/select a saved device first.";
      error = message;
      recentError = message;
      activeConnectDeviceId = "";
      return;
    }
    if (
      connection.discoveryMode === "global" &&
      !isValidSyncthingDeviceId(connection.remoteId)
    ) {
      const message =
        "Remote Device ID looks invalid. Expected 52 or 56 base32 chars (A-Z, 2-7), usually shown as grouped with dashes.";
      error = message;
      recentError = message;
      activeConnectDeviceId = "";
      return;
    }
    if (connection.discoveryMode === "global") {
      connection.discoveryServer = normalizeDiscoveryServer(
        connection.discoveryServer,
      );
    }
    connectionModeLabel =
      connection.discoveryMode === "global"
        ? `Global discovery via ${normalizeDiscoveryServer(connection.discoveryServer)}`
        : `Direct ${connection.host || "127.0.0.1"}:${connection.port}`;

    connection.remoteId = normalizeDeviceId(connection.remoteId);
    isConnecting = true;
    const attemptedDeviceId = normalizeDeviceId(
      targetDeviceId ?? connection.remoteId ?? selectedSavedDeviceId,
    );
    try {
      const previousPeerId = normalizeDeviceId(remoteDevice?.id ?? "");
      remoteFs = await client.connectAndSync(connectionDetails());
      const overview = await client.connectAndGetOverview(connectionDetails());
      isConnected = true;
      applyOverviewSnapshot(overview);
      void refreshFolderRootCachedStatuses(overview.folders.map((folder) => folder.id));
      const sourceDeviceId = normalizeDeviceId(
        overview.device?.id ?? connection.remoteId,
      );
      setRemoteApprovalPending(attemptedDeviceId, false);
      setRemoteApprovalPending(sourceDeviceId, false);
      const sourceIsIntroducer = isIntroducerDevice(sourceDeviceId);
      applyAutoAcceptForAdvertisedDevices(
        overview.folders,
        sourceDeviceId,
        sourceIsIntroducer,
      );
      applyAutoAcceptForAdvertisedFolders(
        overview.folders,
        sourceDeviceId,
        sourceIsIntroducer,
      );
      recentError = null;
      const switchedPeer =
        previousPeerId !== "" &&
        sourceDeviceId !== "" &&
        previousPeerId !== sourceDeviceId;
      if (switchedPeer) {
        clearDirectoryView();
      }
      ensureCurrentFolderExists();
      await waitForFoldersToPopulate();
      currentFolderVersionKey = "";
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      recentError = message;
      if (attemptedDeviceId && shouldHintRemoteApprovalPending(message)) {
        setRemoteApprovalPending(attemptedDeviceId, true);
      }
      reportUiError("connect.failed", rawError, connectionDetails());
      resetConnectionRuntimeState();
    } finally {
      isConnecting = false;
      activeConnectDeviceId = "";
    }
  }

  async function connectToSavedDevice(deviceId: string) {
    await connect(deviceId);
  }

  async function disconnect() {
    if (isConnecting) return;
    try {
      await client.disconnect?.();
    } catch (rawError: unknown) {
      setError("disconnect.failed", rawError);
      reportUiError("disconnect.failed", rawError);
    } finally {
      resetConnectionRuntimeState();
      clearDirectoryView();
      error = null;
    }
  }

  async function copySessionLogs() {
    const rendered = sessionLogs
      .slice()
      .reverse()
      .map((item) => {
        const ts = new Date(item.timestampMs).toISOString();
        const base = `${ts} [${item.level.toUpperCase()}] ${item.event}: ${item.message}`;
        if (item.details === undefined) return base;
        return `${base}\n${JSON.stringify(item.details, null, 2)}`;
      })
      .join("\n\n");
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(rendered || "No session logs yet.");
      } else {
        throw new Error("Clipboard API unavailable on this device");
      }
    } catch (rawError: unknown) {
      setError("logs.copy.failed", rawError);
      reportUiError("logs.copy.failed", rawError);
    }
  }

  async function openFolderRoot(folderId: string) {
    if (folderIsLocked(folderId)) return;
    currentFolderId = folderId;
    currentPath = "";
    currentFolderVersionKey = "";
    uploadMessage = "";
    activeTab = "folders";
    await loadCurrentDirectory();
  }

  async function openDirectory(path: string) {
    if (!currentFolderId) return;
    currentPath = resolveDirectoryPath(currentPath, path);
    uploadMessage = "";
    await loadCurrentDirectory();
  }

  async function goToBreadcrumb(segment: BreadcrumbSegment) {
    if (segment.ellipsis) return;
    currentFolderId = segment.targetFolderId;
    currentPath = segment.targetPath;
    uploadMessage = "";
    await loadCurrentDirectory();
  }

  async function goToRootView() {
    clearDirectoryView();
    uploadMessage = "";
    await refreshActiveView();
  }

  async function loadCurrentDirectory() {
    if (!remoteFs || !currentFolderId) return;
    if (folderIsLocked(currentFolderId)) {
      entries = [];
      isLoadingDirectory = false;
      return;
    }
    error = null;
    const targetFolderId = currentFolderId;
    const targetPath = normalizePath(currentPath);
    pushSessionLog(
      "info",
      "folder.load.start",
      `Loading folder ${targetFolderId}:${targetPath || "/"}`,
    );
    const requestSeq = ++directoryLoadSeq;
    isLoadingDirectory = true;
    try {
      await waitForFolderIndexToArrive(targetFolderId);
      let nextEntries = await remoteFs.readDir(
        targetFolderId,
        targetPath,
      );
      if (
        nextEntries.length === 0 &&
        folderState(targetFolderId)?.encrypted &&
        !folderIsLocked(targetFolderId)
      ) {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && nextEntries.length === 0) {
          await sleep(200);
          nextEntries = await remoteFs.readDir(
            targetFolderId,
            targetPath,
          );
        }
      }
      if (requestSeq !== directoryLoadSeq) return;
      entries = nextEntries;
      const entryPaths = nextEntries.map((entry: FileEntry) => entry.path);
      void refreshCachedStatuses(targetFolderId, entryPaths);
      currentFolderVersionKey = folderVersionKey(targetFolderId);
      pushSessionLog(
        "info",
        "folder.load.result",
        `Loaded ${nextEntries.length} entries from ${targetFolderId}:${targetPath || "/"}`,
      );
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      if (requestSeq !== directoryLoadSeq) return;
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("load_current_directory.failed", rawError, {
        folderId: targetFolderId,
        path: targetPath,
      });
    } finally {
      if (requestSeq === directoryLoadSeq) {
        isLoadingDirectory = false;
      }
    }
  }

  async function refreshOverview() {
    if (
      !isConnected ||
      !remoteFs ||
      isConnecting ||
      isRefreshing ||
      isLoadingDirectory
    )
      return;
    isRefreshing = true;
    try {
      const overview = await client.connectAndGetOverview(connectionDetails());
      applyOverviewSnapshot(overview);
      void refreshFolderRootCachedStatuses(overview.folders.map((folder) => folder.id));
      const sourceDeviceId = normalizeDeviceId(
        overview.device?.id ?? connection.remoteId,
      );
      const sourceIsIntroducer = isIntroducerDevice(sourceDeviceId);
      applyAutoAcceptForAdvertisedDevices(
        overview.folders,
        sourceDeviceId,
        sourceIsIntroducer,
      );
      applyAutoAcceptForAdvertisedFolders(
        overview.folders,
        sourceDeviceId,
        sourceIsIntroducer,
      );
      ensureCurrentFolderExists();
      if (activeTab === "folders" && currentFolderId) {
        if (folderIsLocked(currentFolderId)) {
          entries = [];
          currentFolderVersionKey = "";
          lastUpdatedAt = new Date().toLocaleTimeString();
          return;
        }
        const nextFolderVersionKey = folderVersionKey(currentFolderId);
        const shouldReloadDirectory =
          entries.length === 0 ||
          !currentFolderVersionKey ||
          currentFolderVersionKey !== nextFolderVersionKey;
        if (shouldReloadDirectory) {
          await loadCurrentDirectory();
        }
      }
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("refresh_overview.failed", rawError, connectionDetails());
    } finally {
      isRefreshing = false;
    }
  }

  async function refreshActiveView() {
    if (
      activeTab === "devices" ||
      activeTab === "folders" ||
      activeTab === "favorites"
    ) {
      await refreshOverview();
    }
  }

  function switchTab(tab: Tab) {
    activeTab = tab;
    if (tab === "folders" || tab === "favorites") {
      void refreshActiveView();
    }
  }

  function formatModified(ms: number): string {
    if (!ms) return "n/a";
    return new Date(ms).toLocaleString();
  }

  function formatBytes(size: number): string {
    if (!Number.isFinite(size) || size < 0) return "n/a";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = size;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  }

  async function downloadFile(folderId: string, path: string, name: string) {
    if (!remoteFs || !isConnected || isDownloading) return;
    isDownloading = true;
    const startedAt = Date.now();
    const downloadKey = cachedFileKey(folderId, path);
    activeDownloadKey = downloadKey;
    activeDownloadText = "0% • 0 B/s • ETA --";
    error = null;
    try {
      const bytes = await remoteFs.readFileFully(
        folderId,
        path,
        ({ downloadedBytes, totalBytes }) => {
          const elapsedSeconds = Math.max(
            (Date.now() - startedAt) / 1000,
            0.001,
          );
          const speed = downloadedBytes / elapsedSeconds;
          const percent =
            totalBytes > 0
              ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))
              : 0;
          const remainingBytes = Math.max(totalBytes - downloadedBytes, 0);
          const etaSeconds =
            speed > 0 ? remainingBytes / speed : Number.POSITIVE_INFINITY;
          activeDownloadText = `${percent}% • ${formatRate(speed)} • ETA ${formatEta(etaSeconds)}`;
        },
      );
      await client.cacheFile(folderId, path, name, bytes);
      const next = new Set(cachedFileKeys);
      next.add(cachedFileKey(folderId, path));
      cachedFileKeys = next;
      await refreshFolderRootCachedStatuses([folderId]);
      activeDownloadText = "100% • Done";
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("download_file.failed", rawError, { folderId, path });
    } finally {
      isDownloading = false;
      if (activeDownloadKey === downloadKey) {
        activeDownloadKey = "";
        activeDownloadText = "";
      }
    }
  }

  async function openCachedFile(folderId: string, path: string) {
    if (isOpeningCachedFile) return;
    isOpeningCachedFile = true;
    error = null;
    try {
      await client.openCachedFile(folderId, path);
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("open_cached_file.failed", rawError, { folderId, path });
    } finally {
      isOpeningCachedFile = false;
    }
  }

  async function openCachedFileDirectory(folderId: string, path: string) {
    if (isOpeningCachedFile) return;
    isOpeningCachedFile = true;
    error = null;
    try {
      await client.openCachedFileDirectory(folderId, path);
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("open_cached_file_directory.failed", rawError, {
        folderId,
        path,
      });
    } finally {
      isOpeningCachedFile = false;
    }
  }

  async function openCachedDirectory(folderId: string, path: string) {
    if (isOpeningCachedFile) return;
    isOpeningCachedFile = true;
    error = null;
    try {
      await client.openCachedDirectory(folderId, path);
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("open_cached_directory.failed", rawError, {
        folderId,
        path,
      });
    } finally {
      isOpeningCachedFile = false;
    }
  }

  async function clearAllCache() {
    if (isClearingCache || isRemovingCachedFile) return;
    isClearingCache = true;
    error = null;
    try {
      await client.clearCache();
      cachedFileKeys = new Set();
      downloadedFiles = [];
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("clear_cache.failed", rawError);
    } finally {
      isClearingCache = false;
    }
  }

  async function openDownloadedFilesPanel() {
    if (isLoadingDownloadedFiles) return;
    isLoadingDownloadedFiles = true;
    error = null;
    try {
      downloadedFiles = await client.listCachedFiles();
      showDownloadedFiles = true;
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("list_cached_files.failed", rawError);
    } finally {
      isLoadingDownloadedFiles = false;
    }
  }

  async function removeCachedFile(folderId: string, path: string) {
    if (isRemovingCachedFile || isClearingCache) return;
    isRemovingCachedFile = true;
    error = null;
    try {
      await client.removeCachedFile(folderId, path);
      const next = new Set(cachedFileKeys);
      next.delete(cachedFileKey(folderId, path));
      cachedFileKeys = next;
      await refreshFolderRootCachedStatuses([folderId]);
      downloadedFiles = downloadedFiles.filter(
        (file) => file.key !== cachedFileKey(folderId, path),
      );
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("remove_cached_file.failed", rawError, { folderId, path });
    } finally {
      isRemovingCachedFile = false;
    }
  }

  async function openFavorite(favorite: FavoriteItem) {
    if (!isConnected) return;
    activeTab = "folders";
    currentFolderId = favorite.folderId;
    currentPath =
      favorite.kind === "folder"
        ? favorite.path
        : normalizePath(favorite.path.split("/").slice(0, -1).join("/"));
    uploadMessage = "";
    await loadCurrentDirectory();
  }

  function handleUploadClick() {
    const input = document.getElementById(
      "folder-upload-input",
    ) as HTMLInputElement | null;
    input?.click();
  }

  function handleUploadSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const fileName = input.files?.[0]?.name;
    uploadMessage = fileName
      ? `Upload selected (${fileName}) but uploading is not available in this read-only BEP client yet.`
      : "";
    input.value = "";
  }

  function addSavedDevice() {
    const normalizedId = normalizeDeviceId(newSavedDeviceId);
    if (!normalizedId) {
      error = "Device ID is required.";
      return;
    }
    if (!isValidSyncthingDeviceId(normalizedId)) {
      error =
        "Device ID looks invalid. Expected 52 or 56 base32 chars (A-Z, 2-7), usually shown as grouped with dashes.";
      return;
    }
    const advertised = advertisedDevices.find(
      (device) => normalizeDeviceId(device.id) === normalizedId,
    );
    const preferredName = (advertised?.name ?? "").trim() || newSavedDeviceName;
    upsertSavedDeviceEntry(normalizedId, preferredName);
    setSavedDeviceIntroducer(normalizedId, newSavedDeviceIsIntroducer);
    selectedSavedDeviceId = normalizedId;
    connection.remoteId = normalizedId;
    newSavedDeviceName = "";
    newSavedDeviceId = "";
    newSavedDeviceIsIntroducer = false;
    error = null;
  }

  function approveAdvertisedDevice(device: AdvertisedDeviceItem) {
    if (!isValidSyncthingDeviceId(device.id)) {
      error = `Advertised device ID is invalid and cannot be approved: ${device.id}`;
      return;
    }
    upsertSavedDeviceEntry(device.id, device.name);
    selectedSavedDeviceId = device.id;
    connection.remoteId = device.id;
    error = null;
  }

  function approveFolderSync(folder: AdvertisedFolderItem) {
    const next = new Set(syncApprovedIntroducedFolderKeys);
    next.add(folder.key);
    syncApprovedIntroducedFolderKeys = next;
    error = null;
  }

  function useSavedDevice(deviceId: string) {
    selectedSavedDeviceId = deviceId;
    connection.remoteId = deviceId;
  }

  function resetDiscoveryServer() {
    connection.discoveryServer = getDefaultDiscoveryServer();
  }

  function removeSavedDevice(deviceId: string) {
    const normalized = normalizeDeviceId(deviceId);
    setRemoteApprovalPending(normalized, false);
    savedDevices = savedDevices.filter(
      (device) => normalizeDeviceId(device.id) !== normalized,
    );
    if (connection.remoteId === deviceId) {
      connection.remoteId = "";
    }
    const nextSyncApproved = new Set(
      [...syncApprovedIntroducedFolderKeys].filter(
        (key) => !key.startsWith(`${normalized}:`),
      ),
    );
    syncApprovedIntroducedFolderKeys = nextSyncApproved;
    const scopedPrefix = `${normalized}${FOLDER_PASSWORD_SCOPE_SEPARATOR}`;
    folderPasswords = Object.fromEntries(
      Object.entries(folderPasswords).filter(
        ([key]) => !key.startsWith(scopedPrefix),
      ),
    );
  }

  async function exportIdentityRecovery() {
    if (isExportingIdentityRecovery) return;
    isExportingIdentityRecovery = true;
    error = null;
    try {
      const exported = await client.exportIdentityRecovery();
      exportedIdentityDeviceId = exported.deviceId;
      exportedIdentitySecret = exported.recoverySecret;
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(exported.recoverySecret);
      }
    } catch (rawError: unknown) {
      setError("identity_recovery.export.failed", rawError);
      reportUiError("identity_recovery.export.failed", rawError);
    } finally {
      isExportingIdentityRecovery = false;
    }
  }

  async function restoreIdentityRecovery() {
    if (isRestoringIdentityRecovery) return;
    const secret = identityRecoverySecret.trim();
    if (!secret) {
      error = "Recovery secret is required.";
      return;
    }
    isRestoringIdentityRecovery = true;
    error = null;
    try {
      await client.restoreIdentityRecovery(secret);
      identityRecoverySecret = "";
      exportedIdentitySecret = "";
      exportedIdentityDeviceId = "";
    } catch (rawError: unknown) {
      setError("identity_recovery.restore.failed", rawError);
      reportUiError("identity_recovery.restore.failed", rawError);
    } finally {
      isRestoringIdentityRecovery = false;
    }
  }
</script>

<div class="app-shell">
  <main class="content">
    {#if recentError}
      <section class="panel error-banner-panel">
        <p class="error">{recentError}</p>
      </section>
    {/if}

    {#if !isConnected}
      <div class="global-connect">
        <button class="primary" onclick={() => connect()} disabled={isConnecting}>
          {isConnecting ? "Connecting..." : "Connect"}
        </button>
        {#if connectionModeLabel}
          <span>{connectionModeLabel}</span>
        {/if}
      </div>
    {:else}
      <div class="global-connect">
        <button class="ghost" onclick={disconnect} disabled={isConnecting}>
          Disconnect
        </button>
      </div>
    {/if}

    {#if activeTab === "devices"}
      <section class="panel">
        <h2 class="heading">Settings</h2>

        <div class="status-row">
          <span class={`status-chip ${isConnected ? "online" : "offline"}`}>
            {isConnected ? "Connected" : "Disconnected"}
          </span>
          {#if lastUpdatedAt}
            <span>Updated {lastUpdatedAt}</span>
          {/if}
          {#if isConnected && connectionPath}
            <span>Path: {connectionTransport === "relay" ? "relay" : "direct tcp"} ({connectionPath})</span>
          {/if}
        </div>

        {#if !isConnected}
          <button class="primary" onclick={() => connect()} disabled={isConnecting}>
            {isConnecting ? "Connecting..." : "Connect Using Last Settings"}
          </button>
        {/if}

        <details bind:open={isSettingsExpanded}>
          <summary>Connection Settings</summary>
          <form
            class="settings"
            onsubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <label>
              Discovery Method
              <select bind:value={connection.discoveryMode}>
                <option value="global">Global Discovery (default)</option>
                <option value="direct">Direct Host/Port</option>
              </select>
            </label>

            {#if connection.discoveryMode === "global"}
              <label>
                Discovery Server
                <input type="text" bind:value={connection.discoveryServer} />
              </label>
            {/if}

            {#if connection.discoveryMode === "direct"}
              <label>
                Host
                <input type="text" bind:value={connection.host} placeholder="127.0.0.1" />
              </label>

              <label>
                Port
                <input type="number" bind:value={connection.port} min="1" max="65535" />
              </label>
            {:else}
              <div class="hint">
                Global discovery ignores manual host/port. The official Syncthing discovery server pin is applied automatically when you use discovery.syncthing.net.
              </div>
            {/if}

            <label>
              Saved Devices
              <select bind:value={selectedSavedDeviceId}>
                <option value="">Manual entry</option>
                {#each savedDevices as device (device.id)}
                  <option value={device.id}>{device.name}</option>
                {/each}
              </select>
            </label>

            <label>
              Remote Device ID
              <input
                type="text"
                bind:value={connection.remoteId}
                placeholder="ABCD123-... (required for global discovery)"
                spellcheck="false"
                autocapitalize="characters"
                autocomplete="off"
                autocorrect="off"
              />
            </label>

            <label>
              TLS Certificate (optional)
              <input
                type="text"
                bind:value={connection.cert}
                placeholder="Auto uses persisted cli-node cert.pem"
              />
            </label>

            <label>
              TLS Key (optional)
              <input
                type="text"
                bind:value={connection.key}
                placeholder="Auto uses persisted cli-node key.pem"
              />
            </label>

            <label>
              Device Name
              <input type="text" bind:value={connection.deviceName} />
            </label>

            <label>
              Timeout (ms)
              <input
                type="number"
                bind:value={connection.timeoutMs}
                min="1000"
                step="1000"
              />
            </label>

            <label class="checkbox-row">
              <input type="checkbox" bind:checked={connection.enableRelayFallback} />
              <span>Enable relay fallback (Syncthing relay://)</span>
            </label>

            <label class="checkbox-row">
              <input type="checkbox" bind:checked={connection.autoAcceptNewDevices} />
              <span>Auto-accept newly advertised devices</span>
            </label>

            <label class="checkbox-row">
              <input type="checkbox" bind:checked={connection.autoAcceptIntroducedFolders} />
              <span>Auto-approve folder sync for introduced folders</span>
            </label>
          </form>

          <div class="actions">
            <button
              type="button"
              class="ghost"
              onclick={() => useSavedDevice(selectedSavedDeviceId)}
              disabled={selectedSavedDeviceId === ""}
            >
              Use Selected Device
            </button>
            <button
              type="button"
              class="ghost"
              onclick={resetDiscoveryServer}
              disabled={connection.discoveryMode !== "global"}
            >
              Use Official Discovery Server
            </button>
            <button
              type="button"
              class="ghost"
              onclick={clearAllCache}
              disabled={isClearingCache}
            >
              {isClearingCache ? "Clearing Cache..." : "Clear Cache"}
            </button>
          </div>
        </details>
      </section>

      <section class="panel">
        <h2 class="heading">Identity Recovery</h2>
        <p class="hint">
          Back up this device identity so reinstalling can restore the same device ID.
        </p>
        <div class="actions">
          <button
            type="button"
            class="primary"
            onclick={exportIdentityRecovery}
            disabled={isExportingIdentityRecovery}
          >
            {isExportingIdentityRecovery ? "Exporting..." : "Export Recovery Secret"}
          </button>
        </div>
        {#if exportedIdentitySecret}
          <div class="item-meta">Device ID: {exportedIdentityDeviceId}</div>
          <textarea
            class="recovery-secret"
            readonly
            value={exportedIdentitySecret}
          ></textarea>
        {/if}

        <label>
          Restore From Recovery Secret
          <textarea
            class="recovery-secret"
            bind:value={identityRecoverySecret}
            placeholder="Paste recovery secret here"
          ></textarea>
        </label>
        <div class="actions">
          <button
            type="button"
            class="ghost"
            onclick={restoreIdentityRecovery}
            disabled={isRestoringIdentityRecovery}
          >
            {isRestoringIdentityRecovery ? "Restoring..." : "Restore Identity"}
          </button>
        </div>
      </section>

      <section class="panel">
        <h2 class="heading">Add Device</h2>
        <div class="saved-device-editor">
          <label>
            Device Name (auto from advertised, editable)
            <input
              type="text"
              bind:value={newSavedDeviceName}
              placeholder="Kitchen Pixel"
            />
          </label>
          <label>
            Device ID
            <input
              type="text"
              bind:value={newSavedDeviceId}
              placeholder="ABCD123-..."
            />
          </label>
          <label class="checkbox-row">
            <input type="checkbox" bind:checked={newSavedDeviceIsIntroducer} />
            <span>Treat as introducer</span>
          </label>
          <div class="actions">
            <button type="button" class="primary" onclick={addSavedDevice}
              >Add Device</button
            >
          </div>
        </div>
      </section>

      <section class="panel">
        <h2 class="heading">Advertised Devices</h2>
        {#if isConnected && !currentSourceIsIntroducer()}
          <p class="hint">
            Introductions are only trusted from introducer peers. Mark this connected device as introducer to review/accept advertised devices.
          </p>
        {/if}
        <ul class="list">
          {#if advertisedDevices.length === 0}
            <li class="empty">
              No introduced devices pending from the current introducer peer.
            </li>
          {:else}
            {#each advertisedDevices as device (device.id)}
              <li class="list-item">
                <div class="item-main">
                  <div class="item-title-row">
                    <div class="item-title">{device.name}</div>
                    <span class={`status-chip ${device.accepted ? "online" : "offline"} small`}>
                      {device.accepted ? "accepted" : "non-accepted"}
                    </span>
                  </div>
                  <div class="item-meta">{device.id}</div>
                  <div class="item-meta">
                    Seen in folders: {device.sourceFolderIds.join(", ")}
                  </div>
                </div>
                <div class="item-actions">
                  {#if device.accepted}
                    <button
                      class="ghost"
                      onclick={() => useSavedDevice(device.id)}
                    >
                      Use
                    </button>
                  {:else}
                    <button
                      class="primary"
                      onclick={() => approveAdvertisedDevice(device)}
                    >
                      Approve
                    </button>
                  {/if}
                </div>
              </li>
            {/each}
          {/if}
        </ul>
      </section>

      <section class="panel">
        <h2 class="heading">Folder Sync Approvals</h2>
        {#if isConnected && !currentSourceIsIntroducer()}
          <p class="hint">
            Introduced folder sync can only be approved from introducer peers.
          </p>
        {/if}
        <ul class="list">
          {#if advertisedFolders.length === 0}
            <li class="empty">No introduced folder sync approvals pending from the current introducer peer.</li>
          {:else}
            {#each advertisedFolders as folder (folder.key)}
              <li class="list-item">
                <div class="item-main">
                  <div class="item-title-row">
                    <div class="item-title">{folder.label}</div>
                    <span class={`status-chip ${folder.syncApproved ? "online" : "offline"} small`}>
                      {folder.syncApproved ? "sync approved" : "sync not approved"}
                    </span>
                  </div>
                  <div class="item-meta">Folder ID: {folder.folderId}</div>
                  <div class="item-meta">Introduced by: {folder.sourceDeviceId}</div>
                </div>
                <div class="item-actions">
                  {#if folder.syncApproved}
                    <button
                      class="ghost"
                      onclick={() => openFolderRoot(folder.folderId)}
                      disabled={!isConnected}
                    >
                      Open
                    </button>
                  {:else}
                    <button
                      class="primary"
                      onclick={() => approveFolderSync(folder)}
                    >
                      Approve Sync
                    </button>
                  {/if}
                </div>
              </li>
            {/each}
          {/if}
        </ul>
      </section>

      <section class="panel">
        <h2 class="heading">Saved Devices</h2>
        <ul class="list">
          {#if savedDevices.length === 0}
            <li class="empty">
              No saved devices yet. Add one from Connection Settings.
            </li>
          {:else}
            {#each savedDevices as device (device.id)}
              <li class="list-item">
                <div class="item-main">
                  <div class="item-title-row">
                    <button
                      class="item-title"
                      onclick={() => useSavedDevice(device.id)}
                      >{device.name}</button
                    >
                    {#if device.isIntroducer}
                      <span class="status-chip small">introducer</span>
                    {/if}
                    {#if isSavedDeviceConnected(device.id)}
                      <span class="status-chip online small">online</span>
                    {/if}
                    {#if isSavedDeviceAwaitingRemoteApproval(device.id)}
                      <span class="status-chip offline small" title="This peer may still need to approve your device on their Syncthing side.">
                        awaiting approval
                      </span>
                    {/if}
                  </div>
                  <div class="item-meta">{device.id}</div>
                </div>
                <div class="item-actions">
                  <button
                    class="primary"
                    onclick={() => connectToSavedDevice(device.id)}
                    disabled={isConnecting}
                  >
                    {isConnecting && activeConnectDeviceId === device.id ? "Connecting..." : "Connect"}
                  </button>
                  <button
                    class="ghost"
                    onclick={() => useSavedDevice(device.id)}>Use</button
                  >
                  <button
                    class="ghost"
                    onclick={() =>
                      setSavedDeviceIntroducer(device.id, !device.isIntroducer)}
                    title={device.isIntroducer ? "Unset introducer" : "Mark as introducer"}
                  >
                    {device.isIntroducer ? "Unset Introducer" : "Set Introducer"}
                  </button>
                  <button
                    class="icon icon-only"
                    onclick={() => removeSavedDevice(device.id)}
                    title="Remove saved device"
                    aria-label="Remove saved device"
                  >
                    <Trash2 size={16} />
                  </button
                  >
                </div>
              </li>
            {/each}
          {/if}
        </ul>
      </section>

      <section class="panel">
        <h2 class="heading">Active Remote Device</h2>
        <ul class="list">
          {#if !remoteDevice}
            <li class="empty">
              No remote device metadata yet. Connect to a saved device.
            </li>
          {:else}
            <li class="list-item">
              <div class="item-main">
                <div class="item-title" title={remoteDevice.deviceName}>
                  {remoteDevice.deviceName}
                </div>
                <div class="item-meta">{remoteDevice.id}</div>
                <div class="item-meta">
                  {remoteDevice.clientName}
                  {remoteDevice.clientVersion}
                </div>
                {#if connectionPath}
                  <div class="item-meta">
                    Connected via {connectionTransport === "relay" ? "relay" : "direct tcp"}: {connectionPath}
                  </div>
                {/if}
              </div>
              <div class="item-actions">
                <button
                  class="ghost"
                  onclick={refreshOverview}
                  disabled={!isConnected || isRefreshing || isConnecting}
                  title={isRefreshing ? "Refreshing..." : "Refresh"}
                >
                  Refresh
                </button>
              </div>
            </li>
          {/if}
        </ul>
      </section>

      <section class="panel">
        <h2 class="heading">Session Logs</h2>
        <details bind:open={isLogPanelExpanded}>
          <summary>View logs ({sessionLogs.length})</summary>
          <div class="actions">
            <button
              type="button"
              class="ghost"
              onclick={copySessionLogs}
            >
              Copy Logs
            </button>
          </div>
          <ul class="list">
            {#if sessionLogs.length === 0}
              <li class="empty">No session logs yet.</li>
            {:else}
              {#each sessionLogs as item (item.id)}
                <li class="list-item">
                  <div class="item-main">
                    <div class="item-meta">
                      {new Date(item.timestampMs).toLocaleTimeString()} | {item.level.toUpperCase()} | {item.event}
                    </div>
                    <div class={`item-meta ${item.level === "error" ? "log-error" : item.level === "warning" ? "log-warning" : ""}`}>{item.message}</div>
                    {#if item.details !== undefined}
                      <pre class="log-details">{JSON.stringify(item.details, null, 2)}</pre>
                    {/if}
                  </div>
                </li>
              {/each}
            {/if}
          </ul>
        </details>
      </section>
    {/if}

    {#if activeTab === "favorites"}
      <section class="panel">
        <h2 class="heading">Favorites</h2>
        <div class="actions">
          <button
            class="ghost"
            onclick={openDownloadedFilesPanel}
            disabled={isLoadingDownloadedFiles}
          >
            {isLoadingDownloadedFiles
              ? "Loading Downloads..."
              : "Show Downloaded Files"}
          </button>
        </div>
        {#if !isConnected}
          <p class="empty">Connect to open favorites and sync folder state.</p>
        {/if}

        <ul class="list">
          {#if favorites.length === 0}
            <li class="empty">
              No favorites yet. Tap a star on folders/files to add them.
            </li>
          {:else}
            {#each favorites as favorite (favorite.key)}
              <li class="list-item">
                <div class="item-main">
                  <button
                    class="item-title"
                    onclick={() => openFavorite(favorite)}
                    disabled={!isConnected}>{favorite.name}</button
                  >
                  <div class="item-meta">
                    {favorite.folderId}:{favorite.path || "/"}
                  </div>
                </div>
                <div class="item-actions">
                  {#if favorite.kind === "file"}
                    {#if cachedFileKeys.has(cachedFileKey(favorite.folderId, favorite.path))}
                      <button
                        class="ghost"
                        onclick={() =>
                          openCachedFile(favorite.folderId, favorite.path)}
                        disabled={isOpeningCachedFile}
                      >
                        Open
                      </button>
                      <button
                        class="ghost"
                        onclick={() =>
                          openCachedFileDirectory(
                            favorite.folderId,
                            favorite.path,
                          )}
                        disabled={isOpeningCachedFile}
                      >
                        Open Folder
                      </button>
                    {:else}
                      <button
                        class="ghost"
                        onclick={() =>
                          downloadFile(
                            favorite.folderId,
                            favorite.path,
                            favorite.name,
                          )}
                        disabled={!isConnected || isDownloading}
                      >
                        {downloadButtonLabel(favorite.folderId, favorite.path)}
                      </button>
                    {/if}
                  {/if}
                  <button
                    class="icon icon-only"
                    onclick={() => void removeFavorite(favorite)}
                    title="Remove favorite"
                    aria-label="Remove favorite"
                  >
                    <Trash2 size={16} />
                  </button
                  >
                </div>
              </li>
            {/each}
          {/if}
        </ul>

        {#if showDownloadedFiles}
          <div class="heading-row">
            <h3 class="heading">Downloaded Files</h3>
            <button
              class="ghost"
              onclick={clearAllCache}
              disabled={isClearingCache || isRemovingCachedFile}
            >
              {isClearingCache ? "Clearing..." : "Clear All"}
            </button>
          </div>
          <ul class="list">
            {#if downloadedFiles.length === 0}
              <li class="empty">No downloaded files in local cache yet.</li>
            {:else}
              {#each downloadedFiles as file (file.key)}
                <li class="list-item">
                  <div class="item-main">
                    <div class="item-title">{file.name}</div>
                    <div class="item-meta">{file.folderId}:{file.path}</div>
                    <div class="item-meta">
                      {formatBytes(file.sizeBytes)} | Cached {formatModified(
                        file.cachedAtMs,
                      )}
                    </div>
                  </div>
                  <div class="item-actions">
                    <button
                      class="ghost"
                      onclick={() => openCachedFile(file.folderId, file.path)}
                      disabled={isOpeningCachedFile}
                    >
                      Open
                    </button>
                    <button
                      class="ghost"
                      onclick={() =>
                        openCachedFileDirectory(file.folderId, file.path)}
                      disabled={isOpeningCachedFile}
                    >
                      Open Folder
                    </button>
                    <button
                      class="ghost"
                      onclick={() =>
                        removeCachedFile(file.folderId, file.path)}
                      disabled={isRemovingCachedFile || isClearingCache}
                    >
                      Drop
                    </button>
                  </div>
                </li>
              {/each}
            {/if}
          </ul>
        {/if}
      </section>
    {/if}

    {#if activeTab === "folders"}
      <section class="panel">
        <h2 class="heading">Folders</h2>

        {#if !isConnected}
          <p class="empty">Connect to browse folders.</p>
        {:else}
          <div class="status-row">
            <span class="status-chip online">Connected</span>
            {#if remoteDevice}
              <span>{remoteDevice.deviceName}</span>
            {/if}
            {#if lastUpdatedAt}
              <span>Updated {lastUpdatedAt}</span>
            {/if}
            <button
              class="ghost icon-only"
              onclick={() => refreshActiveView()}
              disabled={isRefreshing || isConnecting || isLoadingDirectory}
              title={isRefreshing ? "Refreshing..." : "Refresh"}
              aria-label={isRefreshing ? "Refreshing..." : "Refresh"}
            >
              <RefreshCw size={16} />
            </button>
          </div>

          <div class="breadcrumbs">
            {#if !currentFolderId}
              <span class="crumb-current">All Syncthing Folders</span>
            {:else}
              <button class="crumb-button" onclick={goToRootView}
                >All Syncthing Folders</button
              >
              <span class="crumb-separator">&gt;</span>
              {#each visibleBreadcrumbs as segment, index (segment.key)}
                {#if index < visibleBreadcrumbs.length - 1}
                  {#if segment.ellipsis}
                    <span class="crumb-current">...</span>
                  {:else}
                    <button
                      class="crumb-button"
                      onclick={() => goToBreadcrumb(segment)}
                      >{segment.label}</button
                    >
                  {/if}
                  <span class="crumb-separator">&gt;</span>
                {:else}
                  <span class="crumb-current">{segment.label}</span>
                {/if}
              {/each}
            {/if}
          </div>

          {#if !currentFolderId}
            <ul class="list">
              {#if rootFolderEntries().length === 0}
                <li class="empty">No folders shared by the remote device.</li>
              {:else}
                {#each rootFolderEntries() as folder (folder.id)}
                  <li class="list-item">
                    <div class="item-main">
                      <button
                        class="item-title"
                        onclick={() => openFolderRoot(folder.id)}
                        disabled={folderIsLocked(folder.id)}
                        >{folder.name}</button
                      >
                      <div class="item-meta">
                        {folder.readOnly ? "read-only" : "read-write"}
                      </div>
                      {#if folderState(folder.id)?.encrypted}
                        <div class="item-meta">
                          receive-encrypted | {folderLockLabel(folder.id)}
                        </div>
                        {#if folderState(folder.id)?.passwordError}
                          <div class="item-meta">
                            {folderState(folder.id)?.passwordError}
                          </div>
                        {/if}
                        {#if isFolderPasswordInputVisible(folder.id)}
                          <label class="inline-input">
                            <span>Folder Password</span>
                            <input
                              type="password"
                              value={folderPasswordDrafts[folder.id] ?? activeFolderPasswords[folder.id] ?? ""}
                              oninput={(event) =>
                                handleFolderPasswordInput(folder.id, event)}
                              placeholder="Syncthing folder encryption password"
                            />
                          </label>
                        {/if}
                      {/if}
                    </div>
                    <div class="item-actions">
                      {#if folderState(folder.id)?.encrypted}
                        <span class={`status-chip small ${folderIsLocked(folder.id) ? "offline" : "online"}`}>
                          {folderLockLabel(folder.id)}
                        </span>
                        {#if !isFolderPasswordInputVisible(folder.id)}
                          <button
                            class="ghost icon-only"
                            onclick={() => openFolderPasswordInput(folder.id)}
                            title="Edit folder password"
                            aria-label="Edit folder password"
                          >
                            <KeyRound size={16} />
                          </button>
                        {/if}
                        <button
                          class="ghost icon-only"
                          onclick={() => saveFolderPassword(folder.id)}
                          title="Unlock and decrypt folder"
                          aria-label="Unlock and decrypt folder"
                        >
                          <Unlock size={16} />
                        </button>
                        <button
                          class="ghost icon-only"
                          onclick={() => clearFolderPassword(folder.id)}
                          disabled={!activeFolderPasswords[folder.id]}
                          title="Forget saved folder password"
                          aria-label="Forget saved folder password"
                        >
                          <Trash2 size={16} />
                        </button>
                      {/if}
                      {#if cachedFileKeys.has(cachedFileKey(folder.id, ""))}
                        <button
                          class="ghost icon-only"
                          onclick={() => openCachedDirectory(folder.id, "")}
                          disabled={isOpeningCachedFile}
                          title="Open local cached folder"
                          aria-label="Open local cached folder"
                        >
                          <ExternalLink size={16} />
                        </button>
                      {/if}
                      <button
                        class="icon icon-only"
                        onclick={() =>
                          void toggleFavorite(
                            folder.id,
                            "",
                            folder.name,
                            "folder",
                          )}
                        title="Toggle favorite"
                        aria-label="Toggle favorite"
                      >
                        {#if favoriteKeys.has(favoriteKey(folder.id, "", "folder"))}
                          <Star size={16} />
                        {:else}
                          <StarOff size={16} />
                        {/if}
                      </button>
                    </div>
                  </li>
                {/each}
              {/if}
            </ul>
          {:else}
            <ul class="list">
              {#if folderIsLocked(currentFolderId)}
                <li class="empty">
                  This receive-encrypted folder is locked. Use the unlock button in the folder list to browse or download files.
                </li>
              {:else if isLoadingDirectory}
                <li class="empty">Loading folder contents...</li>
              {:else if entries.length === 0}
                <li class="empty">Folder is empty.</li>
              {:else}
                {#each entries as entry (entry.path)}
                  <li class="list-item">
                    <div class="item-main">
                      {#if entry.type === "directory"}
                        <button
                          class="item-title"
                          onclick={() => openDirectory(entry.path)}
                          >{entry.name}/</button
                        >
                      {:else}
                        <span class="item-title">{entry.name}</span>
                      {/if}
                      <div class="item-meta">
                        {entry.type} | {formatBytes(entry.size)} | {formatModified(
                          entry.modifiedMs,
                        )}
                      </div>
                      {#if entry.invalid}
                        <div class="item-meta">
                          Unavailable on remote (invalid)
                        </div>
                      {/if}
                    </div>
                    <div class="item-actions">
                      {#if entry.type === "directory"}
                        {#if cachedFileKeys.has(cachedFileKey(currentFolderId, entry.path))}
                          <button
                            class="ghost icon-only"
                            onclick={() =>
                              openCachedDirectory(currentFolderId, entry.path)}
                            disabled={isOpeningCachedFile}
                            title="Open local cached directory"
                            aria-label="Open local cached directory"
                          >
                            <ExternalLink size={16} />
                          </button>
                        {/if}
                      {/if}
                      {#if entry.type !== "directory"}
                        {#if cachedFileKeys.has(cachedFileKey(currentFolderId, entry.path))}
                          <button
                            class="ghost icon-only"
                            onclick={() =>
                              openCachedFile(currentFolderId, entry.path)}
                            disabled={isOpeningCachedFile}
                            title="Open cached file"
                            aria-label="Open cached file"
                          >
                            <ExternalLink size={16} />
                          </button>
                          <button
                            class="ghost icon-only"
                            onclick={() =>
                              openCachedFileDirectory(currentFolderId, entry.path)}
                            disabled={isOpeningCachedFile}
                            title="Open cached file directory"
                            aria-label="Open cached file directory"
                          >
                            <FolderOpen size={16} />
                          </button>
                        {:else}
                          <button
                            class="ghost icon-only"
                            onclick={() =>
                              downloadFile(
                                currentFolderId,
                                entry.path,
                                entry.name,
                              )}
                            disabled={isDownloading || entry.invalid}
                            title={downloadButtonLabel(currentFolderId, entry.path)}
                            aria-label={downloadButtonLabel(currentFolderId, entry.path)}
                          >
                            <Download size={16} />
                          </button>
                        {/if}
                      {/if}
                      <button
                        class="icon icon-only"
                        onclick={() =>
                          void toggleFavorite(
                            currentFolderId,
                            entry.path,
                            entry.name,
                            entry.type === "directory" ? "folder" : "file",
                          )}
                        title="Toggle favorite"
                        aria-label="Toggle favorite"
                      >
                        {#if favoriteKeys.has(
                          favoriteKey(
                            currentFolderId,
                            entry.path,
                            entry.type === "directory" ? "folder" : "file",
                          ),
                        )}
                          <Star size={16} />
                        {:else}
                          <StarOff size={16} />
                        {/if}
                      </button>
                    </div>
                  </li>
                {/each}
              {/if}
            </ul>

            <div class="actions">
              <input
                id="folder-upload-input"
                type="file"
                style="display: none;"
                onchange={handleUploadSelected}
              />
              <button class="primary" onclick={handleUploadClick}
                >Upload</button
              >
            </div>
            {#if uploadMessage}
              <div class="hint">{uploadMessage}</div>
            {/if}
          {/if}
        {/if}
      </section>
    {/if}

  </main>

  <nav class="bottom-tabs">
    <button
      class={`tab-button ${activeTab === "favorites" ? "active" : ""}`}
      onclick={() => switchTab("favorites")}
    >
      <Star size={18} aria-hidden="true" />
      <span class="sr-only">Favorites</span>
    </button>
    <button
      class={`tab-button ${activeTab === "folders" ? "active" : ""}`}
      onclick={() => switchTab("folders")}
    >
      <FolderOpen size={18} aria-hidden="true" />
      <span class="sr-only">Folders</span>
    </button>
    <button
      class={`tab-button ${activeTab === "devices" ? "active" : ""}`}
      onclick={() => switchTab("devices")}
    >
      <Settings size={18} aria-hidden="true" />
      <span class="sr-only">Settings</span>
    </button>
  </nav>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
    background: #f3f5f8;
    color: #1f2933;
  }

  .app-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, #f7f9fc 0%, #edf2f7 100%);
    padding-top: env(safe-area-inset-top);
  }

  .content {
    flex: 1;
    padding: 0.9rem 0.8rem calc(5.4rem + env(safe-area-inset-bottom));
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  .panel {
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

  .panel + .panel {
    margin-top: 0.45rem;
    padding-top: 0.55rem;
    border-top: 1px solid #d4deea;
  }

  .heading {
    margin: 0 0 0.35rem;
    font-size: 0.94rem;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .heading-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.45rem;
    margin-bottom: 0.35rem;
    flex-wrap: wrap;
  }

  form.settings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.45rem;
    margin-top: 0.35rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
    color: #445366;
  }

  .checkbox-row {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    min-height: 42px;
  }

  .inline-input {
    margin-top: 0.35rem;
    max-width: 24rem;
  }

  .checkbox-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
    margin: 0;
  }

  input,
  select {
    padding: 0.4rem 0.45rem;
    font-size: 0.88rem;
    border: 1px solid #c7d2df;
    border-radius: 8px;
    background: #fff;
  }

  textarea.recovery-secret {
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

  .actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.4rem;
    flex-wrap: wrap;
  }

  button {
    border: 1px solid #a6b7ca;
    border-radius: 8px;
    background: #ffffff;
    color: #1b3049;
    padding: 0.5rem 0.8rem;
    font-size: 0.9rem;
    min-height: 42px;
    cursor: pointer;
    transition:
      transform 120ms ease,
      box-shadow 120ms ease,
      background-color 120ms ease;
    will-change: transform;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
  }

  button.primary {
    border-color: #0f4a93;
    background: #0f4a93;
    color: #fff;
  }

  button.ghost {
    border-color: #c8d4e2;
    background: #f8fbff;
  }

  button.icon {
    min-width: 2.3rem;
    padding: 0.35rem 0.5rem;
    text-align: center;
  }

  button.icon-only {
    width: 2.3rem;
    min-width: 2.3rem;
    padding: 0.35rem;
  }

  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  button:active:not(:disabled) {
    transform: scale(0.97);
    box-shadow: inset 0 0 0 999px rgba(15, 74, 147, 0.08);
  }

  .global-connect {
    margin-bottom: 0.35rem;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.45rem;
  }

  .status-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.8rem;
    color: #4c627a;
    margin-bottom: 0.4rem;
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .status-chip.online {
    background: #d7f4e4;
    color: #0d7044;
  }

  .status-chip.offline {
    background: #fde3e3;
    color: #9c2d2d;
  }

  .status-chip.small {
    font-size: 0.68rem;
    padding: 0.08rem 0.35rem;
  }

  details {
    border: 1px solid #dbe3ee;
    border-radius: 10px;
    padding: 0.32rem 0.45rem;
    background: #fbfdff;
  }

  summary {
    cursor: pointer;
    font-size: 0.82rem;
    color: #304a66;
    font-weight: 600;
  }

  .saved-device-editor {
    display: grid;
    gap: 0.45rem;
  }

  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.4rem;
    font-size: 0.87rem;
  }

  .crumb-separator {
    color: #6f8297;
  }

  .crumb-button {
    border: none;
    background: none;
    color: #0f4a93;
    padding: 0;
    border-radius: 0;
  }

  .crumb-current {
    font-weight: 700;
    color: #1d334a;
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid #dde5ef;
    border-radius: 8px;
    overflow: hidden;
  }

  .list-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.35rem;
    padding: 0.42rem 0.5rem;
    border-bottom: 1px solid #eef2f7;
    background: #fff;
  }

  .list-item:last-child {
    border-bottom: none;
  }

  .item-main {
    min-width: 0;
  }

  .item-title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .item-title {
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

  .item-meta {
    font-size: 0.74rem;
    color: #61778f;
    overflow-wrap: anywhere;
  }

  .log-error {
    color: #a61b1b;
  }

  .log-warning {
    color: #9a5c00;
  }

  .log-details {
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

  .item-actions {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    align-self: stretch;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .empty {
    padding: 0.5rem;
    color: #607286;
    font-size: 0.86rem;
  }

  .error {
    margin: 0;
    color: #a61b1b;
    font-size: 0.84rem;
  }

  .hint {
    margin-top: 0.35rem;
    font-size: 0.78rem;
    color: #7c2d12;
  }

  .bottom-tabs {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    background: #101d2e;
    border-top: 1px solid #1d324e;
    padding: 0.45rem 0.45rem calc(0.45rem + env(safe-area-inset-bottom));
    gap: 0.35rem;
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
    .content {
      padding: 0.7rem 0.6rem calc(5.2rem + env(safe-area-inset-bottom));
    }

    form.settings {
      grid-template-columns: 1fr;
    }

    .list-item {
      grid-template-columns: 1fr;
    }

    .item-actions {
      justify-content: flex-start;
    }
  }
</style>
