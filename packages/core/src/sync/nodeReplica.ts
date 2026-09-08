import { open, readFile, rename, mkdir, rmdir, utimes, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { encodeReplicaIndex, decodeReplicaIndex } from "./replicaPersistence.js";
import { assertNoSymlinks, createNodeFolderSyncStorage, listNodeReplicaEntries, safePath } from "./nodeFolderStorage.js";
import type { ReplicaIndex } from "./replicaIndex.js";
import { createFolderReplica } from "./replicaStorage.js";
import { createNodeFileDownloadSink } from "../transfer/nodeStorage.js";
import { defaultFolderSyncPolicy } from "./folderSync.js";
import { createReplicaController } from "./replicaControl.js";

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

const loadIndex = async (filename: string): Promise<ReplicaIndex | null> => {
  let content: Uint8Array;
  try { content = await readFile(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return decodeReplicaIndex(content);
};

export const saveReplicaIndex = async (filename: string, index: ReplicaIndex) => {
  await writeReplicaBytes(filename, encodeReplicaIndex(index));
};

const writeReplicaBytes = async (filename: string, value: Uint8Array) => {
  const temporary = `${filename}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, filename);
  await syncEntry(path.dirname(filename));
};

const createRootGuard = async (root: string, indexPath: string) => {
  await assertNoSymlinks(root, root);
  const original = await lstat(root);
  if (!original.isDirectory()) throw new Error("Replica root is not a directory.");
  const marker = path.join(root, ".syncpeer-folder-marker");
  try {
    const info = await lstat(marker);
    if (!info.isFile()) throw new Error("Invalid replica folder marker.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const initialized = await lstat(indexPath).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (initialized) throw new Error("Replica folder marker missing; verify the selected storage before resuming.", { cause: error });
    try {
      const file = await open(marker, "wx", 0o600);
      try { await file.sync(); } finally { await file.close(); }
      await syncEntry(root);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return async () => {
    const current = await lstat(root);
    if (!current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("Replica root changed; verify the selected storage before resuming.");
    }
    try {
      if (!(await lstat(marker)).isFile()) throw new Error("Invalid replica folder marker.");
    } catch (error) {
      throw new Error("Replica folder marker unavailable; synchronization stopped to protect local data.", { cause: error });
    }
  };
};

export async function createNodeFolderReplica(rootPath: string, deviceCounterId: string) {
  const root = path.resolve(rootPath);
  const indexPath = path.join(root, ".syncpeer-replica.json");
  const checkHealth = await createRootGuard(root, indexPath);
  const storage = await createNodeFolderSyncStorage(root);
  const settingsPath = path.join(root, ".syncpeer-replica-settings.json");
  await assertNoSymlinks(root, settingsPath);
  let paused = false;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    if (settings.format !== 1 || typeof settings.paused !== "boolean") throw new Error("Invalid replica settings.");
    paused = settings.paused;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
      await assertNoSymlinks(root, indexPath);
      return loadIndex(indexPath);
    },
    listEntries: async () => { await checkHealth(); return listNodeReplicaEntries(root, "", ".syncpeer-state.json"); },
    readRange,
    saveIndex: async index => { await checkHealth(); await saveReplicaIndex(indexPath, index); },
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
    await assertNoSymlinks(root, settingsPath);
    await writeReplicaBytes(settingsPath, new TextEncoder().encode(JSON.stringify({ format: 1, paused: value })));
  }) });
}
