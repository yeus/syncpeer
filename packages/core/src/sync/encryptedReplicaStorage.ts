import { encryptUntrustedFilename } from "../core/model/untrusted.js";
import { createEncryptedDownloadSink, loadEncryptedDiskMetadata, readEncryptedDiskRange, type EncryptedFileSource } from "./encryptedFilesystem.js";
import { readEncryptedNamespace } from "./encryptedNamespace.js";
import { loadEncryptedReplicaIndex, saveEncryptedReplicaIndex } from "./encryptedReplicaPersistence.js";
import type { ReplicaEntry, ReplicaSource } from "./replicaIndex.js";
import type { ReplicaStorage } from "./replicaStorage.js";
import type { FileDownloadSink } from "../transfer/stream.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

export interface ReplicaByteStorage extends ReplicaSource {
  stat: (path: string) => Promise<ReplicaEntry | null>;
  createSink: (path: string, size: number) => Promise<Pick<FileDownloadSink, "write" | "commit" | "abort">>;
  makeDirectory: (path: string) => Promise<void>;
  remove: (path: string, directory: boolean) => Promise<void>;
  flushChanges: (paths: string[]) => Promise<void>;
}

/** Encryption and replica semantics stay in core; adapters own byte mechanics. */
export function createEncryptedReplicaStorage(bytes: ReplicaByteStorage, options: {
  folderKey: Uint8Array;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
  withLock: ReplicaStorage["withLock"];
  checkHealth: () => Promise<void>;
  /** Archive the supplied ciphertext path durably, without removing the source. */
  archive: (storedPath: string) => Promise<void>;
}): ReplicaStorage {
  const indexPath = ".syncpeer-replica-index";
  const storedPath = async (path: string) => {
    assertReplicaPath(path);
    if (isInternalReplicaPath(path)) throw new Error("Internal encrypted replica path.");
    return encryptUntrustedFilename(options.folderKey, path);
  };
  const readStored = async <T>(path: string, operation: (source: EncryptedFileSource) => Promise<T>) => {
    await options.checkHealth();
    const before = await bytes.stat(path);
    if (!before || before.type !== "file") throw new Error("Encrypted replica file unavailable.");
    const value = await operation({ size: before.size, readRange: (offset, size) => bytes.readRange(path, offset, size) });
    const after = await bytes.stat(path);
    if (!after || after.revision !== before.revision || after.size !== before.size || after.type !== "file") {
      if (value instanceof Uint8Array) value.fill(0);
      throw new Error("Encrypted replica changed during read.");
    }
    await options.checkHealth();
    return value;
  };
  const loadIndex: ReplicaStorage["loadIndex"] = async () => {
    await options.checkHealth();
    if (!await bytes.stat(indexPath)) {
      if ((await bytes.listEntries()).some(entry => !isInternalReplicaPath(entry.path))) {
        throw new Error("Encrypted replica index is missing; recover or import its history before synchronizing.");
      }
      return null;
    }
    return readStored(indexPath, source => loadEncryptedReplicaIndex(source, options.folderKey));
  };
  return {
    withLock: operation => options.withLock(async () => { await options.checkHealth(); return operation(); }),
    loadIndex,
    saveIndex: async index => {
      await options.checkHealth();
      await saveEncryptedReplicaIndex({ index, folderKey: options.folderKey, randomBytes: options.randomBytes,
        createSink: (_info, size) => bytes.createSink(indexPath, size) });
      await bytes.flushChanges([indexPath]);
    },
    listEntries: async () => {
      await options.checkHealth();
      const namespace = await readEncryptedNamespace(bytes, options.folderKey);
      const index = await loadIndex();
      return [...namespace].filter(([path]) => path !== "").map(([path, entry]) => {
        // On-disk placeholders alone cannot distinguish directories from symlinks.
        // A journaled deletion has not removed the existing directory yet.
        const known = index?.pending?.name === path && !index.pending.deleted ? index.pending : index?.files[path]?.info;
        if (entry.metadata === "name-only" && (known?.type !== 1 || known.deleted)) {
          throw new Error("Encrypted directory metadata is unavailable; import its authenticated index first.");
        }
        return { path, type: entry.fileInfo.type === 1 ? "directory" : "file",
          size: Number(entry.fileInfo.size ?? 0), revision: entry.revision ?? "inferred-directory",
          modifiedMs: Number(entry.fileInfo.modified_s ?? 0) * 1000 + Number(entry.fileInfo.modified_ns ?? 0) / 1000000 };
      });
    },
    readRange: async (path, offset, size) => {
      const encrypted = await storedPath(path);
      return readStored(encrypted, async source => {
        const metadata = await loadEncryptedDiskMetadata(source, encrypted, options.folderKey);
        try { return await readEncryptedDiskRange(source, metadata, offset, size); }
        finally { metadata.fileKey.fill(0); }
      });
    },
    createSink: async info => {
      await storedPath(info.name);
      await options.checkHealth();
      const { sink } = await createEncryptedDownloadSink({ fileInfo: info, folderKey: options.folderKey, randomBytes: options.randomBytes,
        createSink: (encrypted, size) => bytes.createSink(encrypted.name, size) });
      return { ...sink, commit: async () => { await options.checkHealth(); await sink.commit(); } };
    },
    archive: async path => { await options.checkHealth(); await options.archive(await storedPath(path)); },
    makeDirectory: async path => { await options.checkHealth(); await bytes.makeDirectory(await storedPath(path)); },
    remove: async (path, directory) => {
      await options.checkHealth();
      if (directory) {
        const entries = await readEncryptedNamespace(bytes, options.folderKey);
        if ([...entries.keys()].some(name => name.startsWith(`${path}/`))) throw new Error("Encrypted directory is not empty.");
        const physical = entries.get(path)?.storedPath;
        if (physical) await bytes.remove(physical, true);
      } else await bytes.remove(await storedPath(path), false);
    },
    flushChanges: async paths => {
      await options.checkHealth();
      await bytes.flushChanges(await Promise.all(paths.map(storedPath)));
    },
  };
}
