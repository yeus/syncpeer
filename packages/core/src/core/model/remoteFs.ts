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

function normalizePath(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
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
    const normalized = normalizePath(path);
    for (const [key, value] of folder.files) {
      const keyPath = normalizePath(key);
      if (keyPath === normalized) return toEntry(keyPath, value);
    }
    const prefix = normalized ? normalized + "/" : "";
    for (const key of folder.files.keys()) {
      const keyPath = normalizePath(key);
      if (!prefix || keyPath.startsWith(prefix)) {
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
    const normalized = normalizePath(path);
    const prefix = normalized ? normalized + "/" : "";
    const out = new Map<string, FileEntry>();
    for (const [key, value] of folder.files) {
      const keyPath = normalizePath(key);
      if (normalized && !keyPath.startsWith(prefix)) continue;
      const rest = normalized ? keyPath.slice(prefix.length) : keyPath;
      if (!rest) continue;
      const firstSlash = rest.indexOf("/");
      if (firstSlash === -1) {
        out.set(rest, toEntry(keyPath, value));
      } else {
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
    return Array.from(out.values()).sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFileRange(folderId: string, path: string, offset: number, length: number): Promise<Uint8Array> {
    return this.requestBlock(folderId, path, offset, length);
  }

  async readFileFully(folderId: string, path: string): Promise<Uint8Array> {
    let entry = await this.stat(folderId, path);
    const waitUntil = Date.now() + 5000;
    while (!entry && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      entry = await this.stat(folderId, path);
    }
    if (!entry) return this.readFileByProbing(folderId, path);
    if (entry.type === "directory") throw new Error(`Not a file: ${path}`);
    if (!entry.blocks || entry.blocks.length == 0) {
      return this.requestBlock(folderId, path, 0, entry.size);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const block of entry.blocks) {
      const chunk = await this.requestBlock(folderId, path, block.offset, block.size);
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

  private async readFileByProbing(folderId: string, path: string): Promise<Uint8Array> {
    const maxProbeSize = 16 * 1024 * 1024;
    const chunk = await this.requestBlock(folderId, path, 0, maxProbeSize);
    if (chunk.length === 0) throw new Error(`Not a file: ${path}`);
    let end = chunk.length;
    while (end > 0 && chunk[end - 1] === 0) end--;
    return chunk.slice(0, end);
  }
}
