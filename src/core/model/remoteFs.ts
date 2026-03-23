export interface FolderInfo {
  id: string;
  label: string;
  readOnly: boolean;
}

export interface FileBlock {
  offset: number;
  size: number;
  hash: Uint8Array;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedMs: number;
  blocks?: FileBlock[];
}

interface FolderState {
  id: string;
  label: string;
  readOnly: boolean;
  files: Map<string, any>;
}

function toEntry(path: string, file: any): FileEntry {
  const typeValue = Number(file.type ?? 0);
  const type =
    typeValue === 1 ? "directory" :
    typeValue === 4 || typeValue === 2 || typeValue === 3 ? "symlink" :
    "file";

  return {
    name: path.split("/").filter(Boolean).at(-1) ?? path,
    path,
    type,
    size: Number(file.size ?? 0),
    modifiedMs: Number(file.modified_s ?? 0) * 1000 + Math.floor(Number(file.modified_ns ?? 0) / 1e6),
    blocks: Array.isArray(file.blocks ?? file.Blocks)
      ? (file.blocks ?? file.Blocks).map((b: any) => ({
          offset: Number(b.offset ?? 0),
          size: Number(b.size ?? 0),
          hash: b.hash instanceof Uint8Array ? b.hash : new Uint8Array(b.hash ?? []),
        }))
      : undefined,
  };
}

export class RemoteFs {
  constructor(
    private folders: Map<string, FolderState>,
    private requestBlock: (folderId: string, filePath: string, offset: number, length: number) => Promise<Uint8Array>,
  ) {}

  async listFolders(): Promise<FolderInfo[]> {
    return [...this.folders.values()].map((f) => ({
      id: f.id,
      label: f.label,
      readOnly: f.readOnly,
    }));
  }

  async stat(folderId: string, path: string): Promise<FileEntry | null> {
    const folder = this.folders.get(folderId);
    if (!folder) return null;

    const normalized = path.replace(/^\/+|\/+$/g, "");
    const file = folder.files.get(normalized);
    if (file) {
      return toEntry(normalized, file);
    }

    const prefix = normalized ? normalized + "/" : "";
    for (const key of folder.files.keys()) {
      // When the requested path is a prefix of some file key, treat it as a directory
      if (!prefix || key.startsWith(prefix)) {
        return {
          name: normalized.split("/").filter(Boolean).at(-1) ?? "",
          path: normalized,
          type: "directory",
          size: 0,
          modifiedMs: 0,
        };
      }
    }

    return null;
  }

  async readDir(folderId: string, path: string): Promise<FileEntry[]> {
    const folder = this.folders.get(folderId);
    if (!folder) return [];

    const normalized = path.replace(/^\/+|\/+$/g, "");
    const prefix = normalized ? normalized + "/" : "";
    const out = new Map<string, FileEntry>();

    for (const [key, value] of folder.files) {
      if (normalized) {
        // Skip entries that are not under the requested directory
        if (!key.startsWith(prefix)) continue;
      }

      // Strip the prefix to see what's left under this directory
      const rest = normalized ? key.slice(prefix.length) : key;
      if (!rest) continue;

      const firstSlash = rest.indexOf("/");
      if (firstSlash === -1) {
        // It's a file directly under the directory
        out.set(rest, toEntry(key, value));
      } else {
        // It's a sub-directory entry
        const childName = rest.slice(0, firstSlash);
        const childPath = normalized ? `${normalized}/${childName}` : childName;
        if (!out.get(childName)) {
          out.set(childName, {
            name: childName,
            path: childPath,
            type: "directory",
            size: 0,
            modifiedMs: 0,
          });
        }
      }
    }

    // Sort directories before files, then by name
    return Array.from(out.values()).sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFileRange(folderId: string, path: string, offset: number, length: number): Promise<Uint8Array> {
    return this.requestBlock(folderId, path, offset, length);
  }

  async readFileFully(folderId: string, path: string): Promise<Uint8Array> {
    const entry = await this.stat(folderId, path);
    if (!entry || entry.type != "file") {
      throw new Error(`Not a file: ${path}`);
    }

    if (!entry.blocks || entry.blocks.length == 0) {
      return this.requestBlock(folderId, path, 0, entry.size);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const block of entry.blocks) {
      const chunk = await this.requestBlock(folderId, path, block.offset, block.size);
      // push chunk into array instead of Python-style append
      chunks.push(chunk);
      total += chunk.length;
    }

    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }
}
