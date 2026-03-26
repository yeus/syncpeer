<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    createSyncpeerUiClient,
    getDefaultDiscoveryServer,
    normalizeDiscoveryServer,
    reportUiError,
    type CachedFileRecord,
    type ConnectOptions,
    type RemoteFsLike,
    type UiLogEntry,
  } from "./lib/syncpeerClient.js";
  import type {
    FileEntry,
    FolderInfo,
    FolderSyncState,
    RemoteDeviceInfo,
  } from "@syncpeer/core/browser";

  type Tab = "favorites" | "folders" | "devices";
  type DiscoveryMode = "global" | "direct";

  interface RootFolderEntry {
    type: "root-folder";
    id: string;
    name: string;
    readOnly: boolean;
  }

  interface BreadcrumbSegment {
    key: string;
    label: string;
    targetFolderId: string;
    targetPath: string;
    ellipsis?: boolean;
  }

  interface FavoriteItem {
    key: string;
    folderId: string;
    path: string;
    name: string;
    kind: "folder" | "file";
  }

  interface StoredConnectionSettings {
    host: string;
    port: number;
    cert: string;
    key: string;
    remoteId: string;
    deviceName: string;
    timeoutMs: number;
    discoveryMode: DiscoveryMode;
    discoveryServer: string;
    enableRelayFallback: boolean;
  }

  interface SavedDevice {
    id: string;
    name: string;
    createdAtMs: number;
  }

  interface PersistedAppState {
    activeTab: Tab;
    selectedSavedDeviceId: string;
    connection: StoredConnectionSettings;
    savedDevices: SavedDevice[];
  }

  interface SessionLogItem {
    id: string;
    timestampMs: number;
    level: "info" | "warning" | "error";
    event: string;
    message: string;
    details?: unknown;
  }

  const APP_STATE_STORAGE_KEY = "syncpeer.ui.state.v1";
  const REFRESH_MS = 3000;
  const MAX_VISIBLE_CRUMBS = 4;

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

  const normalizeSavedDevices = (parsed: SavedDevice[] | null | undefined): SavedDevice[] => {
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => typeof item?.id === "string" && item.id.trim() !== "")
      .map((item) => ({
        id: String(item.id).trim(),
        name: String(item.name ?? "").trim() || String(item.id).trim(),
        createdAtMs: Number(item.createdAtMs) || Date.now(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const persistAppState = (state: PersistedAppState): void => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      APP_STATE_STORAGE_KEY,
      JSON.stringify(state),
    );
  };

  const normalizePath = (value: string): string =>
    value.replace(/^\/+|\/+$/g, "");
  const normalizeDeviceId = (value: string): string =>
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z2-7-]/g, "");
  const compactDeviceId = (value: string): string =>
    normalizeDeviceId(value).replace(/-/g, "");
  const isValidSyncthingDeviceId = (value: string): boolean =>
    compactDeviceId(value).length === 56;
  const folderDisplayName = (folder: FolderInfo): string =>
    folder.label || folder.id;
  const favoriteKey = (
    folderId: string,
    path: string,
    kind: FavoriteItem["kind"],
  ): string => `${kind}:${folderId}:${normalizePath(path)}`;
  const resolveDirectoryPath = (basePath: string, nextPath: string): string => {
    const base = normalizePath(basePath);
    const next = normalizePath(nextPath);
    if (!next) return base;
    if (
      !base ||
      next === base ||
      next.startsWith(`${base}/`) ||
      next.includes("/")
    )
      return next;
    return `${base}/${next}`;
  };

  const toConnectionSettings = (): StoredConnectionSettings => ({
    host,
    port,
    cert,
    key,
    remoteId,
    deviceName,
    timeoutMs,
    discoveryMode,
    discoveryServer: normalizeDiscoveryServer(discoveryServer),
    enableRelayFallback,
  });

  const fromConnectionSettings = (
    stored: StoredConnectionSettings | null,
  ): StoredConnectionSettings => {
    const discoveryMode: DiscoveryMode =
      stored?.discoveryMode === "direct" ? "direct" : "global";

    if (!stored) {
      return {
        host: "",
        port: 22000,
        cert: "",
        key: "",
        remoteId: "",
        deviceName: "syncpeer-ui",
        timeoutMs: 15000,
        discoveryMode,
        discoveryServer: getDefaultDiscoveryServer(),
        enableRelayFallback: true,
      };
    }

    return {
      host:
        discoveryMode === "direct"
          ? stored.host || "127.0.0.1"
          : stored.host || "",
      port: Number(stored.port) || 22000,
      cert: stored.cert || "",
      key: stored.key || "",
      remoteId: stored.remoteId || "",
      deviceName: stored.deviceName || "syncpeer-ui",
      timeoutMs: Number(stored.timeoutMs) || 15000,
      discoveryMode,
      discoveryServer: normalizeDiscoveryServer(stored.discoveryServer),
      enableRelayFallback: stored.enableRelayFallback !== false,
    };
  };

  const persistedState = loadPersistedAppState();
  const initialSettings = fromConnectionSettings(
    persistedState?.connection ?? null,
  );

  let activeTab: Tab =
    persistedState?.activeTab === "devices" || persistedState?.activeTab === "folders"
      ? persistedState.activeTab
      : "favorites";

  let host = initialSettings.host;
  let port = initialSettings.port;
  let cert = initialSettings.cert;
  let key = initialSettings.key;
  let remoteId = initialSettings.remoteId;
  let deviceName = initialSettings.deviceName;
  let timeoutMs = initialSettings.timeoutMs;
  let discoveryMode: DiscoveryMode = initialSettings.discoveryMode;
  let discoveryServer = initialSettings.discoveryServer;
  let enableRelayFallback = initialSettings.enableRelayFallback;

  let remoteFs: RemoteFsLike | null = null;
  let isConnected = false;
  let isConnecting = false;
  let isRefreshing = false;
  let isLoadingDirectory = false;
  let isDownloading = false;
  let activeDownloadKey = "";
  let activeDownloadText = "";
  let isOpeningCachedFile = false;
  let isRemovingCachedFile = false;
  let isClearingCache = false;
  let isLoadingDownloadedFiles = false;
  let showDownloadedFiles = false;
  let isSettingsExpanded = false;
  let uploadMessage = "";
  let lastUpdatedAt = "";
  let activeConnectDeviceId = "";

  let folders: FolderInfo[] = [];
  let entries: FileEntry[] = [];
  let remoteDevice: RemoteDeviceInfo | null = null;
  let folderSyncStates: FolderSyncState[] = [];
  let currentFolderVersionKey = "";

  let currentFolderId = "";
  let currentPath = "";
  let directoryLoadSeq = 0;

  let favorites: FavoriteItem[] = [];
  let savedDevices: SavedDevice[] = normalizeSavedDevices(
    persistedState?.savedDevices,
  );
  let selectedSavedDeviceId =
    persistedState?.selectedSavedDeviceId || savedDevices[0]?.id || "";
  let newSavedDeviceName = "";
  let newSavedDeviceId = "";
  let visibleBreadcrumbs: BreadcrumbSegment[] = [];
  let favoriteKeys = new Set<string>();
  let cachedFileKeys = new Set<string>();
  let downloadedFiles: CachedFileRecord[] = [];

  let connectionModeLabel = "";
  let connectionPath = "";
  let connectionTransport: "direct-tcp" | "relay" | "" = "";
  let recentError: string | null = null;
  let sessionLogs: SessionLogItem[] = [];
  let isLogPanelExpanded = false;
  let lastLoggedError = "";
  let identityRecoverySecret = "";
  let exportedIdentityDeviceId = "";
  let exportedIdentitySecret = "";
  let isExportingIdentityRecovery = false;
  let isRestoringIdentityRecovery = false;

  let error: string | null = null;
  let nextSessionLogId = 1;

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

  const client = createSyncpeerUiClient({ onLog: pushClientLog });

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

  $: persistAppState({
    activeTab,
    selectedSavedDeviceId,
    connection: toConnectionSettings(),
    savedDevices,
  });
  $: if (
    savedDevices.length > 0 &&
    !savedDevices.some((device) => device.id === selectedSavedDeviceId)
  ) {
    selectedSavedDeviceId = savedDevices[0].id;
  }
  $: if (savedDevices.length === 0) {
    selectedSavedDeviceId = "";
  }
  $: favoriteKeys = new Set(favorites.map((item) => item.key));
  $: visibleBreadcrumbs = breadcrumbSegments(
    currentFolderId,
    currentPath,
    folders,
  );
  $: if (discoveryMode === "global" && host === "127.0.0.1") {
    host = "";
  }
  $: if (error && error !== lastLoggedError) {
    lastLoggedError = error;
    pushSessionLog("error", "ui.error", error);
  }

  const connectionDetails = (): ConnectOptions => ({
    host,
    port,
    discoveryMode,
    discoveryServer: normalizeDiscoveryServer(discoveryServer),
    cert: cert || undefined,
    key: key || undefined,
    remoteId: remoteId || undefined,
    deviceName,
    timeoutMs,
    enableRelayFallback,
  });

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

  const breadcrumbSegments = (
    folderId: string,
    path: string,
    availableFolders: FolderInfo[],
  ): BreadcrumbSegment[] => {
    if (!folderId) return [];
    const folder = availableFolders.find(
      (candidate) => candidate.id === folderId,
    );
    const folderLabel = folder?.label || folderId;
    const cleanPath = normalizePath(path);
    const parts = cleanPath ? cleanPath.split("/") : [];

    const segments: BreadcrumbSegment[] = [
      {
        key: `folder:${folderId}`,
        label: folderLabel,
        targetFolderId: folderId,
        targetPath: "",
      },
    ];

    for (let index = 0; index < parts.length; index += 1) {
      const segmentPath = parts.slice(0, index + 1).join("/");
      segments.push({
        key: `path:${segmentPath}`,
        label: parts[index],
        targetFolderId: folderId,
        targetPath: segmentPath,
      });
    }

    if (segments.length <= MAX_VISIBLE_CRUMBS) return segments;
    return [
      {
        key: "ellipsis",
        label: "...",
        targetFolderId: folderId,
        targetPath: "",
        ellipsis: true,
      },
      ...segments.slice(segments.length - (MAX_VISIBLE_CRUMBS - 1)),
    ];
  };

  const cachedFileKey = (folderId: string, path: string): string =>
    `${folderId}:${normalizePath(path)}`;
  const formatRate = (bytesPerSecond: number): string => {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
    if (bytesPerSecond >= 1024 * 1024)
      return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bytesPerSecond >= 1024)
      return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${Math.round(bytesPerSecond)} B/s`;
  };
  const formatEta = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) return "--";
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.ceil(seconds % 60);
    return `${minutes}m ${remaining}s`;
  };
  const downloadButtonLabel = (folderId: string, path: string): string => {
    const keyValue = cachedFileKey(folderId, path);
    if (keyValue !== activeDownloadKey) return "Download";
    return activeDownloadText || "Downloading...";
  };
  const isSavedDeviceConnected = (deviceId: string): boolean =>
    isConnected && normalizeDeviceId(remoteDevice?.id ?? remoteId) === normalizeDeviceId(deviceId);

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
    if (targetDeviceId) {
      selectedSavedDeviceId = targetDeviceId;
      remoteId = targetDeviceId;
      discoveryMode = "global";
      host = "";
      activeConnectDeviceId = targetDeviceId;
    }
    if (
      discoveryMode === "global" &&
      normalizeDeviceId(remoteId) === "" &&
      selectedSavedDeviceId
    ) {
      remoteId = selectedSavedDeviceId;
    }
    if (discoveryMode === "global" && normalizeDeviceId(remoteId) === "") {
      const message =
        "Global discovery requires a Remote Device ID. Add/select a saved device first.";
      error = message;
      recentError = message;
      activeConnectDeviceId = "";
      return;
    }
    if (discoveryMode === "global" && !isValidSyncthingDeviceId(remoteId)) {
      const message =
        "Remote Device ID looks invalid. Expected 56 base32 chars (A-Z, 2-7), usually shown as 8 groups separated by dashes.";
      error = message;
      recentError = message;
      activeConnectDeviceId = "";
      return;
    }
    if (discoveryMode === "global") {
      discoveryServer = normalizeDiscoveryServer(discoveryServer);
    }
    connectionModeLabel =
      discoveryMode === "global"
        ? `Global discovery via ${normalizeDiscoveryServer(discoveryServer)}`
        : `Direct ${host || "127.0.0.1"}:${port}`;

    remoteId = normalizeDeviceId(remoteId);
    isConnecting = true;
    try {
      remoteFs = await client.connectAndSync(connectionDetails());
      const overview = await client.connectAndGetOverview(connectionDetails());
      isConnected = true;
      folders = overview.folders;
      remoteDevice = overview.device;
      folderSyncStates = overview.folderSyncStates ?? [];
      connectionPath = overview.connectedVia;
      connectionTransport = overview.transportKind;
      recentError = null;
      if (!currentFolderId) {
        entries = [];
      }
      currentFolderVersionKey = "";
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      recentError = message;
      reportUiError("connect.failed", rawError, connectionDetails());
      isConnected = false;
      remoteFs = null;
      remoteDevice = null;
      connectionPath = "";
      connectionTransport = "";
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
      isConnected = false;
      remoteFs = null;
      remoteDevice = null;
      folders = [];
      entries = [];
      folderSyncStates = [];
      connectionPath = "";
      connectionTransport = "";
      currentFolderId = "";
      currentPath = "";
      currentFolderVersionKey = "";
      activeConnectDeviceId = "";
      recentError = null;
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
    currentFolderId = "";
    currentPath = "";
    entries = [];
    uploadMessage = "";
    await refreshActiveView();
  }

  async function loadCurrentDirectory() {
    if (!remoteFs || !currentFolderId) return;
    error = null;
    const requestSeq = ++directoryLoadSeq;
    isLoadingDirectory = true;
    try {
      const nextEntries = await remoteFs.readDir(
        currentFolderId,
        normalizePath(currentPath),
      );
      if (requestSeq !== directoryLoadSeq) return;
      entries = nextEntries;
      const filePaths = nextEntries
        .filter((entry: FileEntry) => entry.type !== "directory")
        .map((entry: FileEntry) => entry.path);
      void refreshCachedStatuses(currentFolderId, filePaths);
      currentFolderVersionKey = folderVersionKey(currentFolderId);
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      if (requestSeq !== directoryLoadSeq) return;
      const message =
        rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError("load_current_directory.failed", rawError, {
        folderId: currentFolderId,
        path: normalizePath(currentPath),
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
      folders = overview.folders;
      remoteDevice = overview.device;
      folderSyncStates = overview.folderSyncStates ?? [];
      connectionPath = overview.connectedVia;
      connectionTransport = overview.transportKind;
      if (activeTab === "folders" && currentFolderId) {
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
        "Device ID looks invalid. Expected 56 base32 chars (A-Z, 2-7), usually shown as 8 groups separated by dashes.";
      return;
    }
    const displayName = newSavedDeviceName.trim() || normalizedId;
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
        { id: normalizedId, name: displayName, createdAtMs: Date.now() },
      ].sort((a, b) => a.name.localeCompare(b.name));
    }
    selectedSavedDeviceId = normalizedId;
    remoteId = normalizedId;
    newSavedDeviceName = "";
    newSavedDeviceId = "";
    error = null;
  }

  function useSavedDevice(deviceId: string) {
    selectedSavedDeviceId = deviceId;
    remoteId = deviceId;
  }

  function resetDiscoveryServer() {
    discoveryServer = getDefaultDiscoveryServer();
  }

  function removeSavedDevice(deviceId: string) {
    savedDevices = savedDevices.filter((device) => device.id !== deviceId);
    if (remoteId === deviceId) {
      remoteId = "";
    }
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
        <button class="primary" on:click={() => connect()} disabled={isConnecting}>
          {isConnecting ? "Connecting..." : "Connect"}
        </button>
        {#if connectionModeLabel}
          <span>{connectionModeLabel}</span>
        {/if}
      </div>
    {:else}
      <div class="global-connect">
        <button class="ghost" on:click={disconnect} disabled={isConnecting}>
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
          <button class="primary" on:click={() => connect()} disabled={isConnecting}>
            {isConnecting ? "Connecting..." : "Connect Using Last Settings"}
          </button>
        {/if}

        <details bind:open={isSettingsExpanded}>
          <summary>Connection Settings</summary>
          <form class="settings" on:submit|preventDefault={() => connect()}>
            <label>
              Discovery Method
              <select bind:value={discoveryMode}>
                <option value="global">Global Discovery (default)</option>
                <option value="direct">Direct Host/Port</option>
              </select>
            </label>

            {#if discoveryMode === "global"}
              <label>
                Discovery Server
                <input type="text" bind:value={discoveryServer} />
              </label>
            {/if}

            {#if discoveryMode === "direct"}
              <label>
                Host
                <input type="text" bind:value={host} placeholder="127.0.0.1" />
              </label>

              <label>
                Port
                <input type="number" bind:value={port} min="1" max="65535" />
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
                bind:value={remoteId}
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
                bind:value={cert}
                placeholder="Auto uses persisted cli-node cert.pem"
              />
            </label>

            <label>
              TLS Key (optional)
              <input
                type="text"
                bind:value={key}
                placeholder="Auto uses persisted cli-node key.pem"
              />
            </label>

            <label>
              Device Name
              <input type="text" bind:value={deviceName} />
            </label>

            <label>
              Timeout (ms)
              <input
                type="number"
                bind:value={timeoutMs}
                min="1000"
                step="1000"
              />
            </label>

            <label class="checkbox-row">
              <input type="checkbox" bind:checked={enableRelayFallback} />
              <span>Enable relay fallback (Syncthing relay://)</span>
            </label>
          </form>

          <div class="actions">
            <button
              type="button"
              class="ghost"
              on:click={() => useSavedDevice(selectedSavedDeviceId)}
              disabled={selectedSavedDeviceId === ""}
            >
              Use Selected Device
            </button>
            <button
              type="button"
              class="ghost"
              on:click={resetDiscoveryServer}
              disabled={discoveryMode !== "global"}
            >
              Use Official Discovery Server
            </button>
            <button
              type="button"
              class="ghost"
              on:click={clearAllCache}
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
            on:click={exportIdentityRecovery}
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
          />
        {/if}

        <label>
          Restore From Recovery Secret
          <textarea
            class="recovery-secret"
            bind:value={identityRecoverySecret}
            placeholder="Paste recovery secret here"
          />
        </label>
        <div class="actions">
          <button
            type="button"
            class="ghost"
            on:click={restoreIdentityRecovery}
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
            Device Name
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
          <div class="actions">
            <button type="button" class="primary" on:click={addSavedDevice}
              >Add Device</button
            >
          </div>
        </div>
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
                      on:click={() => useSavedDevice(device.id)}
                      >{device.name}</button
                    >
                    {#if isSavedDeviceConnected(device.id)}
                      <span class="status-chip online small">online</span>
                    {/if}
                  </div>
                  <div class="item-meta">{device.id}</div>
                </div>
                <div class="item-actions">
                  <button
                    class="primary"
                    on:click={() => connectToSavedDevice(device.id)}
                    disabled={isConnecting}
                  >
                    {isConnecting && activeConnectDeviceId === device.id ? "Connecting..." : "Connect"}
                  </button>
                  <button
                    class="ghost"
                    on:click={() => useSavedDevice(device.id)}>Use</button
                  >
                  <button
                    class="icon"
                    on:click={() => removeSavedDevice(device.id)}
                    title="Remove saved device">X</button
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
                  on:click={refreshOverview}
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
              on:click={copySessionLogs}
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
            on:click={openDownloadedFilesPanel}
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
                    on:click={() => openFavorite(favorite)}
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
                        on:click={() =>
                          openCachedFile(favorite.folderId, favorite.path)}
                        disabled={isOpeningCachedFile}
                      >
                        Open
                      </button>
                    {:else}
                      <button
                        class="ghost"
                        on:click={() =>
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
                    class="icon"
                    on:click={() => void removeFavorite(favorite)}
                    title="Remove favorite">★</button
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
              on:click={clearAllCache}
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
                      on:click={() => openCachedFile(file.folderId, file.path)}
                      disabled={isOpeningCachedFile}
                    >
                      Open
                    </button>
                    <button
                      class="ghost"
                      on:click={() =>
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
              on:click={() => refreshActiveView()}
              disabled={isRefreshing || isConnecting || isLoadingDirectory}
              title={isRefreshing ? "Refreshing..." : "Refresh"}
            >
              Refresh
            </button>
          </div>

          <div class="breadcrumbs">
            {#if !currentFolderId}
              <span class="crumb-current">All Syncthing Folders</span>
            {:else}
              <button class="crumb-button" on:click={goToRootView}
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
                      on:click={() => goToBreadcrumb(segment)}
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
                        on:click={() => openFolderRoot(folder.id)}
                        >{folder.name}</button
                      >
                      <div class="item-meta">
                        {folder.readOnly ? "read-only" : "read-write"}
                      </div>
                    </div>
                    <div class="item-actions">
                      <button
                        class="icon"
                        on:click={() =>
                          void toggleFavorite(
                            folder.id,
                            "",
                            folder.name,
                            "folder",
                          )}
                        title="Toggle favorite"
                      >
                        {favoriteKeys.has(favoriteKey(folder.id, "", "folder"))
                          ? "★"
                          : "☆"}
                      </button>
                    </div>
                  </li>
                {/each}
              {/if}
            </ul>
          {:else}
            <ul class="list">
              {#if isLoadingDirectory}
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
                          on:click={() => openDirectory(entry.path)}
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
                      {#if entry.type !== "directory"}
                        {#if cachedFileKeys.has(cachedFileKey(currentFolderId, entry.path))}
                          <button
                            class="ghost"
                            on:click={() =>
                              openCachedFile(currentFolderId, entry.path)}
                            disabled={isOpeningCachedFile}
                          >
                            Open
                          </button>
                        {:else}
                          <button
                            class="ghost"
                            on:click={() =>
                              downloadFile(
                                currentFolderId,
                                entry.path,
                                entry.name,
                              )}
                            disabled={isDownloading || entry.invalid}
                          >
                            {downloadButtonLabel(currentFolderId, entry.path)}
                          </button>
                        {/if}
                      {/if}
                      <button
                        class="icon"
                        on:click={() =>
                          void toggleFavorite(
                            currentFolderId,
                            entry.path,
                            entry.name,
                            entry.type === "directory" ? "folder" : "file",
                          )}
                        title="Toggle favorite"
                      >
                        {favoriteKeys.has(
                          favoriteKey(
                            currentFolderId,
                            entry.path,
                            entry.type === "directory" ? "folder" : "file",
                          ),
                        )
                          ? "★"
                          : "☆"}
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
                on:change={handleUploadSelected}
              />
              <button class="primary" on:click={handleUploadClick}
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
      on:click={() => switchTab("favorites")}
    >
      <span class="tab-icon" aria-hidden="true">★</span>
      <span class="sr-only">Favorites</span>
    </button>
    <button
      class={`tab-button ${activeTab === "folders" ? "active" : ""}`}
      on:click={() => switchTab("folders")}
    >
      <span class="tab-icon" aria-hidden="true">▦</span>
      <span class="sr-only">Folders</span>
    </button>
    <button
      class={`tab-button ${activeTab === "devices" ? "active" : ""}`}
      on:click={() => switchTab("devices")}
    >
      <span class="tab-icon" aria-hidden="true">☰</span>
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
    min-width: 2.1rem;
    padding: 0.35rem 0.5rem;
    text-align: center;
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
    grid-template-columns: 1fr auto;
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
    align-self: center;
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

  .tab-icon {
    font-size: 1.15rem;
    line-height: 1;
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
  }
</style>
