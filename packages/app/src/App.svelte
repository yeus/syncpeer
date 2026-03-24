<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    createSyncpeerUiClient,
    reportUiError,
    type ConnectOptions,
    type RemoteFsLike,
  } from './lib/syncpeerClient';
  import type { FileEntry, FolderInfo, RemoteDeviceInfo } from '@syncpeer/core/browser';

  type Tab = 'devices' | 'folders';

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
  }

  let activeTab: Tab = 'folders';

  let host = '127.0.0.1';
  let port = 22000;
  let cert = '';
  let key = '';
  let remoteId = '';
  let deviceName = 'syncpeer-ui';
  let timeoutMs = 15000;

  let remoteFs: RemoteFsLike | null = null;
  let isConnected = false;
  let isConnecting = false;
  let isRefreshing = false;
  let isLoadingDirectory = false;
  let lastUpdatedAt = '';

  let folders: FolderInfo[] = [];
  let entries: FileEntry[] = [];
  let remoteDevice: RemoteDeviceInfo | null = null;

  let currentFolderId = '';
  let currentPath = '';
  let directoryLoadSeq = 0;

  let error: string | null = null;

  const REFRESH_MS = 3000;
  const refreshTimer = setInterval(() => {
    void refreshActiveView();
  }, REFRESH_MS);

  onDestroy(() => {
    clearInterval(refreshTimer);
  });

  const normalizedCurrentPath = () => currentPath.replace(/^\/+|\/+$/g, '');

  const connectionDetails = (): ConnectOptions => ({
    host,
    port,
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
        name: folder.label || folder.id,
        readOnly: folder.readOnly,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  const breadcrumbSegments = (): BreadcrumbSegment[] => {
    if (!currentFolderId) return [];
    const folder = folders.find((candidate) => candidate.id === currentFolderId);
    const folderLabel = folder?.label || currentFolderId;
    const cleanPath = normalizedCurrentPath();
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

    return segments;
  };

  async function connect() {
    error = null;
    isConnecting = true;
    try {
      const client = createSyncpeerUiClient();
      remoteFs = await client.connectAndSync(connectionDetails());
      const overview = await client.connectAndGetOverview(connectionDetails());
      isConnected = true;
      folders = overview.folders;
      remoteDevice = overview.device;
      currentFolderId = '';
      currentPath = '';
      entries = [];
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

  async function loadFolders() {
    if (!remoteFs) return;
    folders = await remoteFs.listFolders();
  }

  async function openFolderRoot(folderId: string) {
    currentFolderId = folderId;
    currentPath = '';
    await loadCurrentDirectory();
  }

  async function openDirectory(path: string) {
    if (!currentFolderId) return;
    currentPath = path;
    await loadCurrentDirectory();
  }

  async function goToBreadcrumb(segment: BreadcrumbSegment) {
    currentFolderId = segment.targetFolderId;
    currentPath = segment.targetPath;
    await loadCurrentDirectory();
  }

  async function goToRootView() {
    currentFolderId = '';
    currentPath = '';
    entries = [];
    await refreshActiveView();
  }

  async function loadCurrentDirectory() {
    if (!remoteFs || !currentFolderId) return;
    error = null;
    const requestSeq = ++directoryLoadSeq;
    isLoadingDirectory = true;
    try {
      const nextEntries = await remoteFs.readDir(currentFolderId, normalizedCurrentPath());
      if (requestSeq !== directoryLoadSeq) return;
      entries = nextEntries;
      lastUpdatedAt = new Date().toLocaleTimeString();
    } catch (rawError: unknown) {
      if (requestSeq !== directoryLoadSeq) return;
      const message = rawError instanceof Error ? rawError.message : String(rawError);
      error = message;
      reportUiError('load_current_directory.failed', rawError, {
        folderId: currentFolderId,
        path: normalizedCurrentPath(),
      });
    } finally {
      if (requestSeq === directoryLoadSeq) {
        isLoadingDirectory = false;
      }
    }
  }

  async function refreshActiveView() {
    if (!isConnected || !remoteFs || isConnecting || isRefreshing || isLoadingDirectory) return;
    isRefreshing = true;
    try {
      await loadFolders();
      if (activeTab === 'folders' && currentFolderId) {
        await loadCurrentDirectory();
      }
      if (!currentFolderId) {
        lastUpdatedAt = new Date().toLocaleTimeString();
      }
    } finally {
      isRefreshing = false;
    }
  }

  async function refreshOverview() {
    if (!isConnected || isConnecting || isRefreshing || isLoadingDirectory) return;
    isRefreshing = true;
    error = null;
    try {
      const client = createSyncpeerUiClient();
      const overview = await client.connectAndGetOverview(connectionDetails());
      folders = overview.folders;
      remoteDevice = overview.device;
      if (activeTab === 'folders' && currentFolderId) {
        await loadCurrentDirectory();
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

  function switchTab(tab: Tab) {
    activeTab = tab;
    if (tab === 'folders') {
      void refreshActiveView();
    }
  }

  function handleEntryClick(entry: FileEntry) {
    if (entry.type !== 'directory') return;
    void openDirectory(entry.path);
  }

  function formatModified(ms: number): string {
    if (!ms) return 'n/a';
    return new Date(ms).toLocaleString();
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
    background: linear-gradient(180deg, #f6f8fb 0%, #eef2f7 100%);
  }

  .content {
    flex: 1;
    padding: 1rem 1rem 5.5rem;
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  .panel {
    background: #ffffff;
    border: 1px solid #dbe2ea;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    padding: 1rem;
  }

  .panel + .panel {
    margin-top: 0.9rem;
  }

  .heading {
    margin: 0 0 0.8rem;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  form {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.75rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: #445366;
  }

  input {
    padding: 0.5rem 0.6rem;
    font-size: 0.95rem;
    border: 1px solid #c7d2df;
    border-radius: 8px;
    background: #fff;
  }

  .actions {
    display: flex;
    gap: 0.6rem;
    margin-top: 0.9rem;
    flex-wrap: wrap;
  }

  button {
    border: 1px solid #a6b7ca;
    border-radius: 8px;
    background: #ffffff;
    color: #1b3049;
    padding: 0.5rem 0.85rem;
    font-size: 0.92rem;
    cursor: pointer;
  }

  button.primary {
    border-color: #0f4a93;
    background: #0f4a93;
    color: #fff;
  }

  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .status-row {
    display: flex;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.9rem;
    color: #4c627a;
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.8rem;
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

  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.8rem;
    font-size: 0.95rem;
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
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.8rem;
    padding: 0.7rem 0.8rem;
    border-bottom: 1px solid #eef2f7;
    background: #fff;
  }

  .list-item:last-child {
    border-bottom: none;
  }

  .list-item button {
    border: none;
    background: none;
    padding: 0;
    text-align: left;
    color: #163554;
    font-size: 0.95rem;
  }

  .meta {
    font-size: 0.78rem;
    color: #61778f;
    white-space: nowrap;
  }

  .empty {
    padding: 0.8rem;
    color: #607286;
    font-size: 0.92rem;
  }

  .error {
    margin: 0;
    color: #a61b1b;
    font-size: 0.9rem;
  }

  .bottom-tabs {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    background: #101d2e;
    border-top: 1px solid #1d324e;
    padding: 0.45rem;
    gap: 0.45rem;
  }

  .tab-button {
    border: 1px solid #4f6785;
    color: #d7e3f2;
    background: #15283f;
    border-radius: 8px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .tab-button.active {
    background: #d6e9ff;
    color: #0d3668;
    border-color: #d6e9ff;
  }

  @media (max-width: 640px) {
    .content {
      padding: 0.8rem 0.8rem 5.2rem;
    }

    .panel {
      padding: 0.85rem;
    }
  }
</style>

<div class="app-shell">
  <main class="content">
    {#if activeTab === 'devices'}
      <section class="panel">
        <h2 class="heading">Device Connection</h2>
        <form on:submit|preventDefault={connect}>
          <label>
            Host
            <input type="text" bind:value={host} />
          </label>

          <label>
            Port
            <input type="number" bind:value={port} min="1" max="65535" />
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
            Remote Device ID (optional)
            <input type="text" bind:value={remoteId} placeholder="Expected remote device ID" />
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
          <button class="primary" on:click={connect} disabled={isConnecting}>
            {isConnecting ? 'Connecting...' : isConnected ? 'Reconnect' : 'Connect'}
          </button>
          <button on:click={refreshOverview} disabled={!isConnected || isConnecting || isRefreshing}>
            Refresh
          </button>
        </div>
      </section>

      <section class="panel">
        <h2 class="heading">Devices</h2>
        <div class="status-row">
          <span class={`status-chip ${isConnected ? 'online' : 'offline'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
          <span>Remote: {host}:{port}</span>
          <span>Device Name: {deviceName}</span>
          {#if remoteDevice}
            <span>Remote Name: {remoteDevice.deviceName}</span>
            <span>Remote Client: {remoteDevice.clientName} {remoteDevice.clientVersion}</span>
            <span>Remote ID: {remoteDevice.id}</span>
          {/if}
          {#if remoteId}
            <span>Expected ID: {remoteId}</span>
          {/if}
          {#if lastUpdatedAt}
            <span>Last update: {lastUpdatedAt}</span>
          {/if}
        </div>
      </section>
    {/if}

    {#if activeTab === 'folders'}
      <section class="panel">
        <h2 class="heading">Folders</h2>

        {#if !isConnected}
          <p class="empty">Connect from the Devices tab first.</p>
        {:else}
          <div class="status-row" style="margin-bottom: 0.75rem;">
            <span class="status-chip online">Connected</span>
            <span>{host}:{port}</span>
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
              {#each breadcrumbSegments() as segment, index (segment.key)}
                {#if index < breadcrumbSegments().length - 1}
                  <button class="crumb-button" on:click={() => goToBreadcrumb(segment)}>{segment.label}</button>
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
                    <button on:click={() => openFolderRoot(folder.id)}>{folder.name}</button>
                    <span class="meta">{folder.readOnly ? 'read-only' : 'read-write'}</span>
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
                    {#if entry.type === 'directory'}
                      <button on:click={() => handleEntryClick(entry)}>{entry.name}/</button>
                    {:else}
                      <span>{entry.name}</span>
                    {/if}
                    <span class="meta">
                      {entry.type} | {entry.size} bytes | {formatModified(entry.modifiedMs)}
                    </span>
                  </li>
                {/each}
              {/if}
            </ul>
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
    <button class={`tab-button ${activeTab === 'folders' ? 'active' : ''}`} on:click={() => switchTab('folders')}>
      Folders
    </button>
    <button class={`tab-button ${activeTab === 'devices' ? 'active' : ''}`} on:click={() => switchTab('devices')}>
      Devices
    </button>
  </nav>
</div>
