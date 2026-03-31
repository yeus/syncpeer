<script lang="ts">
  import Download from "lucide-svelte/icons/download";
  import ExternalLink from "lucide-svelte/icons/external-link";
  import FolderOpen from "lucide-svelte/icons/folder-open";
  import KeyRound from "lucide-svelte/icons/key-round";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import Star from "lucide-svelte/icons/star";
  import StarOff from "lucide-svelte/icons/star-off";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Unlock from "lucide-svelte/icons/unlock";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import FileSystemListItem from "./FileSystemListItem.svelte";
  import Panel from "./Panel.svelte";
  import StatusChip from "./StatusChip.svelte";

  interface Props {
    app: any;
    breadcrumbs: any[];
    rootFolders: any[];
    favoriteKeys: Set<string>;
    onRefreshActiveView: () => void;
    onGoToRootView: () => void;
    onGoToBreadcrumb: (segment: any) => void;
    onOpenFolderRoot: (folderId: string) => void;
    onOpenDirectory: (path: string) => void;
    onSetDirectoryPage: (page: number) => void;
    onSetDirectoryPageSize: (size: number) => void;
    onOpenCachedDirectory: (folderId: string, path: string) => void;
    onOpenCachedFile: (folderId: string, path: string) => void;
    onOpenCachedFileDirectory: (folderId: string, path: string) => void;
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
    formatBytes: (value: number) => string;
    formatModified: (value: number) => string;
    onHandleUploadSelected: (event: Event) => void;
  }

  let {
    app,
    breadcrumbs,
    rootFolders,
    favoriteKeys,
    onRefreshActiveView,
    onGoToRootView,
    onGoToBreadcrumb,
    onOpenFolderRoot,
    onOpenDirectory,
    onSetDirectoryPage,
    onSetDirectoryPageSize,
    onOpenCachedDirectory,
    onOpenCachedFile,
    onOpenCachedFileDirectory,
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
    formatBytes,
    formatModified,
    onHandleUploadSelected,
  }: Props = $props();
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
      <button
        class="ghost icon-only"
        onclick={onRefreshActiveView}
        disabled={app.session.isRefreshing || app.session.isConnecting || app.session.isLoadingDirectory}
        aria-label={app.session.isRefreshing ? "Refreshing..." : "Refresh"}
      >
        <RefreshCw size={16} />
      </button>
    </div>

    <Breadcrumbs
      currentFolderId={app.session.currentFolderId}
      segments={breadcrumbs}
      onRoot={onGoToRootView}
      onSelect={onGoToBreadcrumb}
    />

    {#if !app.session.currentFolderId}
      <ul class="list">
        {#if rootFolders.length === 0}
          <li class="empty">No folders shared by the remote device.</li>
        {:else}
          {#each rootFolders as folder (folder.id)}
            <FileSystemListItem
              title={folder.name}
              onTitleClick={() => onOpenFolderRoot(folder.id)}
              titleDisabled={isFolderLocked(folder.id)}
              metaLines={[folder.readOnly ? "read-only" : "read-write"]}
            >
              {#if folderState(folder.id)?.encrypted}
                <div class="item-meta">receive-encrypted | {folderLockLabel(folder.id)}</div>
                {#if folderState(folder.id)?.passwordError}
                  <div class="item-meta">{folderState(folder.id)?.passwordError}</div>
                {/if}
                {#if isPasswordInputVisible(folder.id)}
                  <label class="inline-input">
                    <span>Folder Password</span>
                    <input
                      type="password"
                      value={app.passwords.drafts[folder.id] ?? activeFolderPasswords[folder.id] ?? ""}
                      oninput={(event) =>
                        onUpdateFolderPasswordDraft(
                          folder.id,
                          event.currentTarget instanceof HTMLInputElement
                            ? event.currentTarget.value
                            : "",
                        )}
                      placeholder="Syncthing folder encryption password"
                    />
                  </label>
                {/if}
              {/if}
              {#snippet actions()}
                {#if folderState(folder.id)?.encrypted}
                  <StatusChip tone={isFolderLocked(folder.id) ? "offline" : "online"} small>
                    {folderLockLabel(folder.id)}
                  </StatusChip>
                  {#if !isPasswordInputVisible(folder.id)}
                    <button
                      class="ghost icon-only"
                      onclick={() => onSetPasswordVisible(folder.id, true)}
                      aria-label="Edit folder password"
                    >
                      <KeyRound size={16} />
                    </button>
                  {/if}
                  <button class="ghost icon-only" onclick={() => onSaveFolderPassword(folder.id)} aria-label="Unlock folder">
                    <Unlock size={16} />
                  </button>
                  <button
                    class="ghost icon-only"
                    onclick={() => onClearFolderPassword(folder.id)}
                    disabled={!activeFolderPasswords[folder.id]}
                    aria-label="Forget saved folder password"
                  >
                    <Trash2 size={16} />
                  </button>
                {/if}
                {#if app.favorites.cachedFileKeys.has(`${folder.id}:`)}
                  <button
                    class="ghost icon-only"
                    onclick={() => onOpenCachedDirectory(folder.id, "")}
                    disabled={app.favorites.isOpeningCachedFile}
                    aria-label="Open local cached folder"
                  >
                    <ExternalLink size={16} />
                  </button>
                {/if}
                <button
                  class="icon icon-only"
                  onclick={() => onToggleFavorite(folder.id, "", folder.name, "folder")}
                  aria-label="Toggle favorite"
                >
                  {#if favoriteKeys.has(`folder:${folder.id}:`)}
                    <Star size={16} />
                  {:else}
                    <StarOff size={16} />
                  {/if}
                </button>
              {/snippet}
            </FileSystemListItem>
          {/each}
        {/if}
      </ul>
    {:else}
      <ul class="list">
        {#if isFolderLocked(app.session.currentFolderId)}
          <li class="empty">
            This receive-encrypted folder is locked. Use the unlock button in the folder list to browse or download files.
          </li>
        {:else if app.session.isLoadingDirectory}
          <li class="empty">Loading folder contents...</li>
        {:else if app.session.entries.length === 0}
          <li class="empty">Folder is empty.</li>
        {:else}
          {#each entries as entry (entry.path)}
            <FileSystemListItem
              title={entry.type === "directory" ? `${entry.name}/` : entry.name}
              onTitleClick={entry.type === "directory" ? () => onOpenDirectory(entry.path) : undefined}
              metaLines={[`${entry.type} | ${formatBytes(entry.size)} | ${formatModified(entry.modifiedMs)}`]}
            >
              {#if entry.invalid}
                <div class="item-meta">Unavailable on remote (invalid)</div>
              {/if}
              {#snippet actions()}
                {#if entry.type === "directory"}
                  {#if app.favorites.cachedFileKeys.has(`${app.session.currentFolderId}:${entry.path}`)}
                    <button
                      class="ghost icon-only"
                      onclick={() => onOpenCachedDirectory(app.session.currentFolderId, entry.path)}
                      disabled={app.favorites.isOpeningCachedFile}
                      aria-label="Open local cached directory"
                    >
                      <ExternalLink size={16} />
                    </button>
                  {/if}
                {:else if app.favorites.cachedFileKeys.has(`${app.session.currentFolderId}:${entry.path}`)}
                  <button
                    class="ghost icon-only"
                    onclick={() => onOpenCachedFile(app.session.currentFolderId, entry.path)}
                    disabled={app.favorites.isOpeningCachedFile}
                    aria-label="Open cached file"
                  >
                    <ExternalLink size={16} />
                  </button>
                  <button
                    class="ghost icon-only"
                    onclick={() => onOpenCachedFileDirectory(app.session.currentFolderId, entry.path)}
                    disabled={app.favorites.isOpeningCachedFile}
                    aria-label="Open cached file directory"
                  >
                    <FolderOpen size={16} />
                  </button>
                {:else}
                  <button
                    class="ghost icon-only"
                    onclick={() => onDownloadFile(app.session.currentFolderId, entry.path, entry.name)}
                    disabled={app.favorites.isDownloading || entry.invalid}
                    title={downloadButtonLabel(app.session.currentFolderId, entry.path)}
                    aria-label={downloadButtonLabel(app.session.currentFolderId, entry.path)}
                  >
                    <Download size={16} />
                  </button>
                {/if}
                <button
                  class="icon icon-only"
                  onclick={() =>
                    onToggleFavorite(
                      app.session.currentFolderId,
                      entry.path,
                      entry.name,
                      entry.type === "directory" ? "folder" : "file",
                    )}
                  aria-label="Toggle favorite"
                >
                  {#if favoriteKeys.has(
                    `${entry.type === "directory" ? "folder" : "file"}:${app.session.currentFolderId}:${entry.path}`,
                  )}
                    <Star size={16} />
                  {:else}
                    <StarOff size={16} />
                  {/if}
                </button>
              {/snippet}
            </FileSystemListItem>
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

      <div class="actions">
        <input id="folder-upload-input" type="file" style="display: none;" onchange={onHandleUploadSelected} />
        <button class="primary" onclick={() => document.getElementById("folder-upload-input")?.click()}>
          Upload
        </button>
      </div>
      {#if app.ui.uploadMessage}
        <div class="hint">{app.ui.uploadMessage}</div>
      {/if}
    {/if}
  {/if}
</Panel>
