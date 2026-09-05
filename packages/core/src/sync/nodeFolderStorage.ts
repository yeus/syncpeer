import { copyFile, lstat, open, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import type { FileEntry } from "../core/model/remoteFs.js";
import { digestRanges } from "../transfer/nodeStorage.js";
import path from "node:path";
import type {
  FolderSyncBaseline,
  FolderSyncPolicy,
  FolderSyncStorage,
  LocalSyncFile,
} from "./folderSync.js";

export interface NodeFolderSyncStorageOptions {
  statePath?: string;
  versionRoot?: string;
  trashRoot?: string;
}

export interface NodeFolderSyncStorage extends FolderSyncStorage {
  listVersions: (relativePath?: string) => Promise<Array<{ archivePath: string; path: string; modifiedMs: number }>>;
  restoreVersion: (archivePath: string, targetPath?: string) => Promise<void>;
}

const normalizePath = (value: string): string => value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");

const safePath = (value: string): string => {
  const normalized = normalizePath(value);
  if (!normalized || normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Folder sync paths must stay inside the selected root.");
  }
  return normalized;
};

const assertNoSymlinks = async (root: string, target: string): Promise<void> => {
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Path is outside the selected root.");
  let current = root;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Folder storage refuses symlink paths.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
};

const metadataKey = (entry: Awaited<ReturnType<typeof stat>>) => `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}`;

const fingerprintFile = async (absolute: string, size: number, blocks?: FileEntry["blocks"]) => {
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const ranges = blocks ?? Array.from({ length: Math.ceil(size / 131072) }, (_, i) => ({ offset: i * 131072, size: Math.min(131072, size - i * 131072) }));
    const parts: string[] = [];
    for (let start = 0; start < ranges.length; start += 256) {
      for (const range of await digestRanges(file, ranges.slice(start, start + 256), false)) {
        parts.push(`${range.offset}:${range.size}:${Array.from(range.hash).join(",")}`);
      }
    }
    return parts.length ? parts.join("|") : `empty:${size}`;
  } finally { await file.close(); }
};

const ignoredEntry = (name: string, stateName: string): boolean =>
  name === stateName ||
  name === ".stversions" ||
  name === ".syncpeer-trash" ||
  name.startsWith(".syncpeer-") ||
  name.includes(".syncpeer-conflict-");

const listDirectory = async (root: string, directory: string, stateName: string, remote: readonly FileEntry[], cache: Map<string, { key: string; fingerprint: string; layout?: string; remoteFingerprint?: string }>): Promise<LocalSyncFile[]> => {
  const absolute = path.join(root, directory);
  await assertNoSymlinks(root, absolute);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files: LocalSyncFile[] = [];
  for (const entry of entries) {
    const relative = normalizePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (ignoredEntry(entry.name, stateName)) continue;
    if (entry.isDirectory()) {
      files.push(...await listDirectory(root, relative, stateName, remote, cache));
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = path.join(root, relative);
    const metadata = await stat(absolutePath);
    const key = metadataKey(metadata);
    let cached = cache.get(relative);
    if (cached?.key !== key) {
      cached = { key, fingerprint: await fingerprintFile(absolutePath, metadata.size) };
      cache.set(relative, cached);
    }
    const counterpart = remote.find(file => file.path === relative && !file.deleted && file.size === metadata.size);
    const layout = counterpart?.blocks?.map(block => `${block.offset}:${block.size}`).join("|");
    if (counterpart?.blocks && cached.layout !== layout) {
      cached.remoteFingerprint = await fingerprintFile(absolutePath, metadata.size, counterpart.blocks);
      cached.layout = layout;
    }
    if (metadataKey(await stat(absolutePath)) !== key) throw new Error("Local file changed during hashing.");
    files.push({
      path: relative,
      size: metadata.size,
      modifiedMs: metadata.mtimeMs,
      fingerprint: cached.fingerprint,
      matchesRemote: counterpart?.fingerprint != null && (cached.remoteFingerprint ?? cached.fingerprint) === counterpart.fingerprint,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

const archiveName = (relativePath: string, nowMs: number): string => {
  const stamp = new Date(nowMs).toISOString().replaceAll(/[^0-9]/g, "").slice(0, 17);
  return `${relativePath}.${stamp}`;
};

const pruneVersions = async (root: string, relativePath: string, policy: FolderSyncPolicy, nowMs: number): Promise<void> => {
  const directory = path.dirname(relativePath);
  const name = path.basename(relativePath);
  const archiveDirectory = path.join(root, directory === "." ? "" : directory);
  await assertNoSymlinks(root, archiveDirectory);
  let entries;
  try {
    entries = await readdir(archiveDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const matches = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${name}.`) && /^\d{17}$/.test(entry.name.slice(name.length + 1)))
    .sort((left, right) => right.name.localeCompare(left.name));
  const kept: number[] = [];
  for (const entry of matches) {
    const stamp = entry.name.slice(name.length + 1);
    const date = Date.UTC(+stamp.slice(0,4), +stamp.slice(4,6)-1, +stamp.slice(6,8), +stamp.slice(8,10), +stamp.slice(10,12), +stamp.slice(12,14), +stamp.slice(14));
    const age = Math.max(0, nowMs - date);
    const interval = age < 3600000 ? 30000 : age < 86400000 ? 3600000 : age < 2592000000 ? 86400000 : 604800000;
    const limit = policy.maxVersions ?? (policy.versioning === "simple" ? 1 : Infinity);
    if (kept.length < limit && (policy.versioning !== "staggered" || kept.length === 0 || kept.at(-1)! - date >= interval)) kept.push(date);
    else await rm(path.join(archiveDirectory, entry.name));
  }
};

export const createNodeFolderSyncStorage = async (
  rootPath: string,
  options: NodeFolderSyncStorageOptions = {},
): Promise<NodeFolderSyncStorage> => {
  const root = path.resolve(rootPath);
  await assertNoSymlinks(path.parse(root).root, root);
  await mkdir(root, { recursive: true });
  const statePath = path.resolve(options.statePath ?? path.join(root, ".syncpeer-folder-state.json"));
  const versionRoot = path.resolve(options.versionRoot ?? path.join(root, ".stversions"));
  const trashRoot = path.resolve(options.trashRoot ?? path.join(root, ".syncpeer-trash"));
  const cache = new Map<string, { key: string; fingerprint: string; layout?: string; remoteFingerprint?: string }>();
  const writeAtomically = async (target: string, bytes: Uint8Array): Promise<void> => {
    await assertNoSymlinks(root, target);
    const identity = async () => {
      try { return metadataKey(await lstat(target)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    const before = await identity();
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.syncpeer-write-${process.pid}-${Date.now()}`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try {
      await assertNoSymlinks(root, target);
      if (await identity() !== before) throw new Error("Local file changed before replacement.");
      await rename(temporary, target);
    }
    finally { await rm(temporary, { force: true }); }
  };
  const listVersions = async (relativePath?: string) => {
    const normalized = relativePath ? normalizePath(relativePath) : "";
    const output: Array<{ archivePath: string; path: string; modifiedMs: number }> = [];
    const walk = async (directory: string, storeRoot: string): Promise<void> => {
      await assertNoSymlinks(root, directory);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute, storeRoot);
        else if (entry.isFile()) {
          const relativeArchive = normalizePath(path.relative(root, absolute));
          const original = normalizePath(path.relative(storeRoot, absolute)).replace(/\.[0-9]{17}$/, "");
          if (!normalized || original === normalized) {
            output.push({ archivePath: relativeArchive, path: original, modifiedMs: (await stat(absolute)).mtimeMs });
          }
        }
      }
    };
    await walk(versionRoot, versionRoot);
    await walk(trashRoot, trashRoot);
    return output.sort((left, right) => right.modifiedMs - left.modifiedMs);
  };
  const restoreVersion = async (archivePath: string, targetPath?: string): Promise<void> => {
    const normalizedArchive = normalizePath(archivePath);
    const absoluteArchive = path.resolve(root, normalizedArchive);
    const allowed = [path.resolve(versionRoot), path.resolve(trashRoot)]
      .some((directory) => absoluteArchive === directory || absoluteArchive.startsWith(`${directory}${path.sep}`));
    if (!allowed) throw new Error("Archive path is outside the version store.");
    await assertNoSymlinks(root, absoluteArchive);
    await stat(absoluteArchive);
    const archiveRoot = absoluteArchive.startsWith(`${versionRoot}${path.sep}`) ? versionRoot : trashRoot;
    const relativeTarget = safePath(
      targetPath ?? path.relative(archiveRoot, absoluteArchive).replace(/\.[0-9]{17}$/, ""),
    );
    if (!relativeTarget) throw new Error("Restore target must not be empty.");
    await writeAtomically(path.join(root, relativeTarget), new Uint8Array(await readFile(absoluteArchive)));
  };
  return {
    listFiles: (remote = []) => listDirectory(root, "", path.basename(statePath), remote, cache),
    readFile: async (relativePath) => {
      const target = path.join(root, safePath(relativePath));
      await assertNoSymlinks(root, target);
      return new Uint8Array(await readFile(target));
    },
    writeFile: async (relativePath, bytes, modifiedMs) => {
      const normalized = safePath(relativePath);
      const target = path.join(root, normalized);
      await writeAtomically(target, bytes);
      if (Number.isFinite(modifiedMs)) {
        const date = new Date(modifiedMs!);
        await utimes(target, date, date);
      }
    },
    removeFile: async (relativePath) => {
      const target = path.join(root, safePath(relativePath));
      await assertNoSymlinks(root, target);
      await rm(target, { force: true });
    },
    archiveFile: async (relativePath, reason, policy, nowMs) => {
      if (policy.versioning === "disabled") return null;
      const normalized = safePath(relativePath);
      const source = path.join(root, normalized);
      await assertNoSymlinks(root, source);
      try {
        await stat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const base = policy.versioning === "trash" ? trashRoot : versionRoot;
      const target = path.join(base, archiveName(normalized, nowMs));
      await assertNoSymlinks(root, target);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target, constants.COPYFILE_EXCL);
      if (policy.versioning === "simple" || policy.versioning === "staggered") {
        await pruneVersions(
          versionRoot,
          normalized,
          policy,
          nowMs,
        );
      }
      return target;
    },
    loadState: async () => {
      try {
        const parsed = JSON.parse(await readFile(statePath, "utf8")) as FolderSyncBaseline;
        return parsed?.format === 1 && parsed.files && typeof parsed.files === "object" ? parsed : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    saveState: async (state) => {
      await writeAtomically(statePath, new TextEncoder().encode(JSON.stringify(state, null, 2) + "\n"));
    },
    listVersions,
    restoreVersion,
    setSubscribed: async (subscribed) => {
      const marker = path.join(root, ".syncpeer-unsubscribed");
      if (subscribed) await rm(marker, { force: true });
      else await writeAtomically(marker, new Uint8Array());
    },
    isSubscribed: async () => {
      try { await lstat(path.join(root, ".syncpeer-unsubscribed")); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    },
    withLock: async (operation) => {
      const lockPath = path.join(root, ".syncpeer-folder-lock");
      const deadline = Date.now() + 120000;
      let lock;
      while (!lock) {
        try { lock = await open(lockPath, "wx", 0o600); await lock.writeFile(String(process.pid)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const pid = Number(await readFile(lockPath, "utf8").catch(() => ""));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                throw new Error("Folder lock belongs to a stopped process. Verify no sync is active before removing .syncpeer-folder-lock.", { cause: error });
              }
            }
          }
          if (Date.now() > deadline) throw new Error("Folder is busy; wait for the active operation to finish.", { cause: error });
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      try { return await operation(); }
      finally { await lock.close(); await rm(lockPath, { force: true }); }
    },
  };
};
