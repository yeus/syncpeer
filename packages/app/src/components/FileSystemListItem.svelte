<script lang="ts">
  import Download from "lucide-svelte/icons/download";
  import ExternalLink from "lucide-svelte/icons/external-link";
  import File from "lucide-svelte/icons/file";
  import FileArchive from "lucide-svelte/icons/file-archive";
  import FileAudio from "lucide-svelte/icons/file-audio";
  import FileImage from "lucide-svelte/icons/file-image";
  import FileText from "lucide-svelte/icons/file-text";
  import FileVideo from "lucide-svelte/icons/file-video";
  import FolderOpen from "lucide-svelte/icons/folder-open";
  import Folder from "lucide-svelte/icons/folder";
  import KeyRound from "lucide-svelte/icons/key-round";
  import Star from "lucide-svelte/icons/star";
  import StarOff from "lucide-svelte/icons/star-off";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import Unlock from "lucide-svelte/icons/unlock";
  import ListRow from "./ListRow.svelte";
  import StatusChip from "./StatusChip.svelte";

  export interface RootFolderItem {
    kind: "root-folder";
    folderId: string;
    name: string;
    readOnly: boolean;
    encrypted: boolean;
    lockLabel: string;
    passwordError: string;
    passwordInputVisible: boolean;
    passwordDraft: string;
    passwordSaved: string;
    locked: boolean;
    isFavorite: boolean;
    hasCachedRoot: boolean;
  }

export interface FolderEntryItem {
    kind: "folder-entry";
    folderId: string;
    name: string;
    path: string;
    entryType: "directory" | "file" | "symlink";
    sizeText: string;
    modifiedText: string;
    invalid: boolean;
  isFavorite: boolean;
  isCached: boolean;
  downloadLabel: string;
  isDownloadingActive: boolean;
  downloadProgressText: string;
}

export interface FavoriteItem {
    kind: "favorite";
    key: string;
    folderId: string;
    name: string;
    path: string;
    favoriteKind: "folder" | "file";
  connected: boolean;
  isCached: boolean;
  downloadLabel: string;
  isDownloadingActive: boolean;
  downloadProgressText: string;
}

  export interface CachedFileItem {
    kind: "cached-file";
    key: string;
    folderId: string;
    name: string;
    path: string;
    sizeText: string;
    cachedAtText: string;
  }

  export type FileSystemItem =
    | RootFolderItem
    | FolderEntryItem
    | FavoriteItem
    | CachedFileItem;

  interface Props {
    item: FileSystemItem;
    isOpeningCachedFile: boolean;
    isRemovingCachedFile: boolean;
    isClearingCache: boolean;
    isDownloading: boolean;
    onOpenFolderRoot?: (folderId: string) => void;
    onOpenDirectory?: (folderId: string, path: string) => void;
    onOpenFavorite?: (favorite: { folderId: string; path: string; kind: "folder" | "file" }) => void;
    onToggleFavorite?: (folderId: string, path: string, name: string, kind: "folder" | "file") => void;
    onRemoveFavorite?: (favorite: { key: string; folderId: string; path: string; name: string; kind: "folder" | "file" }) => void;
    onOpenCachedDirectory?: (folderId: string, path: string) => void;
    onOpenCachedFile?: (folderId: string, path: string) => void;
    onOpenCachedFileDirectory?: (folderId: string, path: string) => void;
    onRemoveCachedFile?: (folderId: string, path: string) => void;
    onDownloadFile?: (folderId: string, path: string, name: string) => void;
    onSetPasswordVisible?: (folderId: string, visible: boolean) => void;
    onUpdateFolderPasswordDraft?: (folderId: string, password: string) => void;
    onSaveFolderPassword?: (folderId: string) => void;
    onClearFolderPassword?: (folderId: string) => void;
  }

  let {
    item,
    isOpeningCachedFile,
    isRemovingCachedFile,
    isClearingCache,
    isDownloading,
    onOpenFolderRoot = () => {},
    onOpenDirectory = () => {},
    onOpenFavorite = () => {},
    onToggleFavorite = () => {},
    onRemoveFavorite = () => {},
    onOpenCachedDirectory = () => {},
    onOpenCachedFile = () => {},
    onOpenCachedFileDirectory = () => {},
    onRemoveCachedFile = () => {},
    onDownloadFile = () => {},
    onSetPasswordVisible = () => {},
    onUpdateFolderPasswordDraft = () => {},
    onSaveFolderPassword = () => {},
    onClearFolderPassword = () => {},
  }: Props = $props();

  const rowTitle = (value: FileSystemItem) => {
    if (value.kind === "folder-entry" && value.entryType === "directory") {
      return `${value.name}/`;
    }
    return value.name;
  };

  const canClickTitle = (value: FileSystemItem) => {
    if (value.kind === "root-folder") return !value.locked;
    if (value.kind === "folder-entry") return value.entryType === "directory";
    return value.kind === "favorite";
  };

  const handleTitleClick = (value: FileSystemItem) => {
    if (value.kind === "root-folder") {
      onOpenFolderRoot(value.folderId);
      return;
    }
    if (value.kind === "folder-entry") {
      if (value.entryType === "directory") onOpenDirectory(value.folderId, value.path);
      return;
    }
    if (value.kind === "favorite") {
      onOpenFavorite({
        folderId: value.folderId,
        path: value.path,
        kind: value.favoriteKind,
      });
    }
  };

  const extensionOf = (name: string, path: string) => {
    const source = (path || name || "").split("/").pop() || "";
    const parts = source.toLowerCase().split(".");
    if (parts.length <= 1) return "";
    return parts.pop() || "";
  };

  const fileIconKind = (name: string, path: string) => {
    const ext = extensionOf(name, path);
    if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "heic"].includes(ext)) {
      return "image";
    }
    if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].includes(ext)) {
      return "audio";
    }
    if (["mp4", "mkv", "mov", "avi", "webm", "m4v"].includes(ext)) {
      return "video";
    }
    if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(ext)) {
      return "archive";
    }
    if (["txt", "md", "pdf", "rtf", "doc", "docx"].includes(ext)) {
      return "text";
    }
    return "generic";
  };

  const leadingKind = (value: FileSystemItem) => {
    if (value.kind === "root-folder") return "folder";
    if (value.kind === "folder-entry") {
      if (value.entryType === "directory") return "folder";
      return fileIconKind(value.name, value.path);
    }
    if (value.kind === "favorite") {
      if (value.favoriteKind === "folder") return "folder";
      return fileIconKind(value.name, value.path);
    }
    return fileIconKind(value.name, value.path);
  };
</script>

<ListRow>
  <div class="item-title-row">
    <span class="item-icon" aria-hidden="true">
      {#if leadingKind(item) === "folder"}
        <Folder size={16} />
      {:else if leadingKind(item) === "image"}
        <FileImage size={16} />
      {:else if leadingKind(item) === "audio"}
        <FileAudio size={16} />
      {:else if leadingKind(item) === "video"}
        <FileVideo size={16} />
      {:else if leadingKind(item) === "archive"}
        <FileArchive size={16} />
      {:else if leadingKind(item) === "text"}
        <FileText size={16} />
      {:else}
        <File size={16} />
      {/if}
    </span>
    {#if canClickTitle(item)}
      <button class="item-title" onclick={() => handleTitleClick(item)} disabled={item.kind === "root-folder" && item.locked}>
        {rowTitle(item)}
      </button>
    {:else}
      <div class="item-title">{rowTitle(item)}</div>
    {/if}

    {#if item.kind === "root-folder" && item.encrypted}
      <StatusChip tone={item.locked ? "offline" : "online"} small>{item.lockLabel}</StatusChip>
    {/if}
  </div>

  {#if item.kind === "root-folder"}
    <div class="item-meta">{item.readOnly ? "read-only" : "read-write"}</div>
    {#if item.encrypted}
      <div class="item-meta">receive-encrypted | {item.lockLabel}</div>
      {#if item.passwordError}
        <div class="item-meta">{item.passwordError}</div>
      {/if}
      {#if item.passwordInputVisible}
        <label class="inline-input">
          <span>Folder Password</span>
          <input
            type="password"
            value={item.passwordDraft || item.passwordSaved}
            oninput={(event) =>
              onUpdateFolderPasswordDraft(
                item.folderId,
                event.currentTarget instanceof HTMLInputElement
                  ? event.currentTarget.value
                  : "",
              )}
            placeholder="Syncthing folder encryption password"
          />
        </label>
      {/if}
    {/if}
  {:else if item.kind === "folder-entry"}
    <div class="item-meta">{item.entryType} | {item.sizeText} | {item.modifiedText}</div>
    {#if item.isDownloadingActive && item.downloadProgressText}
      <div class="item-meta">Download: {item.downloadProgressText}</div>
    {/if}
    {#if item.invalid}
      <div class="item-meta">Unavailable on remote (invalid)</div>
    {/if}
  {:else if item.kind === "favorite"}
    <div class="item-meta">{item.folderId}:{item.path || "/"}</div>
    {#if item.isDownloadingActive && item.downloadProgressText}
      <div class="item-meta">Download: {item.downloadProgressText}</div>
    {/if}
  {:else}
    <div class="item-meta">{item.folderId}:{item.path}</div>
    <div class="item-meta">{item.sizeText} | Cached {item.cachedAtText}</div>
  {/if}

  <div slot="actions">
    {#if item.kind === "root-folder"}
      {#if item.encrypted}
        {#if !item.passwordInputVisible}
          <button
            class="ghost icon-only"
            onclick={() => onSetPasswordVisible(item.folderId, true)}
            aria-label="Edit folder password"
          >
            <KeyRound size={16} />
          </button>
        {/if}
        <button class="ghost icon-only" onclick={() => onSaveFolderPassword(item.folderId)} aria-label="Unlock folder">
          <Unlock size={16} />
        </button>
        <button
          class="ghost icon-only"
          onclick={() => onClearFolderPassword(item.folderId)}
          disabled={!item.passwordSaved}
          aria-label="Forget saved folder password"
        >
          <Trash2 size={16} />
        </button>
      {/if}
      {#if item.hasCachedRoot}
        <button
          class="ghost icon-only"
          onclick={() => onOpenCachedDirectory(item.folderId, "")}
          disabled={isOpeningCachedFile}
          aria-label="Open local cached folder"
        >
          <ExternalLink size={16} />
        </button>
      {/if}
      <button
        class="icon icon-only"
        onclick={() => onToggleFavorite(item.folderId, "", item.name, "folder")}
        aria-label="Toggle favorite"
      >
        {#if item.isFavorite}
          <Star size={16} />
        {:else}
          <StarOff size={16} />
        {/if}
      </button>
    {:else if item.kind === "folder-entry"}
      {#if item.entryType === "directory"}
        {#if item.isCached}
          <button
            class="ghost icon-only"
            onclick={() => onOpenCachedDirectory(item.folderId, item.path)}
            disabled={isOpeningCachedFile}
            aria-label="Open local cached directory"
          >
            <ExternalLink size={16} />
          </button>
        {/if}
      {:else if item.isCached}
        <button
          class="ghost icon-only"
          onclick={() => onOpenCachedFile(item.folderId, item.path)}
          disabled={isOpeningCachedFile}
          aria-label="Open cached file"
        >
          <ExternalLink size={16} />
        </button>
        <button
          class="ghost icon-only"
          onclick={() => onOpenCachedFileDirectory(item.folderId, item.path)}
          disabled={isOpeningCachedFile}
          aria-label="Open cached file directory"
        >
          <FolderOpen size={16} />
        </button>
      {:else}
        <button
          class="ghost icon-only"
          onclick={() => onDownloadFile(item.folderId, item.path, item.name)}
          disabled={isDownloading || item.invalid}
          title={item.downloadLabel}
          aria-label={item.downloadLabel}
        >
          <Download size={16} />
        </button>
      {/if}
      <button
        class="icon icon-only"
        onclick={() =>
          onToggleFavorite(
            item.folderId,
            item.path,
            item.name,
            item.entryType === "directory" ? "folder" : "file",
          )}
        aria-label="Toggle favorite"
      >
        {#if item.isFavorite}
          <Star size={16} />
        {:else}
          <StarOff size={16} />
        {/if}
      </button>
    {:else if item.kind === "favorite"}
      {#if item.favoriteKind === "file"}
        {#if item.isCached}
          <button
            class="ghost"
            onclick={() => onOpenCachedFile(item.folderId, item.path)}
            disabled={isOpeningCachedFile}
          >
            Open
          </button>
          <button
            class="ghost"
            onclick={() => onOpenCachedFileDirectory(item.folderId, item.path)}
            disabled={isOpeningCachedFile}
          >
            Open Folder
          </button>
          <button
            class="ghost"
            onclick={() => onRemoveCachedFile(item.folderId, item.path)}
            disabled={isRemovingCachedFile || isClearingCache}
          >
            Drop
          </button>
        {:else}
          <button
            class="ghost"
            onclick={() => onDownloadFile(item.folderId, item.path, item.name)}
            disabled={isDownloading || !item.connected}
          >
            {item.downloadLabel}
          </button>
        {/if}
      {:else if item.isCached}
        <button
          class="ghost"
          onclick={() => onOpenCachedDirectory(item.folderId, item.path)}
          disabled={isOpeningCachedFile}
        >
          Open
        </button>
      {/if}
      <button
        class="icon icon-only"
        onclick={() =>
          onRemoveFavorite({
            key: item.key,
            folderId: item.folderId,
            path: item.path,
            name: item.name,
            kind: item.favoriteKind,
          })}
        aria-label="Remove favorite"
      >
        <Star size={16} />
      </button>
    {:else if item.kind === "cached-file"}
      <button
        class="ghost"
        onclick={() => onOpenCachedFile(item.folderId, item.path)}
        disabled={isOpeningCachedFile}
      >
        Open
      </button>
      <button
        class="ghost"
        onclick={() => onOpenCachedFileDirectory(item.folderId, item.path)}
        disabled={isOpeningCachedFile}
      >
        Open Folder
      </button>
      <button
        class="ghost"
        onclick={() => onRemoveCachedFile(item.folderId, item.path)}
        disabled={isRemovingCachedFile || isClearingCache}
      >
        Drop
      </button>
    {/if}
  </div>
</ListRow>

<style>
  .item-title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .item-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    flex: 0 0 auto;
  }

  .inline-input {
    margin-top: 0.35rem;
    max-width: 24rem;
  }
</style>
