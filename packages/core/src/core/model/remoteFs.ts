import { decryptUntrustedBytes as decryptEncryptedBytes } from "./untrusted.js";
import type { BepFileInfo } from "../protocol/bep.js";
import type {
  FileDownloadMetadata,
  FileDownloadResult,
  FileDownloadSink,
} from "../../transfer/stream.js";

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
  transportKind?: "direct-tcp" | "relay";
  connectedVia?: string;
  connectionScope?: "lan" | "wan" | "unknown";
}

export interface FileUploadOptions {
  modifiedMs?: number;
  onProgress?: (progress: {
    processedBytes: number;
    totalBytes: number;
    elapsedMs: number;
    phase: "preparing" | "publishing";
  }) => void;
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
  indexFile: BepFileInfo;
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

const createAbortError = (): Error => {
  const error = new Error("Download cancelled.");
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw createAbortError();
};

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
  return message.includes("no such file");
}

export function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    "timeout",
    "connection reset",
    "connection closed",
    "broken pipe",
    "unexpected end",
    "eof",
  ].some((fragment) => message.includes(fragment));
}

function toEntry(path: string, file: BepFileInfo): FileEntry {
  const rawBlocks = file.blocks ?? file.Blocks;
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
    blocks: rawBlocks
      ? rawBlocks.map((b) => ({
          offset: b.offset,
          size: b.size,
          hash: b.hash,
        }))
      : undefined,
  };
}

export class RemoteFs {
  private folders: Map<string, FolderState>;
  private requestBlock: (
    folderId: string,
    filePath: string,
    offset: number,
    length: number,
    options?: {
      hash?: Uint8Array;
      blockNo?: number;
      fromTemporary?: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<Uint8Array>;
  private log?: (event: string, details?: Record<string, unknown>) => void;
  private remoteDevice?: RemoteDeviceInfo;
  private closeConnection?: () => void;
  private publishFile?: (
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: FileUploadOptions,
  ) => Promise<void>;
  private requestFolderIndexUpdate: (folderId: string) => Promise<void>;
  private setFocusedFolderId: (folderId: string | null) => void;

  constructor(
    folders: Map<string, FolderState>,
    requestBlock: (
      folderId: string,
      filePath: string,
      offset: number,
      length: number,
      options?: {
        hash?: Uint8Array;
        blockNo?: number;
        fromTemporary?: boolean;
        signal?: AbortSignal;
      },
    ) => Promise<Uint8Array>,
    requestFolderIndexUpdate: (folderId: string) => Promise<void>,
    setFocusedFolderId: (folderId: string | null) => void,
    log?: (event: string, details?: Record<string, unknown>) => void,
    remoteDevice?: RemoteDeviceInfo,
    closeConnection?: () => void,
    publishFile?: (
      folderId: string,
      path: string,
      bytes: Uint8Array,
      options?: FileUploadOptions,
    ) => Promise<void>,
  ) {
    this.folders = folders;
    this.requestBlock = requestBlock;
    this.log = log;
    this.remoteDevice = remoteDevice;
    this.closeConnection = closeConnection;
    this.publishFile = publishFile;
    this.requestFolderIndexUpdate = requestFolderIndexUpdate;
    this.setFocusedFolderId = setFocusedFolderId;
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

  async requestFolderIndex(folderId: string): Promise<void> {
    const normalizedFolderId = String(folderId ?? "").trim();
    if (!normalizedFolderId) return;
    if (!this.folders.has(normalizedFolderId)) {
      throw new Error(`Unknown folder: ${normalizedFolderId}`);
    }
    await this.requestFolderIndexUpdate(normalizedFolderId);
  }

  setFocusedFolder(folderId: string | null): void {
    const normalizedFolderId = String(folderId ?? "").trim();
    this.setFocusedFolderId(normalizedFolderId || null);
  }

  async stat(folderId: string, path: string): Promise<FileEntry | null> {
    const folder = this.folders.get(folderId);
    if (!folder) return null;
    const normalized = normalizePath(path);
    for (const [key, value] of folder.files) {
      const keyPath = normalizePath(key);
      const entry = toEntry(keyPath, value.indexFile);
      if (keyPath === normalized && !entry.deleted) return entry;
    }
    const prefix = normalized ? normalized + "/" : "";
    for (const key of folder.files.keys()) {
      const stored = folder.files.get(key);
      if (!stored) continue;
      const keyPath = normalizePath(key);
      const entry = toEntry(keyPath, stored.indexFile);
      if (entry.deleted) continue;
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
    if (!folder.indexReceived) await this.waitForFolderIndex(folderId, 6000, 120);
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
      const entry = toEntry(keyPath, value.indexFile);
      if (entry.deleted) continue;
      const rest = normalized ? keyPath.slice(prefix.length) : keyPath;
      if (!rest) continue;
      const firstSlash = rest.indexOf("/");
      if (firstSlash === -1) {
        out.set(rest, entry);
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

  async readFileRange(
    folderId: string,
    path: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder: ${folderId}`);
    const requestName = resolveRequestName(folder, path);
    return this.requestBlockWithRetry(folderId, requestName, offset, length, { signal });
  }

  private async requestBlockWithRetry(
    folderId: string,
    filePath: string,
    offset: number,
    length: number,
    options?: {
      hash?: Uint8Array;
      blockNo?: number;
      fromTemporary?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<Uint8Array> {
    throwIfAborted(options?.signal);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.requestBlock(folderId, filePath, offset, length, options);
      } catch (error) {
        throwIfAborted(options?.signal);
        lastError = error;
        if (!isTransportFailure(error) || attempt === 3) throw error;
        this.log?.("core.request.retry", {
          folderId,
          path: filePath,
          offset,
          length,
          attempt,
          attemptsTotal: 3,
          message: error instanceof Error ? error.message : String(error),
        });
        await sleep(Math.min(1000, attempt * 250));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async waitForFolderIndex(folderId: string, timeoutMs = 3000, pollMs = 100): Promise<boolean> {
    const folder = this.folders.get(folderId);
    if (!folder) return false;
    this.setFocusedFolder(folderId);
    if (folder.indexReceived) return true;
    await this.requestFolderIndex(folderId);

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
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    await this.readFileToSink(folderId, path, {
      begin: () => undefined,
      write: async (_offset, bytes) => {
        chunks.push(new Uint8Array(bytes));
      },
      commit: () => undefined,
      abort: () => undefined,
    }, onProgress, signal);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  async readFileToSink(
    folderId: string,
    path: string,
    sink: FileDownloadSink,
    onProgress?: (progress: FileDownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<FileDownloadResult> {
    throwIfAborted(signal);
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder: ${folderId}`);
    if (!folder.indexReceived) await this.waitForFolderIndex(folderId, 6000, 120);
    const storedFile = resolveStoredFile(folder, path);
    if (folder.encrypted) {
      return this.readEncryptedFileToSink(folder, path, storedFile, sink, onProgress, signal);
    }
    const requestName = resolveRequestName(folder, path);

    const requestWithCompatibilityFallback = async (
      offset: number,
      size: number,
      options?: { hash?: Uint8Array; blockNo?: number; signal?: AbortSignal },
    ): Promise<Uint8Array> => {
      const requestModes: Array<{ fromTemporary: boolean; includeBlockMetadata: boolean }> = [
        // Prefer non-temporary requests first; some peers reject temporary pulls for normal files.
        { fromTemporary: false, includeBlockMetadata: true },
        { fromTemporary: true, includeBlockMetadata: true },
        { fromTemporary: false, includeBlockMetadata: false },
        { fromTemporary: true, includeBlockMetadata: false },
      ];
      let lastError: unknown = null;
      for (const mode of requestModes) {
        try {
          return await this.requestBlockWithRetry(folderId, requestName, offset, size, {
            fromTemporary: mode.fromTemporary,
            hash: mode.includeBlockMetadata ? options?.hash : undefined,
            blockNo: mode.includeBlockMetadata ? options?.blockNo : undefined,
            signal: options?.signal,
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
          throwIfAborted(options?.signal);
          const remaining = size - downloaded;
          const nextSize = Math.min(compatibilityChunkSize, remaining);
          const chunk = await this.requestBlockWithRetry(folderId, requestName, offset + downloaded, nextSize, {
            fromTemporary: true,
            signal: options?.signal,
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
      options?: { hash?: Uint8Array; blockNo?: number; signal?: AbortSignal },
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
    if (!entry) return this.readFileByProbing(folderId, path, sink, onProgress, signal);
    if (entry.type === "directory") throw new Error(`Not a file: ${path}`);
    if (entry.invalid) {
      throw new Error(`Remote reports this file as invalid/unavailable: ${path}`);
    }
    if (entry.deleted) {
      throw new Error(`Remote reports this file as deleted: ${path}`);
    }
    if (!entry.blocks || entry.blocks.length == 0) {
      if (!Number.isFinite(entry.size) || entry.size <= 0) {
        return this.readFileByProbing(folderId, path, sink, onProgress, signal);
      }
      const chunkSize = 128 * 1024;
      const plan: Array<{ offset: number; size: number }> = [];
      for (let offset = 0; offset < entry.size; offset += chunkSize) {
        plan.push({
          offset,
          size: Math.min(chunkSize, entry.size - offset),
        });
      }
      return this.downloadPlannedChunks(
        folderId,
        normalizePath(path),
        entry.size,
        false,
        plan,
        6,
        (next) => requestWithTemporaryFallback(next.offset, next.size, { signal }),
        sink,
        onProgress,
        signal,
      );
    }
    const totalBytes = entry.size > 0 ? entry.size : entry.blocks.reduce((sum, block) => sum + block.size, 0);
    const plan = entry.blocks.map((block, index) => ({
      offset: block.offset,
      size: block.size,
      block,
      blockNo: index,
    }));
    return this.downloadPlannedChunks(
      folderId,
      normalizePath(path),
      totalBytes,
      false,
      plan,
      6,
      (next) => requestWithTemporaryFallback(next.offset, next.size, {
        hash: next.block.hash,
        blockNo: next.blockNo,
        signal,
      }),
      sink,
      onProgress,
      signal,
    );
  }

  async writeFileFully(
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: FileUploadOptions,
  ): Promise<void> {
    if (!this.publishFile) {
      throw new Error("Upload is not supported by this session transport.");
    }
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      throw new Error("Upload path must not be empty.");
    }
    await this.publishFile(folderId, normalizedPath, bytes, options);
  }

  private async readEncryptedFileToSink(
    folder: FolderState,
    path: string,
    storedFile: StoredFileRecord | null,
    sink: FileDownloadSink,
    onProgress?: (progress: FileDownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<FileDownloadResult> {
    let resolvedFile = storedFile;
    if (!resolvedFile || !resolvedFile.request) {
      const deadline = Date.now() + 7000;
      while (
        (!resolvedFile || !resolvedFile.request) &&
        !folder.needsPassword &&
        !folder.passwordError &&
        Date.now() < deadline
      ) {
        throwIfAborted(signal);
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
      const metadata: FileDownloadMetadata = {
        folderId: folder.id,
        path: normalizePath(path),
        sizeBytes: 0,
        encrypted: true,
      };
      await sink.begin(metadata);
      throwIfAborted(signal);
      await sink.commit();
      return { bytesWritten: 0, totalBytes: 0 };
    }
    const encryptedBlocks = resolvedFile.request.encryptedBlocks;
    if (encryptedBlocks.length !== entry.blocks.length) {
      throw new Error(`Encrypted block metadata mismatch for ${path}`);
    }
    const plan = entry.blocks.map((block, index) => ({
      offset: block.offset,
      size: block.size,
      originalBlock: block,
      encryptedBlock: encryptedBlocks[index],
      blockNo: index,
    }));
    return this.downloadPlannedChunks(
      folder.id,
      normalizePath(path),
      entry.size,
      true,
      plan,
      6,
      async (next) => {
        const payload = await this.requestBlockWithRetry(
          folder.id,
          resolvedFile!.request!.encryptedName,
          next.encryptedBlock.offset,
          next.encryptedBlock.size,
          {
            hash: next.encryptedBlock.hash,
            blockNo: next.blockNo,
            fromTemporary: false,
            signal,
          },
        );
        if (payload.length === 0) {
          throw new Error(`Unexpected empty encrypted block for ${path} at block ${next.blockNo}`);
        }
        const plaintext = decryptEncryptedBytes(resolvedFile!.request!.fileKey, payload);
        if (plaintext.length < next.originalBlock.size) {
          throw new Error(`Encrypted block for ${path} was shorter than expected`);
        }
        return plaintext.slice(0, next.originalBlock.size);
      },
      sink,
      onProgress,
      signal,
    );
  }

  private async readFileByProbing(
    folderId: string,
    path: string,
    sink: FileDownloadSink,
    onProgress?: (progress: FileDownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<FileDownloadResult> {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder: ${folderId}`);
    const requestName = resolveRequestName(folder, path);
    const maxProbeSize = 16 * 1024 * 1024;
    let chunk: Uint8Array;
    try {
      chunk = await this.requestBlockWithRetry(folderId, requestName, 0, maxProbeSize, {
        fromTemporary: false,
        signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("timeout")) throw error;
      chunk = await this.requestBlockWithRetry(folderId, requestName, 0, maxProbeSize, {
        fromTemporary: true,
        signal,
      });
    }
    if (chunk.length === 0) throw new Error(`Not a file: ${requestName}`);
    let end = chunk.length;
    while (end > 0 && chunk[end - 1] === 0) end--;
    const trimmed = chunk.slice(0, end);
    throwIfAborted(signal);
    await sink.begin({
      folderId,
      path: normalizePath(path),
      sizeBytes: trimmed.length,
      encrypted: false,
    });
    await sink.write(0, trimmed);
    onProgress?.({
      downloadedBytes: trimmed.length,
      totalBytes: trimmed.length,
    });
    await sink.commit();
    return { bytesWritten: trimmed.length, totalBytes: trimmed.length };
  }

  private async downloadPlannedChunks<T extends { offset: number; size: number }>(
    folderId: string,
    path: string,
    totalBytes: number,
    encrypted: boolean,
    plan: T[],
    concurrency: number,
    request: (item: T) => Promise<Uint8Array>,
    sink: FileDownloadSink,
    onProgress?: (progress: FileDownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<FileDownloadResult> {
    throwIfAborted(signal);
    await sink.begin({ folderId, path, sizeBytes: totalBytes, encrypted });
    let downloaded = 0;
    let pending: Array<{ offset: number; bytes: Uint8Array }> = [];
    let pendingBytes = 0;
    const flushPending = async (): Promise<void> => {
      if (pending.length === 0) return;
      const first = pending[0];
      const combined = new Uint8Array(pendingBytes);
      let targetOffset = 0;
      for (const item of pending) {
        combined.set(item.bytes, targetOffset);
        targetOffset += item.bytes.length;
      }
      pending = [];
      pendingBytes = 0;
      await sink.write(first.offset, combined);
    };
    const inFlight = new Map<number, Promise<
      { index: number; bytes: Uint8Array; error?: never } |
      { index: number; bytes?: never; error: unknown }
    >>();
    const completed = new Map<number, Uint8Array>();
    let nextRequestIndex = 0;
    let nextWriteIndex = 0;
    const startRequest = (index: number) => {
      const pendingRequest = request(plan[index]).then(
        (bytes) => ({ index, bytes }),
        (error: unknown) => ({ index, error }),
      );
      inFlight.set(index, pendingRequest);
    };
    while (nextRequestIndex < Math.min(plan.length, Math.max(1, concurrency))) {
      startRequest(nextRequestIndex);
      nextRequestIndex += 1;
    }
    while (inFlight.size > 0) {
      throwIfAborted(signal);
      const result = await Promise.race(inFlight.values());
      inFlight.delete(result.index);
      if ("error" in result) throw result.error;
      const item = plan[result.index];
      if (result.bytes.length === 0) {
        throw new Error(`Unexpected empty block while reading ${path} at offset ${item.offset}`);
      }
      if (result.bytes.length !== item.size) {
        throw new Error(
          `Downloaded block for ${path} at offset ${item.offset}: ` +
          `expected ${item.size} bytes, received ${result.bytes.length}`,
        );
      }
      completed.set(result.index, result.bytes);
      if (nextRequestIndex < plan.length) {
        startRequest(nextRequestIndex);
        nextRequestIndex += 1;
      }
      while (completed.has(nextWriteIndex)) {
        throwIfAborted(signal);
        const chunk = completed.get(nextWriteIndex)!;
        completed.delete(nextWriteIndex);
        const next = plan[nextWriteIndex];
        const previous = pending[pending.length - 1];
        const contiguous = previous
          ? previous.offset + previous.bytes.length === next.offset
          : true;
        if (!contiguous || pendingBytes + chunk.length > 1024 * 1024) {
          await flushPending();
        }
        pending.push({ offset: next.offset, bytes: chunk });
        pendingBytes += chunk.length;
        downloaded += chunk.length;
        onProgress?.({
          downloadedBytes: downloaded,
          totalBytes: Math.max(totalBytes, downloaded),
        });
        nextWriteIndex += 1;
      }
    }
    throwIfAborted(signal);
    await flushPending();
    if (downloaded !== totalBytes) {
      throw new Error(
        `Incomplete download for ${path}: expected ${totalBytes} bytes, received ${downloaded}`,
      );
    }
    throwIfAborted(signal);
    await sink.commit();
    return {
      bytesWritten: downloaded,
      totalBytes,
    };
  }

  close(): void {
    this.closeConnection?.();
  }
}
