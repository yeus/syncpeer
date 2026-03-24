<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    createSyncpeerUiClient,
    reportUiError,
    type ConnectOptions,
    type RemoteFsLike,
  } from './lib/syncpeerClient';
  import type { FileEntry, FolderInfo, FolderSyncState, RemoteDeviceInfo } from '@syncpeer/core/browser';

  type Tab = 'favorites' | 'folders' | 'devices';
  type DiscoveryMode = 'global' | 'direct';

  interface RootFolderEntry {
    type: 'root-folder';
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
    kind: 'folder' | 'file';
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
  }

  interface SavedDevice {
    id: string;
    name: string;
    createdAtMs: number;
  }

  const FAVORITES_STORAGE_KEY = 'syncpeer.ui.favorites.v1';
  const CONNECTION_STORAGE_KEY = 'syncpeer.ui.connection.v1';
  const SAVED_DEVICES_STORAGE_KEY = 'syncpeer.ui.savedDevices.v1';
  const REFRESH_MS = 3000;
  const MAX_VISIBLE_CRUMBS = 4;

  const client = createSyncpeerUiClient();

  const parseJson = <T,>(raw: string | null): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const loadStoredConnectionSettings = (): StoredConnectionSettings | null => {
    if (typeof window === 'undefined') return null;
    return parseJson<StoredConnectionSettings>(window.localStorage.getItem(CONNECTION_STORAGE_KEY));
  };

  const loadStoredFavorites = (): FavoriteItem[] => {
    if (typeof window === 'undefined') return [];
    const parsed = parseJson<FavoriteItem[]>(window.localStorage.getItem(FAVORITES_STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  };

  const persistConnectionSettings = (settings: StoredConnectionSettings): void => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(settings));
  };

  const persistFavorites = (items: FavoriteItem[]): void => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(items));
  };

  const loadStoredDevices = (): SavedDevice[] => {
    if (typeof window === 'undefined') return [];
    const parsed = parseJson<SavedDevice[]>(window.localStorage.getItem(SAVED_DEVICES_STORAGE_KEY));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => typeof item?.id === 'string' && item.id.trim() !== '')
      .map((item) => ({
        id: String(item.id).trim(),
        name: String(item.name ?? '').trim() || String(item.id).trim(),
        createdAtMs: Number(item.createdAtMs) || Date.now(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const persistSavedDevices = (items: SavedDevice[]): void => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SAVED_DEVICES_STORAGE_KEY, JSON.stringify(items));
  };

  const normalizePath = (value: string): string => value.replace(/^\/+|\/+$/g, '');
  const normalizeDeviceId = (value: string): string => value.trim().toUpperCase().replace(/[^A-Z2-7-]/g, '');
  const folderDisplayName = (folder: FolderInfo): string => folder.label || folder.id;
  const favoriteKey = (folderId: string, path: string, kind: FavoriteItem['kind']): string =>
    `${kind}:${folderId}:${normalizePath(path)}`;

  const toConnectionSettings = (): StoredConnectionSettings => ({
    host,
    port,
    cert,
    key,
    remoteId,
    deviceName,
    timeoutMs,
    discoveryMode,
    discoveryServer,
  });

  const fromConnectionSettings = (stored: StoredConnectionSettings | null): StoredConnectionSettings => {
    if (!stored) {
      return {
        host: '127.0.0.1',
        port: 22000,
        cert: '',
        key: '',
        remoteId: '',
        deviceName: 'syncpeer-ui',
        timeoutMs: 15000,
        discoveryMode: 'global',
        discoveryServer: 'https://discovery.syncthing.net/v2/',
      };
    }
    return {
      host: stored.host || '127.0.0.1',
      port: Number(stored.port) || 22000,
      cert: stored.cert || '',
      key: stored.key || '',
      remoteId: stored.remoteId || '',
      deviceName: stored.deviceName || 'syncpeer-ui',
      timeoutMs: Number(stored.timeoutMs) || 15000,
      discoveryMode: stored.discoveryMode === 'direct' ? 'direct' : 'global',
      discoveryServer: stored.discoveryServer || 'https://discovery.syncthing.net/v2/',
    };
  };

  const initialSettings = fromConnectionSettings(loadStoredConnectionSettings());

  let activeTab: Tab = 'favorites';

  let host = initialSettings.host;
  let port = initialSettings.port;
  let cert = initialSettings.cert;
  let key = initialSettings.key;
  let remoteId = initialSettings.remoteId;
  let deviceName = initialSettings.deviceName;
  let timeoutMs = initialSettings.timeoutMs;
  let discoveryMode: DiscoveryMode = initialSettings.discoveryMode;
  let discoveryServer = initialSettings.discoveryServer;

  let remoteFs: RemoteFsLike | null = null;
  let isConnected = false;
  let isConnecting = false;
  let isRefreshing = false;
  let isLoadingDirectory = false;
  let isDownloading = false;
  let isSettingsExpanded = false;
  let uploadMessage = '';
  let lastUpdatedAt = '';

  let folders: FolderInfo[] = [];
  let entries: FileEntry[] = [];
  let remoteDevice: RemoteDeviceInfo | null = null;
  let folderSyncStates: FolderSyncState[] = [];
  let currentFolderVersionKey = '';

  let currentFolderId = '';
  let currentPath = '';
  let directoryLoadSeq = 0;

  let favorites: FavoriteItem[] = loadStoredFavorites();
  let savedDevices: SavedDevice[] = loadStoredDevices();
  let selectedSavedDeviceId = savedDevices[0]?.id ?? '';
  let newSavedDeviceName = '';
  let newSavedDeviceId = '';
  let visibleBreadcrumbs: BreadcrumbSegment[] = [];

  let error: string | null = null;

  const refreshTimer = setInterval(() => {
    void refreshActiveView();
  }, REFRESH_MS);

  onDestroy(() => {
    clearInterval(refreshTimer);
  });

  $: persistConnectionSettings(toConnectionSettings());
  $: persistFavorites(favorites);
  $: persistSavedDevices(savedDevices);
  $: if (savedDevices.length > 0 && !savedDevices.some((device) => device.id === selectedSavedDeviceId)) {
    selectedSavedDeviceId = savedDevices[0].id;
  }
  $: if (savedDevices.length === 0) {
    selectedSavedDeviceId = '';
  }
  $: visibleBreadcrumbs = breadcrumbSegments();

  const connectionDetails = (): ConnectOptions => ({
    host,
    port,
    discoveryMode,
    discoveryServer,
    cert: cert || undefined,
    key: key || undefined,
    remoteId: remoteId || undefined,
    deviceName,
    timeoutMs,
  });

  const rootFolderEntries = (): RootFolderEntry[] =>
    folders
      .map((folder) => ({
        type: 'root-folder' as const,
        id: folder.id,
        name: folderDisplayName(folder),
        readOnly: folder.readOnly,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  const folderVersionKey = (folderId: string): string => {
    const syncState = folderSyncStates.find((state) => state.folderId === folderId);
    if (!syncState) return '';
    return `${syncState.remoteIndexId}:${syncState.remoteMaxSequence}`;
  };

  const breadcrumbSegments = (): BreadcrumbSegment[] => {
    if (!currentFolderId) return [];
    const folder = folders.find((candidate) => candidate.id === currentFolderId);
    const folderLabel = folder?.label || currentFolderId;
    const cleanPath = normalizePath(currentPath);
    const parts = cleanPath ? cleanPath.split('/') : [];

    const segments: BreadcrumbSegment[] = [
      {
        key: `folder:${currentFolderId}`,
        label: folderLabel,
        targetFolderId: currentFolderId,
        targetPath: '',
      },
    ];

    for (let index = 0; index < parts.length; index += 1) {
      const segmentPath = parts.slice(0, index + 1).join('/');
      segments.push({
        key: `path:${segmentPath}`,
        label: parts[index],
        targetFolderId: currentFolderId,
        targetPath: segmentPath,
      });
    }

    if (segments.length <= MAX_VISIBLE_CRUMBS) return segments;
    return [
      {
        key: 'ellipsis',
        label: '...',
        targetFolderId: currentFolderId,
        targetPath: '',
        ellipsis: true,
      },
      ...segments.slice(segments.length - (MAX_VISIBLE_CRUMBS - 1)),
    ];
  };

  const isFavorite = (folderId: string, path: string, kind: FavoriteItem['kind']): boolean =>
    favorites.some((item) => item.key === favoriteKey(folderId, path, kind));

  const toggleFavorite = (folderId: string, path: string, name: string, kind: FavoriteItem['kind']): void => {
    const keyValue = favoriteKey(folderId, path, kind);
    const exists = favorites.some((item) => item.key === keyValue);
    if (exists) {
      favorites = favorites.filter((item) => item.key !== keyValue);
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
  };

  const removeFavorite = (favorite: FavoriteItem): void => {
    favorites = favorites.filter((item) => item.key !== favorite.key);
  };

  async function connect() {
    error = null;
    uploadMessage = '';
    if (discoveryMode === 'global' && normalizeDeviceId(remoteId) === '' && selectedSavedDeviceId) {
      remoteId = selectedSavedDeviceId;
    }
    if (discoveryMode === 'global' && normalizeDeviceId(remoteId) === '') {
      error = 'Global discovery requires a Remote Device ID. Add/select a saved device first.';
      return;
    }
    remoteId = normalizeDeviceId(remoteId);
    isConnecting = true;
    try {
      remoteFs = await client.connectAndSync(connectionDetails());
      const overview = await client.connectAndGetOverview(connectionDetails());
      isConnected = true;
      folders = overview.folders;
      remoteDevice = overview.device;
      folderSyncStates = overview.folderSyncStates ?? [];
      if (!currentFolderId) {
        entries = [];
      }
      currentFolderVersionKey = '';
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      const message = rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError('connect.failed', rawError, connectionDetails());
      isConnected = false;
      remoteFs = null;
      remoteDevice = null;
    } finally {
      isConnecting = false;
    }
  }

  async function openFolderRoot(folderId: string) {
    currentFolderId = folderId;
    currentPath = '';
    currentFolderVersionKey = '';
    uploadMessage = '';
    activeTab = 'folders';
    await loadCurrentDirectory();
  }

  async function openDirectory(path: string) {
    if (!currentFolderId) return;
    currentPath = normalizePath(path);
    uploadMessage = '';
    await loadCurrentDirectory();
  }

  async function goToBreadcrumb(segment: BreadcrumbSegment) {
    if (segment.ellipsis) return;
    currentFolderId = segment.targetFolderId;
    currentPath = segment.targetPath;
    uploadMessage = '';
    await loadCurrentDirectory();
  }

  async function goToRootView() {
    currentFolderId = '';
    currentPath = '';
    entries = [];
    uploadMessage = '';
    await refreshActiveView();
  }

  async function loadCurrentDirectory() {
    if (!remoteFs || !currentFolderId) return;
    error = null;
    const requestSeq = ++directoryLoadSeq;
    isLoadingDirectory = true;
    try {
      const nextEntries = await remoteFs.readDir(currentFolderId, normalizePath(currentPath));
      if (requestSeq !== directoryLoadSeq) return;
      entries = nextEntries;
      currentFolderVersionKey = folderVersionKey(currentFolderId);
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      if (requestSeq !== directoryLoadSeq) return;
      const message = rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError('load_current_directory.failed', rawError, {
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
    if (!isConnected || !remoteFs || isConnecting || isRefreshing || isLoadingDirectory) return;
    isRefreshing = true;
    error = null;
    try {
      const overview = await client.connectAndGetOverview(connectionDetails());
      folders = overview.folders;
      remoteDevice = overview.device;
      folderSyncStates = overview.folderSyncStates ?? [];
      if (activeTab === 'folders' && currentFolderId) {
        const nextFolderVersionKey = folderVersionKey(currentFolderId);
        const shouldReloadDirectory =
          entries.length === 0 || !currentFolderVersionKey || currentFolderVersionKey !== nextFolderVersionKey;
        if (shouldReloadDirectory) {
          await loadCurrentDirectory();
        }
      }
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      const message = rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError('refresh_overview.failed', rawError, connectionDetails());
    } finally {
      isRefreshing = false;
    }
  }

  async function refreshActiveView() {
    if (activeTab === 'devices' || activeTab === 'folders' || activeTab === 'favorites') {
      await refreshOverview();
    }
  }

  function switchTab(tab: Tab) {
    activeTab = tab;
    if (tab === 'folders' || tab === 'favorites') {
      void refreshActiveView();
    }
  }

  function formatModified(ms: number): string {
    if (!ms) return 'n/a';
    return new Date(ms).toLocaleString();
  }

  async function downloadFile(folderId: string, path: string, name: string) {
    if (!remoteFs || !isConnected || isDownloading) return;
    isDownloading = true;
    error = null;
    try {
      const bytes = await remoteFs.readFileFully(folderId, path);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = name;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch (rawError: unknown) {
      const message = rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError('download_file.failed', rawError, { folderId, path });
    } finally {
      isDownloading = false;
    }
  }

  async function openFavorite(favorite: FavoriteItem) {
    if (!isConnected) return;
    activeTab = 'folders';
    currentFolderId = favorite.folderId;
    currentPath = favorite.kind === 'folder' ? favorite.path : normalizePath(favorite.path.split('/').slice(0, -1).join('/'));
    uploadMessage = '';
    await loadCurrentDirectory();
  }

  function handleUploadClick() {
    const input = document.getElementById('folder-upload-input') as HTMLInputElement | null;
    input?.click();
  }

  function handleUploadSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const fileName = input.files?.[0]?.name;
    uploadMessage = fileName
      ? `Upload selected (${fileName}) but uploading is not available in this read-only BEP client yet.`
      : '';
    input.value = '';
  }

  function addSavedDevice() {
    const normalizedId = normalizeDeviceId(newSavedDeviceId);
    if (!normalizedId) {
      error = 'Device ID is required.';
      return;
    }
    const displayName = newSavedDeviceName.trim() || normalizedId;
    const existing = savedDevices.find((device) => device.id === normalizedId);
    if (existing) {
      savedDevices = savedDevices
        .map((device) => (device.id === normalizedId ? { ...device, name: displayName } : device))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else {
      savedDevices = [...savedDevices, { id: normalizedId, name: displayName, createdAtMs: Date.now() }]
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    selectedSavedDeviceId = normalizedId;
    remoteId = normalizedId;
    newSavedDeviceName = '';
    newSavedDeviceId = '';
    error = null;
  }

  function useSavedDevice(deviceId: string) {
    selectedSavedDeviceId = deviceId;
    remoteId = deviceId;
  }

  function removeSavedDevice(deviceId: string) {
    savedDevices = savedDevices.filter((device) => device.id !== deviceId);
    if (remoteId === deviceId) {
      remoteId = '';
    }
  }
</script>

<style>
  :global(body) {
    margin: 0;
    font-family: 'IBM Plex Sans', 'Segoe UI', sans-serif;
    background: #f3f5f8;
    color: #1f2933;
  }

  .app-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, #f7f9fc 0%, #edf2f7 100%);
  }

  .content {
    flex: 1;
    padding: 0.7rem 0.7rem 4.8rem;
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  .panel {
    background: #ffffff;
    border: 1px solid #dbe2ea;
    border-radius: 12px;
    box-shadow: 0 6px 20px rgba(15, 23, 42, 0.05);
    padding: 0.75rem;
  }

  .panel + .panel {
    margin-top: 0.6rem;
  }

  .heading {
    margin: 0 0 0.5rem;
    font-size: 0.94rem;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  form.settings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.55rem;
    margin-top: 0.5rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
    color: #445366;
  }

  input,
  select {
    padding: 0.45rem 0.5rem;
    font-size: 0.88rem;
    border: 1px solid #c7d2df;
    border-radius: 8px;
    background: #fff;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
    flex-wrap: wrap;
  }

  button {
    border: 1px solid #a6b7ca;
    border-radius: 8px;
    background: #ffffff;
    color: #1b3049;
    padding: 0.4rem 0.7rem;
    font-size: 0.85rem;
    cursor: pointer;
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

  .global-connect {
    margin-bottom: 0.55rem;
    display: flex;
    justify-content: flex-end;
  }

  .status-row {
    display: flex;
    gap: 0.55rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.8rem;
    color: #4c627a;
    margin-bottom: 0.55rem;
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

  details {
    border: 1px solid #dbe3ee;
    border-radius: 10px;
    padding: 0.4rem 0.55rem;
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
    gap: 0.55rem;
  }

  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.6rem;
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
    border-radius: 10px;
    overflow: hidden;
  }

  .list-item {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.45rem;
    padding: 0.55rem 0.65rem;
    border-bottom: 1px solid #eef2f7;
    background: #fff;
  }

  .list-item:last-child {
    border-bottom: none;
  }

  .item-main {
    min-width: 0;
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

  .item-actions {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    align-self: center;
  }

  .empty {
    padding: 0.7rem;
    color: #607286;
    font-size: 0.86rem;
  }

  .error {
    margin: 0;
    color: #a61b1b;
    font-size: 0.84rem;
  }

  .hint {
    margin-top: 0.5rem;
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
    padding: 0.35rem;
    gap: 0.35rem;
  }

  .tab-button {
    border: 1px solid #4f6785;
    color: #d7e3f2;
    background: #15283f;
    border-radius: 8px;
    font-weight: 700;
    letter-spacing: 0.02em;
    font-size: 0.8rem;
  }

  .tab-button.active {
    background: #d6e9ff;
    color: #0d3668;
    border-color: #d6e9ff;
  }

  @media (max-width: 640px) {
    .content {
      padding: 0.55rem 0.55rem 4.7rem;
    }

    form.settings {
      grid-template-columns: 1fr;
    }
  }
</style>

<div class="app-shell">
  <main class="content">
    {#if !isConnected}
      <div class="global-connect">
        <button class="primary" on:click={connect} disabled={isConnecting}>
          {isConnecting ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    {/if}

    {#if activeTab === 'devices'}
      <section class="panel">
        <h2 class="heading">Devices</h2>

        <div class="status-row">
          <span class={`status-chip ${isConnected ? 'online' : 'offline'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
          {#if lastUpdatedAt}
            <span>Updated {lastUpdatedAt}</span>
          {/if}
        </div>

        {#if !isConnected}
          <button class="primary" on:click={connect} disabled={isConnecting}>
            {isConnecting ? 'Connecting...' : 'Connect Using Last Settings'}
          </button>
        {/if}

        <details bind:open={isSettingsExpanded}>
          <summary>Connection Settings</summary>
          <form class="settings" on:submit|preventDefault={connect}>
            <label>
              Discovery Method
              <select bind:value={discoveryMode}>
                <option value="global">Global Discovery (default)</option>
                <option value="direct">Direct Host/Port</option>
              </select>
            </label>

            {#if discoveryMode === 'global'}
              <label>
                Discovery Server
                <input type="text" bind:value={discoveryServer} />
              </label>
            {/if}

            <label>
              Host
              <input type="text" bind:value={host} disabled={discoveryMode === 'global'} />
            </label>

            <label>
              Port
              <input type="number" bind:value={port} min="1" max="65535" disabled={discoveryMode === 'global'} />
            </label>

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
              <input type="text" bind:value={remoteId} placeholder="Required for global discovery" />
            </label>

            <label>
              TLS Certificate (optional)
              <input type="text" bind:value={cert} placeholder="Auto uses persisted cli-node cert.pem" />
            </label>

            <label>
              TLS Key (optional)
              <input type="text" bind:value={key} placeholder="Auto uses persisted cli-node key.pem" />
            </label>

            <label>
              Device Name
              <input type="text" bind:value={deviceName} />
            </label>

            <label>
              Timeout (ms)
              <input type="number" bind:value={timeoutMs} min="1000" step="1000" />
            </label>
          </form>

          <div class="actions">
            <button
              type="button"
              class="ghost"
              on:click={() => useSavedDevice(selectedSavedDeviceId)}
              disabled={selectedSavedDeviceId === ''}
            >
              Use Selected Device
            </button>
          </div>

        </details>
      </section>

      <section class="panel">
        <h2 class="heading">Add Device</h2>
        <div class="saved-device-editor">
          <label>
            Device Name
            <input type="text" bind:value={newSavedDeviceName} placeholder="Kitchen Pixel" />
          </label>
          <label>
            Device ID
            <input type="text" bind:value={newSavedDeviceId} placeholder="ABCD123-..." />
          </label>
          <div class="actions">
            <button type="button" class="primary" on:click={addSavedDevice}>Add Device</button>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2 class="heading">Saved Devices</h2>
        <ul class="list">
          {#if savedDevices.length === 0}
            <li class="empty">No saved devices yet. Add one from Connection Settings.</li>
          {:else}
            {#each savedDevices as device (device.id)}
              <li class="list-item">
                <div class="item-main">
                  <button class="item-title" on:click={() => useSavedDevice(device.id)}>{device.name}</button>
                  <div class="item-meta">{device.id}</div>
                </div>
                <div class="item-actions">
                  <button class="ghost" on:click={() => useSavedDevice(device.id)}>Use</button>
                  <button class="icon" on:click={() => removeSavedDevice(device.id)} title="Remove saved device">X</button>
                </div>
              </li>
            {/each}
          {/if}
        </ul>
      </section>

      <section class="panel">
        <h2 class="heading">Discovered Devices</h2>
        <ul class="list">
          {#if !remoteDevice}
            <li class="empty">No remote device metadata yet. Connect to load the list.</li>
          {:else}
            <li class="list-item">
              <div class="item-main">
                <div class="item-title" title={remoteDevice.deviceName}>{remoteDevice.deviceName}</div>
                <div class="item-meta">{remoteDevice.id}</div>
                <div class="item-meta">{remoteDevice.clientName} {remoteDevice.clientVersion}</div>
              </div>
              <div class="item-actions">
                <button class="ghost" on:click={refreshOverview} disabled={!isConnected || isRefreshing || isConnecting}>
                  {isRefreshing ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </li>
          {/if}
        </ul>
      </section>
    {/if}

    {#if activeTab === 'favorites'}
      <section class="panel">
        <h2 class="heading">Favorites</h2>
        {#if !isConnected}
          <p class="empty">Connect to open favorites and sync folder state.</p>
        {/if}

        <ul class="list">
          {#if favorites.length === 0}
            <li class="empty">No favorites yet. Tap a star on folders/files to add them.</li>
          {:else}
            {#each favorites as favorite (favorite.key)}
              <li class="list-item">
                <div class="item-main">
                  <button class="item-title" on:click={() => openFavorite(favorite)} disabled={!isConnected}>{favorite.name}</button>
                  <div class="item-meta">{favorite.folderId}:{favorite.path || '/'}</div>
                </div>
                <div class="item-actions">
                  {#if favorite.kind === 'file'}
                    <button class="ghost" on:click={() => downloadFile(favorite.folderId, favorite.path, favorite.name)} disabled={!isConnected || isDownloading}>
                      Download
                    </button>
                  {/if}
                  <button class="icon" on:click={() => removeFavorite(favorite)} title="Remove favorite">★</button>
                </div>
              </li>
            {/each}
          {/if}
        </ul>
      </section>
    {/if}

    {#if activeTab === 'folders'}
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
            <button on:click={() => refreshActiveView()} disabled={isRefreshing || isConnecting || isLoadingDirectory}>
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          <div class="breadcrumbs">
            {#if !currentFolderId}
              <span class="crumb-current">All Syncthing Folders</span>
            {:else}
              <button class="crumb-button" on:click={goToRootView}>All Syncthing Folders</button>
              <span class="crumb-separator">&gt;</span>
              {#each visibleBreadcrumbs as segment, index (segment.key)}
                {#if index < visibleBreadcrumbs.length - 1}
                  {#if segment.ellipsis}
                    <span class="crumb-current">...</span>
                  {:else}
                    <button class="crumb-button" on:click={() => goToBreadcrumb(segment)}>{segment.label}</button>
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
                      <button class="item-title" on:click={() => openFolderRoot(folder.id)}>{folder.name}</button>
                      <div class="item-meta">{folder.readOnly ? 'read-only' : 'read-write'}</div>
                    </div>
                    <div class="item-actions">
                      <button
                        class="icon"
                        on:click={() => toggleFavorite(folder.id, '', folder.name, 'folder')}
                        title="Toggle favorite"
                      >
                        {isFavorite(folder.id, '', 'folder') ? '★' : '☆'}
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
                      {#if entry.type === 'directory'}
                        <button class="item-title" on:click={() => openDirectory(entry.path)}>{entry.name}/</button>
                      {:else}
                        <span class="item-title">{entry.name}</span>
                      {/if}
                      <div class="item-meta">{entry.type} | {entry.size} bytes | {formatModified(entry.modifiedMs)}</div>
                    </div>
                    <div class="item-actions">
                      {#if entry.type !== 'directory'}
                        <button class="ghost" on:click={() => downloadFile(currentFolderId, entry.path, entry.name)} disabled={isDownloading}>
                          Download
                        </button>
                      {/if}
                      <button
                        class="icon"
                        on:click={() => toggleFavorite(currentFolderId, entry.path, entry.name, entry.type === 'directory' ? 'folder' : 'file')}
                        title="Toggle favorite"
                      >
                        {isFavorite(currentFolderId, entry.path, entry.type === 'directory' ? 'folder' : 'file') ? '★' : '☆'}
                      </button>
                    </div>
                  </li>
                {/each}
              {/if}
            </ul>

            <div class="actions">
              <input id="folder-upload-input" type="file" style="display: none;" on:change={handleUploadSelected} />
              <button class="primary" on:click={handleUploadClick}>Upload</button>
            </div>
            {#if uploadMessage}
              <div class="hint">{uploadMessage}</div>
            {/if}
          {/if}
        {/if}
      </section>
    {/if}

    {#if error}
      <section class="panel">
        <p class="error">{error}</p>
      </section>
    {/if}
  </main>

  <nav class="bottom-tabs">
    <button class={`tab-button ${activeTab === 'favorites' ? 'active' : ''}`} on:click={() => switchTab('favorites')}>
      Favorites
    </button>
    <button class={`tab-button ${activeTab === 'folders' ? 'active' : ''}`} on:click={() => switchTab('folders')}>
      Folders
    </button>
    <button class={`tab-button ${activeTab === 'devices' ? 'active' : ''}`} on:click={() => switchTab('devices')}>
      Devices
    </button>
  </nav>
</div>
