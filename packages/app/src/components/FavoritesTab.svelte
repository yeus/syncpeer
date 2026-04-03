<script lang="ts">
  import type { CachedFileItem, FavoriteItem } from "./FileSystemListItem.svelte";
  import FileSystemListItem from "./FileSystemListItem.svelte";
  import Panel from "./Panel.svelte";

  interface Props {
    app: any;
    onOpenDownloadedFilesPanel: () => void;
    onOpenFavorite: (favorite: any) => void;
    onOpenCachedFile: (folderId: string, path: string) => void;
    onOpenCachedFileDirectory: (folderId: string, path: string) => void;
    onOpenCachedDirectory: (folderId: string, path: string) => void;
    onRemoveCachedFile: (folderId: string, path: string) => void;
    onOpenOrDownloadFile: (folderId: string, path: string, name: string) => void;
    onDownloadFile: (folderId: string, path: string, name: string) => void;
    onRemoveFavorite: (favorite: any) => void;
    onClearAllCache: () => void;
    formatBytes: (value: number) => string;
    formatModified: (value: number) => string;
  }

  let {
    app,
    onOpenDownloadedFilesPanel,
    onOpenFavorite,
    onOpenCachedFile,
    onOpenCachedFileDirectory,
    onOpenCachedDirectory,
    onRemoveCachedFile,
    onOpenOrDownloadFile,
    onDownloadFile,
    onRemoveFavorite,
    onClearAllCache,
    formatBytes,
    formatModified,
  }: Props = $props();

  const downloadLabel = (folderId: string, path: string) => {
    const key = `${folderId}:${path}`;
    return key === app.favorites.activeDownloadKey
      ? app.favorites.activeDownloadText || "Downloading..."
      : "Download";
  };

  let favoriteRows = $derived.by(() =>
    app.favorites.items.map(
      (favorite: any): FavoriteItem => ({
        kind: "favorite",
        key: favorite.key,
        folderId: favorite.folderId,
        name: favorite.name,
        path: favorite.path,
        favoriteKind: favorite.kind,
        connected: app.session.isConnected,
        isCached: app.favorites.cachedFileKeys.has(`${favorite.folderId}:${favorite.path}`),
        downloadLabel: downloadLabel(favorite.folderId, favorite.path),
        isDownloadingActive:
          app.favorites.activeDownloadKey === `${favorite.folderId}:${favorite.path}`,
        downloadProgressText:
          app.favorites.activeDownloadKey === `${favorite.folderId}:${favorite.path}`
            ? app.favorites.activeDownloadText
            : "",
      }),
    ),
  );

  let downloadedRows = $derived.by(() =>
    app.favorites.downloadedFiles.map(
      (file: any): CachedFileItem => ({
        kind: "cached-file",
        key: file.key,
        folderId: file.folderId,
        name: file.name,
        path: file.path,
        sizeText: formatBytes(file.sizeBytes),
        cachedAtText: formatModified(file.cachedAtMs),
      }),
    ),
  );
</script>

<Panel title="Favorites">
  <div class="actions">
    <button
      class="ghost"
      onclick={onOpenDownloadedFilesPanel}
      disabled={app.favorites.isLoadingDownloadedFiles}
    >
      {app.favorites.isLoadingDownloadedFiles ? "Loading Downloads..." : "Show Downloaded Files"}
    </button>
  </div>
  {#if !app.session.isConnected}
    <p class="empty">Connect to open favorites and sync folder state.</p>
  {/if}

  <ul class="list">
    {#if favoriteRows.length === 0}
      <li class="empty">No favorites yet. Tap a star on folders/files to add them.</li>
    {:else}
      {#each favoriteRows as item (item.key)}
        <FileSystemListItem
          {item}
          isOpeningCachedFile={app.favorites.isOpeningCachedFile}
          isRemovingCachedFile={app.favorites.isRemovingCachedFile}
          isClearingCache={app.favorites.isClearingCache}
          isDownloading={app.favorites.isDownloading}
          onOpenFavorite={onOpenFavorite}
          onOpenCachedFile={onOpenCachedFile}
          onOpenCachedFileDirectory={onOpenCachedFileDirectory}
          onOpenCachedDirectory={onOpenCachedDirectory}
          onRemoveCachedFile={onRemoveCachedFile}
          onOpenOrDownloadFile={onOpenOrDownloadFile}
          onDownloadFile={onDownloadFile}
          onRemoveFavorite={onRemoveFavorite}
        />
      {/each}
    {/if}
  </ul>

  {#if app.favorites.showDownloadedFiles}
    <div class="heading-row">
      <h3 class="heading">Downloaded Files</h3>
      <button
        class="ghost"
        onclick={onClearAllCache}
        disabled={app.favorites.isClearingCache || app.favorites.isRemovingCachedFile}
      >
        {app.favorites.isClearingCache ? "Clearing..." : "Clear All"}
      </button>
    </div>
    <ul class="list">
      {#if downloadedRows.length === 0}
        <li class="empty">No downloaded files in local cache yet.</li>
      {:else}
        {#each downloadedRows as item (item.key)}
          <FileSystemListItem
            {item}
            isOpeningCachedFile={app.favorites.isOpeningCachedFile}
            isRemovingCachedFile={app.favorites.isRemovingCachedFile}
            isClearingCache={app.favorites.isClearingCache}
            isDownloading={app.favorites.isDownloading}
            onOpenCachedFile={onOpenCachedFile}
            onOpenCachedFileDirectory={onOpenCachedFileDirectory}
            onRemoveCachedFile={onRemoveCachedFile}
          />
        {/each}
      {/if}
    </ul>
  {/if}
</Panel>

<style>
  .actions {
    display: flex;
    gap: 0.45rem;
    margin-bottom: 0.45rem;
    flex-wrap: wrap;
  }

  .heading-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 0.6rem 0 0.45rem;
    flex-wrap: wrap;
  }
</style>
