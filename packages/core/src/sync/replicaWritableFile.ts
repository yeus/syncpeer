import type { BepFileInfo } from "../core/protocol/bep.js";
import { BEP_MAX_BLOCK_SIZE } from "../core/protocol/blockLimits.js";
import type { LocalFolderReplica } from "./replicaIndex.js";
import { createReplicaFileSource } from "./replicaFileSource.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

export interface ReplicaWritableScratch {
  size: () => Promise<number>;
  readRange: (offset: number, size: number) => Promise<Uint8Array>;
  write: (offset: number, bytes: Uint8Array) => Promise<void>;
  truncate: (size: number) => Promise<void>;
  close: () => Promise<void>;
}

export interface ReplicaWritableFile {
  size: () => Promise<number>;
  readRange: (offset: number, size: number, signal?: AbortSignal) => Promise<Uint8Array>;
  write: (offset: number, bytes: Uint8Array, signal?: AbortSignal) => Promise<void>;
  truncate: (size: number, signal?: AbortSignal) => Promise<void>;
  commit: (modifiedMs?: number, signal?: AbortSignal) => Promise<BepFileInfo>;
  abort: () => Promise<void>;
}

const validateRange = (offset: number, size: number) => {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 ||
    !Number.isSafeInteger(offset + size)) {
    throw new Error("Invalid writable replica range.");
  }
};

const copySource = async (
  source: { size: number; readRange: (offset: number, size: number, signal?: AbortSignal) => Promise<Uint8Array> },
  scratch: ReplicaWritableScratch,
  signal?: AbortSignal,
) => {
  await scratch.truncate(source.size);
  for (let offset = 0; offset < source.size; offset += 131072) {
    signal?.throwIfAborted();
    const size = Math.min(131072, source.size - offset);
    const bytes = await source.readRange(offset, size, signal);
    try {
      if (bytes.length !== size) throw new Error("Replica file changed while opening writable handle.");
      await scratch.write(offset, bytes);
    } finally {
      bytes.fill(0);
    }
  }
};

export async function openReplicaWritableFile(replica: LocalFolderReplica, options: {
  folderId: string;
  path: string;
  open: "create" | "existing";
  scratch: ReplicaWritableScratch;
  modifiedMs?: number;
  signal?: AbortSignal;
}): Promise<ReplicaWritableFile> {
  if (!replica.edit) throw new Error("Replica does not support local edits.");
  assertReplicaPath(options.path);
  if (isInternalReplicaPath(options.path)) throw new Error("Internal replica file cannot be edited.");
  options.signal?.throwIfAborted();
  let closed = false;
  let expectedVersion: BepFileInfo["version"] | null = null;
  try {
    if (options.open === "existing") {
      const source = await createReplicaFileSource(replica, options.path);
      expectedVersion = source.fileInfo.version ?? {};
      await copySource(source, options.scratch, options.signal);
    } else if ((await replica.scan()).some(file => file.name === options.path && !file.deleted)) {
      throw new Error("Replica file already exists.");
    } else {
      await options.scratch.truncate(0);
    }
  } catch (error) {
    await options.scratch.close();
    throw error;
  }
  const ensureOpen = () => {
    options.signal?.throwIfAborted();
    if (closed) throw new Error("Writable replica file is closed.");
  };
  const close = async () => {
    if (!closed) {
      closed = true;
      await options.scratch.close();
    }
  };
  return {
    size: async () => {
      ensureOpen();
      return options.scratch.size();
    },
    readRange: async (offset, size, signal) => {
      ensureOpen();
      signal?.throwIfAborted();
      validateRange(offset, size);
      const current = await options.scratch.size();
      const available = Math.max(0, Math.min(size, current - offset));
      if (!available) return new Uint8Array();
      const bytes = await options.scratch.readRange(offset, available);
      signal?.throwIfAborted();
      if (bytes.length !== available) throw new Error("Writable replica scratch changed during read.");
      return bytes;
    },
    write: async (offset, bytes, signal) => {
      ensureOpen();
      signal?.throwIfAborted();
      validateRange(offset, bytes.length);
      if (bytes.length > BEP_MAX_BLOCK_SIZE) throw new Error("Writable replica write is oversized.");
      await options.scratch.write(offset, bytes);
    },
    truncate: async (size, signal) => {
      ensureOpen();
      signal?.throwIfAborted();
      validateRange(0, size);
      await options.scratch.truncate(size);
    },
    commit: async (modifiedMs, signal) => {
      ensureOpen();
      signal?.throwIfAborted();
      const size = await options.scratch.size();
      try {
        return await replica.edit!({
          method: "write", folderId: options.folderId, path: options.path,
          expectedVersion, modifiedMs: modifiedMs ?? options.modifiedMs ?? Date.now(),
          source: { size, readRange: (offset, length) => options.scratch.readRange(offset, length) },
        });
      } finally {
        await close();
      }
    },
    abort: close,
  };
}
