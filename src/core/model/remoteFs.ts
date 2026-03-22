/*
 * Remote file system abstraction for Syncthing BEP.
 *
 * This module exposes the `RemoteFs` class along with supporting types.  A
 * RemoteFs is backed by a live BEP session and provides convenience methods
 * for listing folders, enumerating directories, retrieving file metadata and
 * reading arbitrary byte ranges from remote files.
 */


/**
 * Information about a folder exposed by the peer.
 */
export interface FolderInfo {
  /** The internal folder ID. */
  id: string;
  /** Human readable label for the folder. */
  label: string;
  /** Whether this folder is read only from the peer’s perspective. */
  readOnly: boolean;
}

/**
 * A directory or file entry as returned by `readDir` or `stat`.
 */
export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  /** Modification time in milliseconds since the Unix epoch. */
  modified: number;
  /** Optional block size for files. */
  blockSize?: number;
  /** List of blocks making up the file. */
  blocks?: { offset: bigint; size: number; hash: Uint8Array }[];
}

/**
 * Convert a FileInfo protobuf message into a more convenient FileEntry.  For
 * directories only the name and type fields are meaningful.
 */
function fileInfoToEntry(info: any): FileEntry {
  let type: FileEntry['type'];
  switch (info.type) {
    case 1: // DIRECTORY
      type = 'directory';
      break;
    case 4: // SYMLINK
    case 2:
    case 3:
      type = 'symlink';
      break;
    default:
      type = 'file';
  }
  const modifiedSeconds = Number(info.modified_s ?? 0);
  const modifiedNs = Number(info.modified_ns ?? 0);
  const modified = modifiedSeconds * 1000 + Math.floor(modifiedNs / 1e6);
  const blocks = info.Blocks?.map((b: any) => ({
    offset: BigInt(b.offset ?? 0),
    size: b.size ?? 0,
    hash: b.hash instanceof Uint8Array ? b.hash : new Uint8Array(b.hash ?? []),
  }));
  return {
    name: info.name,
    type,
    size: Number(info.size ?? 0),
    modified,
    blockSize: info.block_size ?? undefined,
    blocks,
  };
}

export default class RemoteFs {
  private folders: Map<string, { state: FolderInfo; files: Map<string, any> }>;
  private requestBlock: (folder: string, name: string, offset: number, size: number) => Promise<Uint8Array>;

  constructor(
    folders: Map<string, { id: string; label: string; readOnly: boolean; files: Map<string, any> }>,
    requestBlock: (folder: string, name: string, offset: number, size: number) => Promise<Uint8Array>,
  ) {
    // Copy folder metadata
    this.folders = new Map();
    for (const [id, folder] of folders.entries()) {
      this.folders.set(id, {
        state: { id: folder.id, label: folder.label, readOnly: folder.readOnly },
        files: folder.files,
      });
    }
    this.requestBlock = requestBlock;
  }

  /**
   * List the folders advertised by the peer.
   */
  async listFolders(): Promise<FolderInfo[]> {
    return Array.from(this.folders.values()).map((f) => f.state);
  }

  /**
   * Get information about a path within a folder.  Returns null if the path
   * does not exist.  A directory is reported if there are files under the
   * prefix even if no FileInfo entry exists for the directory itself.
   */
  async stat(folderId: string, path: string): Promise<FileEntry | null> {
    const folder = this.folders.get(folderId);
    if (!folder) return null;
    const info = folder.files.get(path);
    if (info) {
      return fileInfoToEntry(info);
    }
    // Check if path is a directory by seeing if any file starts with path + '/'
    const prefix = path ? `${path}/` : '';
    for (const name of folder.files.keys()) {
      if (name === path) continue;
      if (path === '' || name.startsWith(prefix)) {
        // Directory exists implicitly
        return { name: path, type: 'directory', size: 0, modified: 0 };
      }
    }
    return null;
  }

  /**
   * Read a directory and return its direct children.  Directory names are
   * returned once even if multiple nested files share the same prefix.
   */
  async readDir(folderId: string, dirPath: string): Promise<FileEntry[]> {
    const folder = this.folders.get(folderId);
    if (!folder) return [];
    const children = new Map<string, FileEntry>();
    const prefix = dirPath ? `${dirPath}/` : '';
    for (const [name, info] of folder.files.entries()) {
      if (dirPath && name === dirPath) continue;
      if (!dirPath || name.startsWith(prefix)) {
        const remainder = dirPath ? name.slice(prefix.length) : name;
        const parts = remainder.split('/');
        const first = parts[0];
        if (parts.length === 1) {
          children.set(first, fileInfoToEntry(info));
        } else {
          if (!children.has(first)) {
            children.set(first, { name: first, type: 'directory', size: 0, modified: 0 });
          }
        }
      }
    }
    return Array.from(children.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Read a range of bytes from a file.  The caller must ensure that the
   * specified file exists and that the requested range does not exceed the
   * file size.  A new network request is issued for each call.
   */
  async readFileRange(folderId: string, filePath: string, offset: number, length: number): Promise<Uint8Array> {
    return this.requestBlock(folderId, filePath, offset, length);
  }

  /**
   * Convenience method to read an entire file into memory.  This method
   * iterates over the blocks described in the file’s metadata.  It is not
   * exposed via the RemoteFs interface but is used by the CLI for the
   * `download` command.
   */
  async readFileFully(folderId: string, filePath: string): Promise<Uint8Array> {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder ${folderId}`);
    const info = folder.files.get(filePath);
    if (!info) throw new Error(`No such file ${filePath}`);
    const entry = fileInfoToEntry(info);
    if (entry.type !== 'file') throw new Error(`Not a file: ${filePath}`);
    const blocks = entry.blocks ?? [];
    // If no block info exists, request the whole file in one go
    if (blocks.length === 0) {
      return await this.requestBlock(folderId, filePath, 0, entry.size);
    }
    const buffers: Uint8Array[] = [];
    for (const block of blocks) {
      const data = await this.requestBlock(folderId, filePath, Number(block.offset), block.size);
      buffers.push(data);
    }
    // Concatenate
    let totalLength = 0;
    for (const buf of buffers) totalLength += buf.length;
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      out.set(buf, offset);
      offset += buf.length;
    }
    return out;
  }
}