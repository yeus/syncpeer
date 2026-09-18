import type { ReplicaEntry } from "./replicaIndex.js";
import type { FileDownloadSink } from "../transfer/stream.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

/** Byte-storage command contract; no keys or plaintext metadata cross this boundary. */
export type NativeFilesystemRequest =
  | { operation: "register"; rootPath: string; metadataPrefixes: string[] }
  | { operation: "release"; rootId: number }
  | { operation: "backupMetadata"; rootId: number }
  | { operation: "initializeReplica" | "checkHealth" | "acquire" | "unlock"; rootId: number }
  | { operation: "list"; rootId: number; path: string }
  | { operation: "stat"; rootId: number; path: string }
  | { operation: "read"; rootId: number; path: string; offset: number; size: number }
  | { operation: "begin"; rootId: number; path: string; size: number }
  | { operation: "write"; writerId: number; offset: number; bytes: number[] }
  | { operation: "commit"; writerId: number; modifiedMs?: number }
  | { operation: "abort"; writerId: number }
  | { operation: "makeDirectory"; rootId: number; path: string }
  | { operation: "remove"; rootId: number; path: string; directory: boolean }
  | { operation: "copy"; rootId: number; source: string; target: string }
  | { operation: "flush"; rootId: number; paths: string[] };

const unsigned = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const handle = (value: unknown): number => {
  if (!unsigned(value) || value === 0) throw new Error("Invalid native storage handle.");
  return value;
};

const nativeEntry = (value: unknown, parent: string): ReplicaEntry => {
  if (!value || typeof value !== "object") throw new Error("Invalid native directory entry.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.includes("/") ||
      (raw.kind !== "file" && raw.kind !== "directory") || !unsigned(raw.size) || !unsigned(raw.modifiedMs) ||
      typeof raw.revision !== "string" || !raw.revision) throw new Error("Invalid or unsupported native directory entry.");
  assertReplicaPath(raw.name);
  return { path: parent ? `${parent}/${raw.name}` : raw.name, type: raw.kind,
    size: raw.kind === "directory" ? 0 : raw.size, modifiedMs: raw.modifiedMs, revision: raw.revision };
};

/** Adapt native handles to the shared core storage contract. */
export async function createNativeFilesystem(
  request: (request: NativeFilesystemRequest) => Promise<unknown>,
  rootPath: string,
) {
  // Core declares private metadata; native storage packs the opaque bytes into SQLite.
  // File content, scratch data, and archived versions continue to use file storage.
  const rootId = handle(await request({ operation: "register", rootPath, metadataPrefixes: [
    ".syncpeer-vault-record", ".syncpeer-document-folders", ".syncpeer-replica-index",
    ".syncpeer-ciphertext-index", ".syncpeer-baseline-", ".syncpeer-directory-catalog", ".syncpeer-cache-access",
    ".syncpeer-favorite-sync",
  ] }));
  const active = new Set<Promise<unknown>>();
  let closing = false;
  let closeTask: Promise<void> | undefined;
  let transaction = Promise.resolve();
  const track = <T>(task: Promise<T>) => {
    active.add(task);
    void task.then(() => active.delete(task), () => active.delete(task));
    return task;
  };
  const run = (command: NativeFilesystemRequest) => {
    if (closing) return Promise.reject(new Error("Native filesystem is closed."));
    return track(Promise.resolve().then(() => request(command)));
  };
  const close = () => {
    closing = true;
    closeTask ??= (async () => {
      await Promise.allSettled([...active]);
      await request({ operation: "release", rootId });
    })().catch(error => { closeTask = undefined; throw error; });
    return closeTask;
  };
  const listDirectory = async (parent: string) => {
    const children = await run({ operation: "list", rootId, path: parent });
    if (!Array.isArray(children)) throw new Error("Invalid native directory listing.");
    const seen = new Set<string>();
    return children.map(raw => {
      const entry = nativeEntry(raw, parent);
      if (seen.has(entry.path)) throw new Error("Duplicate native directory entry.");
      seen.add(entry.path);
      return entry;
    });
  };
  return {
    close,
    backupMetadata: async () => {
      const filename = await run({ operation: "backupMetadata", rootId });
      if (typeof filename !== "string" || !filename) throw new Error("Invalid metadata backup response.");
      return filename;
    },
    listDirectory: async (path: string) => {
      if (path) assertReplicaPath(path);
      return listDirectory(path);
    },
    initializeReplica: async () => { await run({ operation: "initializeReplica", rootId }); },
    checkHealth: async () => { await run({ operation: "checkHealth", rootId }); },
    withLock: <T>(operation: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new Error("Native filesystem is closed."));
      const task = transaction.then(async () => {
        await run({ operation: "acquire", rootId });
        try { return await operation(); }
        finally { await request({ operation: "unlock", rootId }); }
      });
      transaction = task.then(() => {}, () => {});
      return track(task);
    },
    stat: async (path: string) => {
      assertReplicaPath(path);
      const raw = await run({ operation: "stat", rootId, path });
      if (raw === null) return null;
      const entry = nativeEntry(raw, path.slice(0, Math.max(0, path.lastIndexOf("/"))));
      if (entry.path !== path) throw new Error("Native stat returned a different path.");
      return entry;
    },
    listEntries: async (): Promise<ReplicaEntry[]> => {
      const directories = [""];
      const entries: ReplicaEntry[] = [];
      while (directories.length) {
        const parent = directories.pop()!;
        for (const entry of await listDirectory(parent)) {
          if (isInternalReplicaPath(entry.path)) continue;
          entries.push(entry);
          if (entry.type === "directory") directories.push(entry.path);
        }
      }
      return entries.sort((a, b) => a.path.localeCompare(b.path));
    },
    readRange: async (path: string, offset: number, size: number): Promise<Uint8Array> => {
      assertReplicaPath(path);
      if (!unsigned(offset) || !unsigned(size) || size > 131072 || !unsigned(offset + size)) throw new Error("Invalid native read range.");
      if (closing) throw new Error("Native filesystem is closed.");
      if (!size) return new Uint8Array();
      const bytes = await run({ operation: "read", rootId, path, offset, size });
      if (!Array.isArray(bytes) || bytes.length !== size || bytes.some(value => !unsigned(value) || value > 255)) throw new Error("Invalid native file bytes.");
      return new Uint8Array(bytes);
    },
    createSink: async (path: string, size: number, modifiedMs?: number): Promise<Pick<FileDownloadSink, "write" | "commit" | "abort">> => {
      assertReplicaPath(path);
      if (!unsigned(size) || (modifiedMs !== undefined && !unsigned(modifiedMs))) throw new Error("Invalid native file metadata.");
      const writerId = handle(await run({ operation: "begin", rootId, path, size }));
      let ended = false;
      return {
        write: async (offset: number, bytes: Uint8Array) => {
          if (ended) throw new Error("Native file writer is closed.");
          if (!unsigned(offset) || bytes.length > 131072 || offset > size || bytes.length > size - offset) throw new Error("Invalid native write range.");
          await run({ operation: "write", writerId, offset, bytes: Array.from(bytes) });
        },
        commit: async () => {
          if (ended) throw new Error("Native file writer is closed.");
          await run({ operation: "commit", writerId, modifiedMs });
          ended = true;
        },
        abort: async () => {
          if (ended) return;
          if (closing) await close();
          else await run({ operation: "abort", writerId });
          ended = true;
        },
      };
    },
    makeDirectory: async (path: string) => { assertReplicaPath(path); await run({ operation: "makeDirectory", rootId, path }); },
    remove: async (path: string, directory: boolean) => { assertReplicaPath(path); await run({ operation: "remove", rootId, path, directory }); },
    copy: async (source: string, target: string) => {
      assertReplicaPath(source); assertReplicaPath(target);
      await run({ operation: "copy", rootId, source, target });
    },
    flushChanges: async (paths: string[]) => {
      paths.forEach(assertReplicaPath);
      await run({ operation: "flush", rootId, paths });
    },
  };
}
