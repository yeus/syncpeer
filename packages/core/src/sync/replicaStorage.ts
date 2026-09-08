import type { BepFileInfo } from "../core/protocol/bep.js";
import { hashReplicaEntry, readReplicaBlock, scanReplicaIndex, type LocalReplicaEdit, type ReplicaBlockReader, type ReplicaIndex } from "./replicaIndex.js";
import { receiveReplicaFiles, type ReplicaDestination } from "./replicaReceive.js";
import { advanceVersionVector, compareConcurrentVersionCounters } from "../core/protocol/versionVector.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

export interface ReplicaStorage extends ReplicaDestination {
  loadIndex: () => Promise<ReplicaIndex | null>;
  withLock: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** One owner for replica transactions, independent of native storage mechanics. */
export function createFolderReplica(
  storage: ReplicaStorage,
  deviceCounterId: string,
  hash: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
) {
  const scan = async () => {
    const previous = await storage.loadIndex();
    const index = await scanReplicaIndex(storage, deviceCounterId, previous, hash);
    if (previous?.pending) await storage.flushChanges([previous.pending.name]);
    await storage.saveIndex(index);
    return index;
  };
  return {
    edit: (edit: LocalReplicaEdit) => storage.withLock(async () => {
      assertReplicaPath(edit.path);
      if (isInternalReplicaPath(edit.path)) throw new Error("Internal replica path cannot be edited.");
      if ((edit.method === "write" && (!Number.isSafeInteger(edit.source.size) || edit.source.size < 0)) ||
        !Number.isSafeInteger(edit.modifiedMs) || edit.modifiedMs < 0) throw new Error("Invalid local file metadata.");
      const index = await scan();
      const old = index.files[edit.path]?.info;
      if (edit.expectedVersion === null ? !!old : !old ||
        compareConcurrentVersionCounters(old.version ?? {}, edit.expectedVersion) !== 0) {
        throw new Error("Replica file changed since editing began.");
      }
      const parent = edit.path.slice(0, edit.path.lastIndexOf("/") + 1).replace(/\/$/, "");
      if (edit.method !== "delete" && parent && (!index.files[parent] || index.files[parent].info.deleted || index.files[parent].info.type !== 1)) {
        throw new Error("Local file parent directory is unavailable.");
      }
      const info: BepFileInfo = { name: edit.path, type: 0, size: 0, blocks: [],
        modified_s: Math.floor(edit.modifiedMs / 1000), modified_ns: (edit.modifiedMs % 1000) * 1000000,
        permissions: old?.permissions ?? 0o600, no_permissions: old?.no_permissions,
        modified_by: deviceCounterId, block_size: 131072,
        version: advanceVersionVector(old?.version, deviceCounterId) };
      switch (edit.method) {
        case "write": {
          if (old && !old.deleted && old.type === 1) throw new Error("Cannot replace a directory with a file.");
          info.size = edit.source.size;
          info.blocks = await hashReplicaEntry({ path: edit.path, type: "file", size: edit.source.size,
            modifiedMs: edit.modifiedMs, revision: "local-edit" },
          { readRange: (_path, offset, size) => edit.source.readRange(offset, size) }, hash);
          break;
        }
        case "mkdir":
          if (old && !old.deleted) throw new Error("Local entry already exists.");
          info.type = 1; info.permissions = 0o700;
          break;
        case "delete":
          if (!old || old.deleted) throw new Error("Local entry is unavailable.");
          if (old.type === 1 && Object.values(index.files).some(entry =>
            !entry.info.deleted && entry.info.name.startsWith(edit.path + "/"))) throw new Error("Directory is not empty.");
          info.type = old.type; info.deleted = true;
          break;
        default: throw new Error("Unsupported local edit method.");
      }
      await receiveReplicaFiles(edit.folderId, index, [info], storage,
        (_path, offset, size) => {
          if (edit.method !== "write") throw new Error("Metadata edit must not request file contents.");
          return edit.source.readRange(offset, size);
        }, hash);
      return (await storage.loadIndex())!.files[edit.path].info;
    }),
    scan: () => storage.withLock(async () => Object.values((await scan()).files).map(entry => entry.info)),
    receive: (folderId: string, files: BepFileInfo[], request: ReplicaBlockReader) => storage.withLock(async () =>
      receiveReplicaFiles(folderId, await scan(), files, storage, request, hash)),
    // Serving blocks must not wait on a receive lock: both peers may pull concurrently.
    readBlock: async (path: string, offset: number, size: number, expectedHash?: Uint8Array) =>
      readReplicaBlock(await storage.loadIndex(), storage.readRange, { path, offset, size, hash: expectedHash }, hash),
  };
}
