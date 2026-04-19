<script lang="ts">
  import LayoutGrid from "lucide-svelte/icons/layout-grid";
  import List from "lucide-svelte/icons/list";
  import FolderOpen from "lucide-svelte/icons/folder-open";
  import type { FolderEntryItem, RootFolderItem } from "./FileSystemListItem.svelte";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import FileSystemListItem from "./FileSystemListItem.svelte";
  import Panel from "./Panel.svelte";
  import StatusChip from "./StatusChip.svelte";

  interface Props {
    app: any;
    breadcrumbs: any[];
    rootFolders: any[];
    favoriteKeys: Set<string>;
    onGoToRootView: () => void;
    onGoToBreadcrumb: (segment: any) => void;
    onOpenFolderRoot: (folderId: string) => void;
    onOpenDirectory: (path: string) => void;
    onSetDirectoryPage: (page: number) => void;
    onSetDirectoryPageSize: (size: number) => void;
    onSetDirectoryViewMode: (mode: "list" | "grid") => void;
    onOpenCachedDirectory: (folderId: string, path: string) => void;
    onOpenCachedFile: (folderId: string, path: string) => void;
    onOpenCachedFileDirectory: (folderId: string, path: string) => void;
    onOpenOrDownloadFile: (folderId: string, path: string, name: string) => void;
    onDownloadFile: (folderId: string, path: string, name: string) => void;
    onToggleFavorite: (folderId: string, path: string, name: string, kind: "folder" | "file") => void;
    onSetPasswordVisible: (folderId: string, visible: boolean) => void;
    onUpdateFolderPasswordDraft: (folderId: string, password: string) => void;
    onSaveFolderPassword: (folderId: string) => void;
    onClearFolderPassword: (folderId: string) => void;
    isFolderLocked: (folderId: string) => boolean;
    folderLockLabel: (folderId: string) => string;
    folderState: (folderId: string) => any;
    isPasswordInputVisible: (folderId: string) => boolean;
    activeFolderPasswords: Record<string, string>;
    downloadButtonLabel: (folderId: string, path: string) => string;
    entries: any[];
    directoryPage: number;
    directoryTotalPages: number;
    directoryPageSize: number;
    directoryViewMode: "list" | "grid";
    formatBytes: (value: number) => string;
    formatModified: (value: number) => string;
    onHandleUploadClick: () => void;
    onHandleUploadSelected: (event: Event) => void;
  }

  let {
    app,
    breadcrumbs,
    rootFolders,
    favoriteKeys,
    onGoToRootView,
    onGoToBreadcrumb,
    onOpenFolderRoot,
    onOpenDirectory,
    onSetDirectoryPage,
    onSetDirectoryPageSize,
    onSetDirectoryViewMode,
    onOpenCachedDirectory,
    onOpenCachedFile,
    onOpenCachedFileDirectory,
    onOpenOrDownloadFile,
    onDownloadFile,
    onToggleFavorite,
    onSetPasswordVisible,
    onUpdateFolderPasswordDraft,
    onSaveFolderPassword,
    onClearFolderPassword,
    isFolderLocked,
    folderLockLabel,
    folderState,
    isPasswordInputVisible,
    activeFolderPasswords,
    downloadButtonLabel,
    entries,
    directoryPage,
    directoryTotalPages,
    directoryPageSize,
    directoryViewMode,
    formatBytes,
    formatModified,
    onHandleUploadClick,
    onHandleUploadSelected,
  }: Props = $props();

  const hasCachedDirectory = (
    cachedFileKeys: Set<string>,
    folderId: string,
    path: string,
  ) => {
    const normalizedPath = path.trim();
    const exactKey = `${folderId}:${normalizedPath}`;
    if (cachedFileKeys.has(exactKey)) return true;
    if (!normalizedPath) {
      if (cachedFileKeys.has(`${folderId}:`)) return true;
      for (const key of cachedFileKeys) {
        if (key.startsWith(`${folderId}:`)) return true;
      }
      return false;
    }
    const prefix = `${folderId}:${normalizedPath}/`;
    for (const key of cachedFileKeys) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  };

  const cachedLocalPathByKey = (files: any[]) =>
    new Map(
      files
        .filter((file) => typeof file.localPath === "string" && file.localPath.trim() !== "")
        .map((file) => [`${file.folderId}:${file.path}`, file.localPath] as const),
    );
  let downloadedLocalPaths = $derived.by(() =>
    cachedLocalPathByKey(app.favorites.downloadedFiles),
  );

  let rootRows = $derived.by(() =>
    rootFolders.map(
      (folder: any): RootFolderItem => ({
        kind: "root-folder",
        folderId: folder.id,
        name: folder.name,
        readOnly: folder.readOnly,
        encrypted: Boolean(folderState(folder.id)?.encrypted),
        lockLabel: folderLockLabel(folder.id),
        passwordError: folderState(folder.id)?.passwordError ?? "",
        passwordInputVisible: isPasswordInputVisible(folder.id),
        passwordDraft: app.passwords.drafts[folder.id] ?? "",
        passwordSaved: activeFolderPasswords[folder.id] ?? "",
        locked: isFolderLocked(folder.id),
        isFavorite: favoriteKeys.has(`folder:${folder.id}:`),
        hasCachedRoot: app.favorites.cachedFileKeys.has(`${folder.id}:`),
      }),
    ),
  );

  let entryRows = $derived.by(() =>
    entries.map(
      (entry: any): FolderEntryItem => ({
        kind: "folder-entry",
        folderId: app.session.currentFolderId,
        name: entry.name,
        path: entry.path,
        entryType: entry.type,
        sizeText: formatBytes(entry.size),
        modifiedText: formatModified(entry.modifiedMs),
        invalid: Boolean(entry.invalid),
        isFavorite: favoriteKeys.has(
          `${entry.type === "directory" ? "folder" : "file"}:${app.session.currentFolderId}:${entry.path}`,
        ),
        isCached: app.favorites.cachedFileKeys.has(`${app.session.currentFolderId}:${entry.path}`),
        thumbnailPath: downloadedLocalPaths.get(`${app.session.currentFolderId}:${entry.path}`) ?? null,
        downloadLabel: downloadButtonLabel(app.session.currentFolderId, entry.path),
        isDownloadingActive:
          app.favorites.activeDownloadKey ===
          `${app.session.currentFolderId}:${entry.path}`,
        downloadProgressText:
          app.favorites.activeDownloadKey ===
          `${app.session.currentFolderId}:${entry.path}`
            ? app.favorites.activeDownloadText
            : "",
      }),
    ),
  );

  const openDirectoryFromItem = (folderId: string, path: string) => {
    if (folderId !== app.session.currentFolderId) return;
    onOpenDirectory(path);
  };

  let canOpenCurrentDirectoryLocally = $derived.by(() => {
    if (!app.session.currentFolderId) return false;
    return hasCachedDirectory(
      app.favorites.cachedFileKeys,
      app.session.currentFolderId,
      app.session.currentPath,
    );
  });
</script>

<Panel title="Folders">
  {#if !app.session.isConnected}
    <p class="empty">Connect to browse folders.</p>
  {:else}
    <div class="status-row">
      <StatusChip tone="online">Connected</StatusChip>
      {#if app.session.remoteDevice}
        <span>{app.session.remoteDevice.deviceName}</span>
      {/if}
      {#if app.session.lastUpdatedAt}
        <span>Updated {app.session.lastUpdatedAt}</span>
      {/if}
    </div>

    <Breadcrumbs
      currentFolderId={app.session.currentFolderId}
      segments={breadcrumbs}
      onRoot={onGoToRootView}
      onSelect={onGoToBreadcrumb}
    />

    {#if app.session.currentFolderId}
      <div class="actions">
        <input id="folder-upload-input" class="upload-input" type="file" onchange={onHandleUploadSelected} />
        <button class="primary" onclick={onHandleUploadClick}>
          Upload
        </button>
        <button
          class="ghost"
          onclick={() => onOpenCachedDirectory(app.session.currentFolderId, app.session.currentPath)}
          disabled={!canOpenCurrentDirectoryLocally || app.favorites.isOpeningCachedFile}
          title="Open current directory from local cache"
        >
          <FolderOpen size={16} />
          Open Local
        </button>
        <div class="view-toggle" role="group" aria-label="Directory view mode">
          <button
            class={`ghost compact-toggle ${directoryViewMode === "list" ? "active" : ""}`}
            onclick={() => onSetDirectoryViewMode("list")}
            aria-pressed={directoryViewMode === "list"}
            title="List view"
          >
            <List size={15} />
            List
          </button>
          <button
            class={`ghost compact-toggle ${directoryViewMode === "grid" ? "active" : ""}`}
            onclick={() => onSetDirectoryViewMode("grid")}
            aria-pressed={directoryViewMode === "grid"}
            title="Grid view"
          >
            <LayoutGrid size={15} />
            Grid
          </button>
        </div>
      </div>
      {#if app.ui.uploadProgressActive}
        <div class="upload-progress-wrap">
          <progress max="100" value={app.ui.uploadProgressPercent}></progress>
          <span class="item-meta">
            {app.ui.uploadProgressPercent}%{app.ui.uploadProgressRate ? ` · ${app.ui.uploadProgressRate}` : ""}
            {app.ui.uploadProgressEta ? ` · ETA ${app.ui.uploadProgressEta}` : ""}
          </span>
        </div>
      {/if}
      {#if app.ui.uploadMessage}
        <div class="hint">{app.ui.uploadMessage}</div>
      {/if}
    {/if}

    {#if !app.session.currentFolderId}
      <ul class="list">
        {#if rootRows.length === 0}
          <li class="empty">No folders shared by the remote device.</li>
        {:else}
          {#each rootRows as item (item.folderId)}
            <FileSystemListItem
              {item}
              isOpeningCachedFile={app.favorites.isOpeningCachedFile}
              isRemovingCachedFile={app.favorites.isRemovingCachedFile}
              isClearingCache={app.favorites.isClearingCache}
              isDownloading={app.favorites.isDownloading}
              {onOpenFolderRoot}
              onOpenCachedDirectory={onOpenCachedDirectory}
              onToggleFavorite={onToggleFavorite}
              onSetPasswordVisible={onSetPasswordVisible}
              onUpdateFolderPasswordDraft={onUpdateFolderPasswordDraft}
              onSaveFolderPassword={onSaveFolderPassword}
              onClearFolderPassword={onClearFolderPassword}
            />
          {/each}
        {/if}
      </ul>
    {:else}
      <ul class={`list ${directoryViewMode === "grid" ? "list-grid" : ""}`}>
        {#if isFolderLocked(app.session.currentFolderId)}
          <li class="empty">
            This receive-encrypted folder is locked. Use the unlock button in the folder list to browse or download files.
          </li>
        {:else if app.session.isLoadingDirectory}
          <li class="empty">Loading folder contents...</li>
        {:else if entryRows.length === 0}
          <li class="empty">Folder is empty.</li>
        {:else}
          {#each entryRows as item (item.path)}
            <FileSystemListItem
              {item}
              isOpeningCachedFile={app.favorites.isOpeningCachedFile}
              isRemovingCachedFile={app.favorites.isRemovingCachedFile}
              isClearingCache={app.favorites.isClearingCache}
              isDownloading={app.favorites.isDownloading}
              onOpenDirectory={openDirectoryFromItem}
              onOpenCachedDirectory={onOpenCachedDirectory}
              onOpenCachedFile={onOpenCachedFile}
              onOpenCachedFileDirectory={onOpenCachedFileDirectory}
              onOpenOrDownloadFile={onOpenOrDownloadFile}
              onDownloadFile={onDownloadFile}
              onToggleFavorite={onToggleFavorite}
              viewMode={directoryViewMode}
            />
          {/each}
        {/if}
      </ul>

      {#if app.session.entries.length > 0}
        <div class="actions">
          <label>
            Files per page
            <input
              type="number"
              min="10"
              max="2000"
              value={directoryPageSize}
              oninput={(event) => {
                const next =
                  event.currentTarget instanceof HTMLInputElement
                    ? Number(event.currentTarget.value)
                    : Number.NaN;
                onSetDirectoryPageSize(next);
              }}
            />
          </label>
          <button
            class="ghost"
            onclick={() => onSetDirectoryPage(directoryPage - 1)}
            disabled={directoryPage <= 1}
          >
            Previous
          </button>
          <span class="item-meta">Page {directoryPage} of {directoryTotalPages}</span>
          <button
            class="ghost"
            onclick={() => onSetDirectoryPage(directoryPage + 1)}
            disabled={directoryPage >= directoryTotalPages}
          >
            Next
          </button>
        </div>
      {/if}

    {/if}
  {/if}
</Panel>

<style>
  .status-row {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin-bottom: 0.45rem;
  }

  .actions {
    display: flex;
    gap: 0.45rem;
    margin-top: 0.45rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .view-toggle {
    display: inline-flex;
    gap: 0.35rem;
    margin-left: auto;
  }

  .compact-toggle {
    min-height: 2rem;
    padding: 0.35rem 0.6rem;
    gap: 0.3rem;
  }

  .compact-toggle.active {
    background: var(--color-primary-soft);
    border-color: var(--border-accent);
    color: var(--color-primary-strong);
  }

  .list-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
    gap: 0.45rem;
    border: none;
    background: transparent;
    overflow: visible;
  }

  .list-grid :global(.list-item) {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    padding: 0.5rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .upload-input {
    display: none;
  }

  .upload-progress-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.35rem;
    max-width: 22rem;
  }

  .upload-progress-wrap progress {
    width: 100%;
  }
</style>
