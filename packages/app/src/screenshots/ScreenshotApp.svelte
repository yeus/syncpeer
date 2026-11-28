<script lang="ts">
  import AppHeader from "../components/AppHeader.svelte";
  import DeviceTab from "../components/DeviceTab.svelte";
  import FoldersTab from "../components/FoldersTab.svelte";
  import { cachedFileKey } from "@syncpeer/core/browser";
  import { formatBytes, formatModified } from "../app/state.ts";
  import { createScreenshotState, type ScreenshotScreen } from "./fixture.ts";
  import Smartphone from "lucide-svelte/icons/smartphone";
  import FolderOpen from "lucide-svelte/icons/folder-open";
  import Star from "lucide-svelte/icons/star";

  const requested = new URLSearchParams(window.location.search).get("screen");
  const screen: ScreenshotScreen = requested === "devices" || requested === "folders" ||
    requested === "sync" ? requested : "devices";
  let app = $state(createScreenshotState(screen));
  const noop = () => {};
  const noopAsync = async () => {};
  const rootFolders = app.session.folders.map(folder => ({
    id: folder.id, name: folder.label, readOnly: folder.readOnly, stats: folder.stats,
  }));
  const breadcrumbs = screen === "sync"
    ? [{ key: "photos", label: "Family photos", targetFolderId: "photos", targetPath: "" }]
    : [];
  const favoriteKeys = new Set(["folder:photos:"]);
  const switchTab = (tab: "favorites" | "folders" | "devices") => { app.activeTab = tab; };
</script>

<svelte:head><title>Syncpeer mobile · {screen}</title></svelte:head>

<div class="app-viewport" data-testid="screenshot-ready" data-screen={screen}>
  <div class="app-shell">
    <AppHeader
      phase={app.session.lifecyclePhase}
      connected={app.session.isConnected}
      paused={false}
      expanded={false}
      updatedAt={screen === "devices" ? "" : app.session.lastUpdatedAt}
      transferSummary={screen === "sync" ? "Downloading weekend.mov · 68%" : ""}
      transferPercent={screen === "sync" ? 68 : 0}
      onToggleDetails={noop}
      onOpenSettings={noop}
    />
    <main class="content">
      {#if app.activeTab === "devices"}
        <DeviceTab {app} advertisedDevices={[]} advertisedFolders={[]}
          onOpenSettingsSection={noop}
          isSavedDeviceAwaitingRemoteApproval={() => false}
          isLanDiscoveredDevice={() => false}
          onUseSavedDevice={noop}
          onConnectDirectTcp={noopAsync}
          onCopyCurrentDeviceId={noop}
          onEditLocalDeviceName={noop}
          onDiscoverDevices={noopAsync}
          onAddSavedDevice={noop}
          onApproveAdvertisedDevice={noop}
          onApproveFolderSync={noop}
          onRevokeFolderSync={noop}
          onEditSavedDeviceName={noop}
          onSetSavedDeviceIntroducer={noop}
          onRemoveSavedDevice={noop}
          onPauseConnection={noop}
          onResumeConnection={noop}
        />
      {:else if app.activeTab === "folders"}
        {#if !app.session.currentFolderId}
          <button class="new-folder-action" type="button">New shared folder</button>
        {/if}
        <FoldersTab {app} {rootFolders} {breadcrumbs} {favoriteKeys}
          onGoToRootView={noop}
          onGoToBreadcrumb={noop}
          onOpenFolderRoot={noop}
          onOpenFolderSettings={noop}
          onOpenDirectory={noop}
          onSetDirectoryPage={noop}
          onSetDirectoryPageSize={noop}
          onSetDirectorySortMode={noop}
          onSetDirectoryNameFilter={noop}
          onSetDirectoryViewMode={mode => { app.ui.directoryViewMode = mode; }}
          onOpenCachedDirectory={noop}
          onOpenCachedFile={noop}
          onOpenCachedFileDirectory={noop}
          onOpenOrDownloadFile={noop}
          onOpenVersions={noop}
          onDownloadFile={noop}
          onCancelDownload={noop}
          onCancelTransfers={noop}
          onToggleFavorite={noop}
          isFolderLocked={() => false}
          folderLockLabel={() => ""}
          folderState={id => app.session.folders.find(folder => folder.id === id)}
          downloadButtonLabel={(folderId, path) =>
            app.favorites.activeDownloads[cachedFileKey(folderId, path)]?.text ?? "Download"}
          entries={app.session.entries}
          directoryPage={1}
          directoryTotalPages={1}
          directoryPageSize={app.ui.directoryPageSize}
          directoryViewMode={app.ui.directoryViewMode}
          directorySortMode={app.ui.directorySortMode}
          directoryNameFilter={app.ui.directoryNameFilter}
          {formatBytes} {formatModified}
          onHandleUploadClick={noop}
          onHandleUploadSelected={noop}
        />
      {/if}
    </main>
    <nav class="bottom-tabs" aria-label="Main navigation">
      <button class:active={app.activeTab === "favorites"} onclick={() => switchTab("favorites")}>
        <Star size={18} aria-hidden="true" />Favorites
      </button>
      <button class:active={app.activeTab === "folders"} onclick={() => switchTab("folders")}>
        <FolderOpen size={18} aria-hidden="true" />Folders
      </button>
      <button class:active={app.activeTab === "devices"} onclick={() => switchTab("devices")}>
        <Smartphone size={18} aria-hidden="true" />Devices
      </button>
    </nav>
  </div>
</div>

<style>
  .app-viewport { height: 100dvh; background: var(--bg-shell); }
  .app-shell { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
  .content { flex: 1; min-height: 0; overflow-y: auto; padding: 0.5rem; width: 100%; }
  .new-folder-action { margin: 0 0 0.5rem; color: var(--color-primary); }
  .bottom-tabs {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    flex-shrink: 0; padding: 0.45rem; gap: 0.35rem;
    background: var(--bg-nav); position: relative; z-index: 1;
  }
  .bottom-tabs button {
    border: 0; background: transparent; color: var(--text-muted);
    border-radius: var(--radius-sm); font-weight: 700;
    min-height: 44px; font-size: 0.68rem; padding: 0.35rem 0.2rem 0.55rem;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 0.2rem;
  }
  .bottom-tabs button.active {
    background: var(--color-secondary-soft); color: var(--text-strong);
  }
  .bottom-tabs button.active::after {
    content: ""; position: absolute; bottom: 0.2rem;
    width: 1.3rem; height: 2px; border-radius: 2px; background: var(--color-secondary);
  }
</style>
