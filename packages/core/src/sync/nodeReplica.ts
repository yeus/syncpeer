import { open, mkdir, rmdir, utimes, lstat, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertNoSymlinks, createNodeFolderSyncStorage, listNodeReplicaEntries, safePath } from "./nodeFolderStorage.js";
import { createFolderReplica } from "./replicaStorage.js";
import { createNodeFileDownloadSink } from "../transfer/nodeStorage.js";
import { defaultFolderSyncPolicy } from "./folderSync.js";
import { createReplicaController } from "./replicaControl.js";
import { loadSqliteReplicaIndex, saveSqliteReplicaIndex, migrateReplicaMetadata } from "./nodeReplicaMetadata.js";
import type { NodeFolderSyncStorageOptions } from "./nodeFolderStorage.js";

const hashBytes = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

const syncEntry = async (filename: string) => {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
};

const flushChanges = async (root: string, paths: readonly string[]) => {
  const directories = new Set<string>();
  for (const relative of paths) {
    const target = path.join(root, safePath(relative));
    await assertNoSymlinks(root, target);
    try { await syncEntry(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let parent = path.dirname(target);
    while (parent !== root) { directories.add(parent); parent = path.dirname(parent); }
    directories.add(root);
  }
  // Flush child entries before their parents, including newly created ancestors.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncEntry(directory);
};

const createRootGuard = async (root: string, checkMarker: () => Promise<void>) => {
  await assertNoSymlinks(root, root);
  const original = await lstat(root);
  if (!original.isDirectory()) throw new Error("Replica root is not a directory.");
  return async () => {
    const current = await lstat(root);
    if (!current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("Replica root changed; verify the selected storage before resuming.");
    }
    try {
      await checkMarker();
    } catch (error) {
      throw new Error("Replica folder marker unavailable; synchronization stopped to protect local data.", { cause: error });
    }
  };
};

export async function createNodeFolderReplica(rootPath: string, deviceCounterId: string, options: NodeFolderSyncStorageOptions = {}) {
  const root = path.resolve(rootPath);
  const storage = await createNodeFolderSyncStorage(root, options);
  const checkHealth = await createRootGuard(root, storage.checkHealth);
  await storage.withLock!(async () => {
    await migrateReplicaMetadata(root, storage.metadata);
    await storage.loadState!();
    await rm(path.join(root, ".syncpeer-folder-marker"), { force: true });
  });
  const pausedRecord = storage.metadata.entries("replica-settings")[0];
  if (pausedRecord && (pausedRecord.value.length !== 1 || pausedRecord.value[0] > 1)) throw new Error("Invalid replica settings.");
  const paused = pausedRecord?.value[0] === 1;
  const readRange = async (relative: string, offset: number, size: number) => {
    await checkHealth();
    const filename = path.join(root, safePath(relative));
    await assertNoSymlinks(root, filename);
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = new Uint8Array(size);
      let consumed = 0;
      while (consumed < size) {
        const result = await file.read(bytes, consumed, size - consumed, offset + consumed);
        if (!result.bytesRead) throw new Error("Replica file changed during read.");
        consumed += result.bytesRead;
      }
      return bytes;
    } finally { await file.close(); }
  };
  return createReplicaController(createFolderReplica({
    withLock: async operation => {
      await checkHealth();
      return storage.withLock!(async () => { await checkHealth(); return operation(); });
    },
    loadIndex: async () => {
      await checkHealth();
      return loadSqliteReplicaIndex(storage.metadata);
    },
    listEntries: async () => { await checkHealth(); return listNodeReplicaEntries(root, "", ".syncpeer-state.json"); },
    readRange,
    saveIndex: async index => { await checkHealth(); saveSqliteReplicaIndex(storage.metadata, index); },
    flushChanges: async paths => { await checkHealth(); await flushChanges(root, paths); },
    archive: async relative => {
      await checkHealth();
      const archived = await storage.archiveFile(relative, "replace", defaultFolderSyncPolicy(), Date.now());
      if (archived) await flushChanges(root, [path.relative(root, archived)]);
    },
    makeDirectory: async relative => {
      await checkHealth();
      const target = path.join(root, safePath(relative));
      await assertNoSymlinks(root, target);
      await mkdir(target, { recursive: true });
    },
    remove: async (relative, directory) => {
      await checkHealth();
      const target = path.join(root, safePath(relative));
      await assertNoSymlinks(root, target);
      if (directory) await rmdir(target); else await storage.removeFile(relative);
    },
    createSink: async info => {
      await checkHealth();
      const target = path.join(root, safePath(info.name));
      const modifiedMs = Number(info.modified_s ?? 0) * 1000 + Number(info.modified_ns ?? 0) / 1000000;
      await assertNoSymlinks(root, target);
      const sink = await createNodeFileDownloadSink(target);
      return { ...sink, commit: async () => {
        await checkHealth();
        await assertNoSymlinks(root, target);
        await sink.commit();
        await utimes(target, new Date(modifiedMs), new Date(modifiedMs));
      } };
    },
  }, deviceCounterId, hashBytes), { paused, savePaused: value => storage.withLock!(async () => {
    await checkHealth();
    storage.metadata.replace("replica-settings", [{ id: "paused", value: new Uint8Array([Number(value)]) }]);
  }) });
}
