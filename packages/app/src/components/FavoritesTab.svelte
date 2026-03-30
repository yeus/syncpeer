<script lang="ts">
  import Star from "lucide-svelte/icons/star";
  import Panel from "./Panel.svelte";
  import ListRow from "./ListRow.svelte";

  interface Props {
    app: any;
    onOpenDownloadedFilesPanel: () => void;
    onOpenFavorite: (favorite: any) => void;
    onOpenCachedFile: (folderId: string, path: string) => void;
    onOpenCachedFileDirectory: (folderId: string, path: string) => void;
    onRemoveCachedFile: (folderId: string, path: string) => void;
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
    onRemoveCachedFile,
    onDownloadFile,
    onRemoveFavorite,
    onClearAllCache,
    formatBytes,
    formatModified,
  }: Props = $props();
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
    {#if app.favorites.items.length === 0}
      <li class="empty">No favorites yet. Tap a star on folders/files to add them.</li>
    {:else}
      {#each app.favorites.items as favorite (favorite.key)}
        <ListRow>
          <button
            class="item-title"
            onclick={() => onOpenFavorite(favorite)}
            disabled={!app.session.isConnected}
          >
            {favorite.name}
          </button>
          <div class="item-meta">{favorite.folderId}:{favorite.path || "/"}</div>
          <svelte:fragment slot="actions">
            {#if favorite.kind === "file"}
              {#if app.favorites.cachedFileKeys.has(`${favorite.folderId}:${favorite.path}`)}
                <button
                  class="ghost"
                  onclick={() => onOpenCachedFile(favorite.folderId, favorite.path)}
                  disabled={app.favorites.isOpeningCachedFile}
                >
                  Open
                </button>
                <button
                  class="ghost"
                  onclick={() => onOpenCachedFileDirectory(favorite.folderId, favorite.path)}
                  disabled={app.favorites.isOpeningCachedFile}
                >
                  Open Folder
                </button>
                <button
                  class="ghost"
                  onclick={() => onRemoveCachedFile(favorite.folderId, favorite.path)}
                  disabled={app.favorites.isRemovingCachedFile || app.favorites.isClearingCache}
                >
                  Drop
                </button>
              {:else}
                <button
                  class="ghost"
                  onclick={() => onDownloadFile(favorite.folderId, favorite.path, favorite.name)}
                  disabled={app.favorites.isDownloading}
                >
                  Download
                </button>
              {/if}
            {/if}
            <button class="icon icon-only" onclick={() => onRemoveFavorite(favorite)} aria-label="Remove favorite">
              <Star size={16} />
            </button>
          </svelte:fragment>
        </ListRow>
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
      {#if app.favorites.downloadedFiles.length === 0}
        <li class="empty">No downloaded files in local cache yet.</li>
      {:else}
        {#each app.favorites.downloadedFiles as file (file.key)}
          <ListRow>
            <div class="item-title">{file.name}</div>
            <div class="item-meta">{file.folderId}:{file.path}</div>
            <div class="item-meta">
              {formatBytes(file.sizeBytes)} | Cached {formatModified(file.cachedAtMs)}
            </div>
            <svelte:fragment slot="actions">
              <button
                class="ghost"
                onclick={() => onOpenCachedFile(file.folderId, file.path)}
                disabled={app.favorites.isOpeningCachedFile}
              >
                Open
              </button>
              <button
                class="ghost"
                onclick={() => onOpenCachedFileDirectory(file.folderId, file.path)}
                disabled={app.favorites.isOpeningCachedFile}
              >
                Open Folder
              </button>
              <button
                class="ghost"
                onclick={() => onRemoveCachedFile(file.folderId, file.path)}
                disabled={app.favorites.isRemovingCachedFile || app.favorites.isClearingCache}
              >
                Drop
              </button>
            </svelte:fragment>
          </ListRow>
        {/each}
      {/if}
    </ul>
  {/if}
</Panel>
