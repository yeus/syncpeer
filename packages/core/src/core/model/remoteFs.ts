import { decryptUntrustedBytes as decryptEncryptedBytes } from "./untrusted.ts";

export interface FolderInfo {
  id: string;
  label: string;
  readOnly: boolean;
  advertisedDevices?: AdvertisedDeviceInfo[];
  encrypted?: boolean;
  needsPassword?: boolean;
  passwordError?: string;
  localDevicePresentInFolder?: boolean;
  stopReason?: number;
}

export interface AdvertisedDeviceInfo {
  id: string;
  name?: string;
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
  invalid?: boolean;
  deleted?: boolean;
  blocks?: FileBlock[];
}

export interface RemoteDeviceInfo {
  id: string;
  deviceName: string;
  clientName: string;
  clientVersion: string;
}

export interface FolderSyncState {
  folderId: string;
  remoteIndexId: string;
  remoteMaxSequence: string;
  indexReceived: boolean;
}

export interface FileDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

interface FolderState {
  id: string;
  label: string;
  readOnly: boolean;
  advertisedDevices: AdvertisedDeviceInfo[];
  encrypted: boolean;
  needsPassword: boolean;
  passwordError?: string;
  localDevicePresentInFolder?: boolean;
  stopReason?: number;
  indexReceived: boolean;
  remoteIndexId?: string;
  remoteMaxSequence?: string;
  files: Map<string, StoredFileRecord>;
}

interface StoredFileRecord {
  indexFile: any;
  request?: EncryptedRequestRecord;
}

interface EncryptedRequestRecord {
  encryptedName: string;
  fileKey: Uint8Array;
  encryptedBlocks: FileBlock[];
}

function normalizePath(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRequestName(folder: FolderState, requestedPath: string): string {
  const normalized = normalizePath(requestedPath);
  for (const [key, value] of folder.files) {
    if (normalizePath(key) === normalized) {
      return value.request?.encryptedName ?? key;
    }
  }
  return normalized;
}

function resolveStoredFile(folder: FolderState, requestedPath: string): StoredFileRecord | null {
  const normalized = normalizePath(requestedPath);
  for (const [key, value] of folder.files) {
    if (normalizePath(key) === normalized) {
      return value;
    }
  }
  return null;
}

function isRetryableCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("no such file")
  );
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
    invalid: Boolean(file.invalid),
    deleted: Boolean(file.deleted),
    blocks: Array.isArray(file.blocks ?? file.Blocks)
      ? (file.blocks ?? file.Blocks).map((b: any) => ({
          offset: Number(b.offset ?? 0),
          size: Number(b.size ?? 0),
          hash: b.hash instanceof Uint8Array ? b.hash : new Uint8Array(b.hash ?? []),
        }))
      : undefined,
  };
}

async function mapConcurrent<T>(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(total);
  let nextIndex = 0;
  const runner = async (): Promise<void> => {
    while (nextIndex < total) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(currentIndex);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => runner()),
  );
  return results;
}

export class RemoteFs {
  private folders: Map<string, FolderState>;
  private requestBlock: (
    folderId: string,
    filePath: string,
    offset: number,
    length: number,
    options?: { hash?: Uint8Array; blockNo?: number; fromTemporary?: boolean },
  ) => Promise<Uint8Array>;
  private log?: (event: string, details?: Record<string, unknown>) => void;
  private remoteDevice?: RemoteDeviceInfo;
  private closeConnection?: () => void;

  constructor(
    folders: Map<string, FolderState>,
    requestBlock: (
      folderId: string,
      filePath: string,
      offset: number,
      length: number,
      options?: { hash?: Uint8Array; blockNo?: number; fromTemporary?: boolean },
    ) => Promise<Uint8Array>,
    log?: (event: string, details?: Record<string, unknown>) => void,
    remoteDevice?: RemoteDeviceInfo,
    closeConnection?: () => void,
  ) {
    this.folders = folders;
    this.requestBlock = requestBlock;
    this.log = log;
    this.remoteDevice = remoteDevice;
    this.closeConnection = closeConnection;
  }

  getRemoteDeviceInfo(): RemoteDeviceInfo | undefined {
    return this.remoteDevice;
  }

  async listFolders(): Promise<FolderInfo[]> {
    return [...this.folders.values()].map((f) => ({
      id: f.id,
      label: f.label,
      readOnly: f.readOnly,
      advertisedDevices: [...f.advertisedDevices],
      encrypted: f.encrypted,
      needsPassword: f.needsPassword,
      passwordError: f.passwordError,
      localDevicePresentInFolder: f.localDevicePresentInFolder,
      stopReason: f.stopReason,
    }));
  }

  async listFolderSyncStates(): Promise<FolderSyncState[]> {
    return [...this.folders.values()].map((f) => ({
      folderId: f.id,
      remoteIndexId: String(f.remoteIndexId ?? "0"),
      remoteMaxSequence: String(f.remoteMaxSequence ?? "0"),
      indexReceived: Boolean(f.indexReceived),
    }));
  }

  async getFolderSyncState(folderId: string): Promise<FolderSyncState | null> {
    const folder = this.folders.get(folderId);
    if (!folder) return null;
    return {
      folderId,
      remoteIndexId: String(folder.remoteIndexId ?? "0"),
      remoteMaxSequence: String(folder.remoteMaxSequence ?? "0"),
      indexReceived: Boolean(folder.indexReceived),
    };
  }

  async stat(folderId: string, path: string): Promise<FileEntry | null> {
    const folder = this.folders.get(folderId);
    if (!folder) return null;
    const normalized = normalizePath(path);
    for (const [key, value] of folder.files) {
      const keyPath = normalizePath(key);
      if (keyPath === normalized) return toEntry(keyPath, value.indexFile);
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
    if (
      folder.encrypted &&
      folder.files.size === 0 &&
      !folder.needsPassword &&
      !folder.passwordError
    ) {
      const deadline = Date.now() + 6000;
      while (
        folder.files.size === 0 &&
        !folder.needsPassword &&
        !folder.passwordError &&
        Date.now() < deadline
      ) {
        await sleep(120);
      }
    }
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
        out.set(rest, toEntry(keyPath, value.indexFile));
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
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder: ${folderId}`);
    const requestName = resolveRequestName(folder, path);
    return this.requestBlock(folderId, requestName, offset, length);
  }

  async waitForFolderIndex(folderId: string, timeoutMs = 3000, pollMs = 100): Promise<boolean> {
    const folder = this.folders.get(folderId);
    if (!folder) return false;
    if (folder.indexReceived) return true;

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (folder.indexReceived) return true;
    }
    return folder.indexReceived;
  }

  async readFileFully(
    folderId: string,
    path: string,
    onProgress?: (progress: FileDownloadProgress) => void,
  ): Promise<Uint8Array> {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder: ${folderId}`);
    const storedFile = resolveStoredFile(folder, path);
    if (folder.encrypted) {
      return this.readEncryptedFileFully(folder, path, storedFile, onProgress);
    }
    const requestName = resolveRequestName(folder, path);

    const requestWithCompatibilityFallback = async (
      offset: number,
      size: number,
      options?: { hash?: Uint8Array; blockNo?: number },
    ): Promise<Uint8Array> => {
      const requestModes: Array<{ fromTemporary: boolean; includeBlockMetadata: boolean }> = [
        { fromTemporary: true, includeBlockMetadata: true },
        { fromTemporary: false, includeBlockMetadata: true },
        { fromTemporary: true, includeBlockMetadata: false },
        { fromTemporary: false, includeBlockMetadata: false },
      ];
      let lastError: unknown = null;
      for (const mode of requestModes) {
        try {
          return await this.requestBlock(folderId, requestName, offset, size, {
            fromTemporary: mode.fromTemporary,
            hash: mode.includeBlockMetadata ? options?.hash : undefined,
            blockNo: mode.includeBlockMetadata ? options?.blockNo : undefined,
          });
        } catch (error) {
          lastError = error;
          if (!isRetryableCompatibilityError(error)) {
            throw error;
          }
          this.log?.("core.request.retry_compat", {
            folderId,
            path: requestName,
            offset,
            size,
            blockNo: options?.blockNo ?? null,
            fromTemporary: mode.fromTemporary,
            includeBlockMetadata: mode.includeBlockMetadata,
          });
        }
      }

      const compatibilityChunkSize = 16 * 1024;
      if (size > compatibilityChunkSize) {
        this.log?.("core.request.retry_chunked", {
          folderId,
          path: requestName,
          offset,
          size,
          chunkSize: compatibilityChunkSize,
        });
        const chunks: Uint8Array[] = [];
        let downloaded = 0;
        while (downloaded < size) {
          const remaining = size - downloaded;
          const nextSize = Math.min(compatibilityChunkSize, remaining);
          const chunk = await this.requestBlock(folderId, requestName, offset + downloaded, nextSize, {
            fromTemporary: true,
          });
          if (chunk.length === 0) {
            throw new Error(`Unexpected empty compatibility chunk for ${requestName} at offset ${offset + downloaded}`);
          }
          chunks.push(chunk);
          downloaded += chunk.length;
          if (chunk.length < nextSize) break;
        }
        const out = new Uint8Array(downloaded);
        let pos = 0;
        for (const chunk of chunks) {
          out.set(chunk, pos);
          pos += chunk.length;
        }
        return out;
      }

      if (lastError instanceof Error) throw lastError;
      throw new Error(`Request failed for ${requestName} at offset ${offset}`);
    };

    const requestWithTemporaryFallback = async (
      offset: number,
      size: number,
      options?: { hash?: Uint8Array; blockNo?: number },
    ): Promise<Uint8Array> => {
      try {
        return await requestWithCompatibilityFallback(offset, size, options);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (!message.includes("timeout")) throw error;
        throw error;
      }
    };

    let entry = storedFile ? toEntry(normalizePath(path), storedFile.indexFile) : await this.stat(folderId, path);
    const waitUntil = Date.now() + 5000;
    while (!entry && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      entry = await this.stat(folderId, path);
    }
    if (!entry) return this.readFileByProbing(folderId, path, onProgress);
    if (entry.type === "directory") throw new Error(`Not a file: ${path}`);
    if (entry.invalid) {
      throw new Error(`Remote reports this file as invalid/unavailable: ${path}`);
    }
    if (entry.deleted) {
      throw new Error(`Remote reports this file as deleted: ${path}`);
    }
    if (!entry.blocks || entry.blocks.length == 0) {
      if (!Number.isFinite(entry.size) || entry.size <= 0) {
        return this.readFileByProbing(folderId, path, onProgress);
      }
      const chunkSize = 128 * 1024;
      const plan: Array<{ offset: number; size: number }> = [];
      for (let offset = 0; offset < entry.size; offset += chunkSize) {
        plan.push({
          offset,
          size: Math.min(chunkSize, entry.size - offset),
        });
      }
      let downloaded = 0;
      const chunks = await mapConcurrent(plan.length, 4, async (index) => {
        const next = plan[index];
        const chunk = await requestWithTemporaryFallback(next.offset, next.size);
        if (chunk.length === 0) {
          throw new Error(`Unexpected empty block while reading ${requestName} at offset ${next.offset}`);
        }
        downloaded += chunk.length;
        onProgress?.({
          downloadedBytes: downloaded,
          totalBytes: entry.size,
        });
        return chunk;
      });
      const out = new Uint8Array(downloaded);
      let pos = 0;
      for (const chunk of chunks) {
        out.set(chunk, pos);
        pos += chunk.length;
      }
      return out;
    }
    let total = 0;
    const totalBytes = entry.size > 0 ? entry.size : entry.blocks.reduce((sum, block) => sum + block.size, 0);
    const chunks = await mapConcurrent(entry.blocks.length, 6, async (index) => {
      const block = entry.blocks![index];
      const chunk = await requestWithTemporaryFallback(block.offset, block.size, {
        hash: block.hash,
        blockNo: index,
      });
      total += chunk.length;
      onProgress?.({
        downloadedBytes: total,
        totalBytes: Math.max(totalBytes, total),
      });
      return chunk;
    });
    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }

  private async readEncryptedFileFully(
    folder: FolderState,
    path: string,
    storedFile: StoredFileRecord | null,
    onProgress?: (progress: FileDownloadProgress) => void,
  ): Promise<Uint8Array> {
    let resolvedFile = storedFile;
    if (!resolvedFile || !resolvedFile.request) {
      const deadline = Date.now() + 7000;
      while (
        (!resolvedFile || !resolvedFile.request) &&
        !folder.needsPassword &&
        !folder.passwordError &&
        Date.now() < deadline
      ) {
        await sleep(120);
        resolvedFile = resolveStoredFile(folder, path);
      }
    }
    if (!resolvedFile || !resolvedFile.request) {
      if (folder.needsPassword) {
        throw new Error(`Folder ${folder.id} requires an encryption password before files can be downloaded.`);
      }
      if (folder.passwordError) {
        throw new Error(folder.passwordError);
      }
      throw new Error(`Encrypted metadata for ${path} is unavailable.`);
    }
    const entry = toEntry(normalizePath(path), resolvedFile.indexFile);
    if (entry.type === "directory") throw new Error(`Not a file: ${path}`);
    if (!entry.blocks || entry.blocks.length === 0) {
      return new Uint8Array(0);
    }
    const encryptedBlocks = resolvedFile.request.encryptedBlocks;
    if (encryptedBlocks.length !== entry.blocks.length) {
      throw new Error(`Encrypted block metadata mismatch for ${path}`);
    }
    let downloaded = 0;
    const chunks = await mapConcurrent(entry.blocks.length, 6, async (index) => {
      const originalBlock = entry.blocks![index];
      const encryptedBlock = encryptedBlocks[index];
      const payload = await this.requestBlock(
        folder.id,
        resolvedFile.request!.encryptedName,
        encryptedBlock.offset,
        encryptedBlock.size,
        {
          hash: encryptedBlock.hash,
          blockNo: index,
          fromTemporary: false,
        },
      );
      if (payload.length === 0) {
        throw new Error(`Unexpected empty encrypted block for ${path} at block ${index}`);
      }
      const plaintext = decryptEncryptedBytes(resolvedFile.request!.fileKey, payload);
      if (plaintext.length < originalBlock.size) {
        throw new Error(`Encrypted block for ${path} was shorter than expected`);
      }
      const chunk = plaintext.slice(0, originalBlock.size);
      downloaded += chunk.length;
      onProgress?.({
        downloadedBytes: downloaded,
        totalBytes: entry.size,
      });
      return chunk;
    });
    const out = new Uint8Array(entry.size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  private async readFileByProbing(
    folderId: string,
    path: string,
    onProgress?: (progress: FileDownloadProgress) => void,
  ): Promise<Uint8Array> {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder: ${folderId}`);
    const requestName = resolveRequestName(folder, path);
    const maxProbeSize = 16 * 1024 * 1024;
    let chunk: Uint8Array;
    try {
      chunk = await this.requestBlock(folderId, requestName, 0, maxProbeSize, { fromTemporary: false });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("timeout")) throw error;
      chunk = await this.requestBlock(folderId, requestName, 0, maxProbeSize, { fromTemporary: true });
    }
    if (chunk.length === 0) throw new Error(`Not a file: ${requestName}`);
    let end = chunk.length;
    while (end > 0 && chunk[end - 1] === 0) end--;
    const trimmed = chunk.slice(0, end);
    onProgress?.({
      downloadedBytes: trimmed.length,
      totalBytes: trimmed.length,
    });
    return trimmed;
  }

  close(): void {
    this.closeConnection?.();
  }
}
