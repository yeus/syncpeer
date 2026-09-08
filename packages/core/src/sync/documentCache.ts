import { sha256 } from "@noble/hashes/sha2.js";
import type { CachedFileRecord, SyncpeerPlatformAdapter } from "../ui/browserClient.js";
import type { FileDownloadSink } from "../transfer/stream.js";
import { sameDownloadMetadata } from "../transfer/stream.js";
import type { FolderRegistration } from "./folderRegistry.js";
import { assertReplicaPath } from "./replicaPaths.js";

/** Route opted-in cache folders to the service owner, never mirror two writable copies.
 * Migration is explicit, verified, and retains original storage as a backup.
 */
export function createDocumentCache(options: {
  enabled: () => boolean;
  request: <T>(input: Record<string, unknown>) => Promise<T>;
  legacy: SyncpeerPlatformAdapter;
  openLegacySource: (file: CachedFileRecord) => Promise<{
    size: number; readRange: (offset: number, size: number) => Promise<Uint8Array>;
    verify: () => Promise<void>; close: () => Promise<void>;
  }>;
  show: (id: string) => Promise<void>;
}) {
  const active = new Map<string, number>(), migrating = new Set<string>();
  const registrations = async () => options.enabled()
    ? (await options.request<{ folders: FolderRegistration[] }>({ operation: "cacheRegistrations" })).folders : [];
  const owner = async (folderId: string) => {
    if (migrating.has(folderId)) throw new Error("This folder is being moved to encrypted document storage. Retry when migration finishes.");
    return (await registrations()).find(folder => folder.id === folderId && folder.downloads);
  };
  const documentId = (folder: FolderRegistration, path: string) => JSON.stringify([folder.storageId, path]);
  const track = (folderId: string) => {
    if (migrating.has(folderId)) throw new Error("Folder migration is in progress.");
    active.set(folderId, (active.get(folderId) ?? 0) + 1);
    let released = false;
    return () => { if (!released) { released = true; active.set(folderId, active.get(folderId)! - 1); } };
  };
  const request = options.request;
  const source = async (id: string) => {
    const handle = await request<number>({ operation: "open", id, mode: "r" });
    return { size: await request<number>({ operation: "size", handle }),
      readRange: async (offset: number, size: number) => new Uint8Array(await request<number[]>({ operation: "read", handle, offset, size })),
      close: () => request<void>({ operation: "release", handle }) };
  };
  const sink = (folderId: string, path: string, modifiedMs = Date.now(), expectedLocalHash?: string | null): FileDownloadSink => {
    let handle: number | undefined;
    let metadata: Parameters<FileDownloadSink["begin"]>[0] | undefined;
    const digestRanges = async (source: "cached" | "partial", ranges: readonly { offset: number; size: number }[]) => {
      const result: Array<{ offset: number; size: number; hash: Uint8Array }> = [];
      for (let offset = 0; offset < ranges.length; offset += 256) {
        const batch = await request<Array<{ offset: number; size: number; hash: number[] }>>({
          operation: "digestRanges", handle, source, ranges: ranges.slice(offset, offset + 256),
        });
        result.push(...batch.map(range => ({ ...range, hash: new Uint8Array(range.hash) })));
      }
      return result;
    };
    return {
      digestCachedRanges: ranges => digestRanges("cached", ranges),
      digestPartialRanges: ranges => digestRanges("partial", ranges),
      copyCachedRanges: async ranges => {
        for (let offset = 0; offset < ranges.length; offset += 256) {
          await request({ operation: "copyRanges", handle, ranges: ranges.slice(offset, offset + 256) });
        }
      },
      begin: async value => {
        if (handle !== undefined) {
          if (!metadata || !sameDownloadMetadata(metadata, value)) throw new Error("Download metadata changed.");
          return;
        }
        handle = await request<number>({ operation: "beginDownload", folderId, path, size: value.sizeBytes, modifiedMs, expectedLocalHash });
        metadata = value;
      },
      write: async (offset, bytes) => {
        if (handle === undefined) throw new Error("Download has not started.");
        for (let done = 0; done < bytes.length; done += 131072) {
          await request({ operation: "write", handle, offset: offset + done, bytes: Array.from(bytes.subarray(done, done + 131072)) });
        }
      },
      digestFile: () => request<string>({ operation: "digest", handle }),
      commit: async () => {
        if (handle === undefined) throw new Error("Download has not started.");
        await request({ operation: "finishDownload", handle }); handle = undefined;
      },
      abort: async () => {
        if (handle !== undefined) { await request({ operation: "release", handle, abort: true }); handle = undefined; }
      },
    };
  };
  const createFileDownloadSink: NonNullable<SyncpeerPlatformAdapter["createFileDownloadSink"]> = async args => {
    const release = track(args.folderId);
    let destination: FileDownloadSink;
    try {
      const folder = await owner(args.folderId);
      if (folder) destination = sink(args.folderId, args.path, args.modifiedMs, args.expectedLocalHash);
      else {
        if (!options.legacy.createFileDownloadSink) throw new Error("Download storage is unavailable.");
        destination = await options.legacy.createFileDownloadSink(args);
      }
    } catch (error) { release(); throw error; }
    return { ...destination,
      commit: async () => { await destination.commit(); release(); },
      abort: async error => { try { await destination.abort(error); } finally { release(); } },
      ...(destination.suspend ? { suspend: async () => { try { await destination.suspend!(); } finally { release(); } } } : {}),
    };
  };
  const listCachedFiles = async () => {
    const attached = (await registrations()).filter(folder => folder.downloads);
    const legacy = await options.legacy.listCachedFiles?.() ?? [];
    if (!attached.length) return legacy;
    return legacy.filter(file => !attached.some(folder => folder.id === file.folderId))
      .concat(await request<CachedFileRecord[]>({ operation: "cachedFiles" }));
  };
  const show = async (folderId: string, path: string, parent: boolean) => {
    const folder = await owner(folderId);
    if (!folder) {
      const method = parent ? options.legacy.openCachedFileDirectory : options.legacy.openCachedFile;
      if (!method) throw new Error("Opening cached documents is unavailable.");
      await method(folderId, path); return;
    }
    await options.show(documentId(folder, parent ? path.split("/").slice(0, -1).join("/") : path));
  };
  const platformAdapter: SyncpeerPlatformAdapter = { ...options.legacy, createFileDownloadSink, listCachedFiles,
    acknowledgeCachedSync: async (folderId, path, baseline) => {
      const folder = await owner(folderId);
      if (!folder) return false;
      await request({ operation: "setSyncBaseline", id: documentId(folder, path), ...baseline });
      return true;
    },
    cacheFile: async (folderId, path, name, bytes, modifiedMs) => {
      const release = track(folderId);
      try {
        if (!await owner(folderId)) {
          if (!options.legacy.cacheFile) throw new Error("Cache is unavailable.");
          await options.legacy.cacheFile(folderId, path, name, bytes, modifiedMs); return;
        }
        const target = sink(folderId, path, modifiedMs);
        try { await target.begin({ folderId, path, sizeBytes: bytes.length, encrypted: false });
          await target.write(0, bytes); await target.commit(); }
        catch (error) { await target.abort(error); throw error; }
      } finally { release(); }
    },
    getCachedStatuses: async (folderId, paths) => {
      if (!await owner(folderId)) return await options.legacy.getCachedStatuses?.(folderId, paths) ?? [];
      return request({ operation: "cachedStatuses", folderId, paths });
    },
    readBinaryFile: async path => {
      if (!path.startsWith("syncpeer-document:")) {
        if (!options.legacy.readBinaryFile) throw new Error("File reads are unavailable.");
        return options.legacy.readBinaryFile(path);
      }
      const file = await source(path.slice("syncpeer-document:".length));
      try {
        const bytes = new Uint8Array(file.size);
        for (let offset = 0; offset < file.size; offset += 131072) {
          const chunk = await file.readRange(offset, Math.min(131072, file.size - offset));
          try { bytes.set(chunk, offset); } finally { chunk.fill(0); }
        }
        return bytes;
      } finally { await file.close(); }
    },
    openCachedFile: (folderId, path) => show(folderId, path, false),
    openCachedFileDirectory: (folderId, path) => show(folderId, path, true),
    openCachedDirectory: async (folderId, path) => {
      const folder = await owner(folderId);
      if (folder) await options.show(documentId(folder, path));
      else await options.legacy.openCachedDirectory?.(folderId, path);
    },
    removeCachedFile: async (folderId, path) => {
      const folder = await owner(folderId);
      return folder ? request<boolean>({ operation: "remove", id: documentId(folder, path) })
        : await options.legacy.removeCachedFile?.(folderId, path) ?? false;
    },
    clearCache: async () => {
      if ((await registrations()).some(folder => folder.downloads)) throw new Error("Encrypted documents may contain local edits. Remove individual downloads instead; preserved migration backups are not cleared automatically.");
      await options.legacy.clearCache?.();
    },
  };
  const connectFolder = async (folder: { id: string; label: string; password?: string }) => {
    if (!options.enabled()) throw new Error("Document storage is unavailable.");
    if (migrating.has(folder.id) || active.get(folder.id)) throw new Error("Wait for this folder’s transfers to finish before moving it.");
    migrating.add(folder.id);
    try {
      let registered = (await registrations()).find(value => value.id === folder.id);
      if (registered?.downloads) return;
      if (!registered) {
        await request({ operation: "register", ...folder });
        registered = (await registrations()).find(value => value.id === folder.id)!;
      }
      const files = (await options.legacy.listCachedFiles?.() ?? []).filter(file => file.folderId === folder.id);
      const existing = await request<CachedFileRecord[]>({ operation: "folderFiles", folderId: folder.id });
      for (const file of files) {
        assertReplicaPath(file.path);
        const original = await options.openLegacySource(file);
        const target = sink(folder.id, file.path, file.modifiedMs ?? file.cachedAtMs,
          existing.some(value => value.path === file.path) ? undefined : null);
        try {
          if (original.size !== file.sizeBytes) throw new Error("Cached file changed. Refresh downloads before migration.");
          await target.begin({ folderId: folder.id, path: file.path, sizeBytes: original.size, encrypted: false });
          const hash = sha256.create();
          for (let offset = 0; offset < original.size; offset += 131072) {
            const data = await original.readRange(offset, Math.min(131072, original.size - offset));
            try { hash.update(data); await target.write(offset, data); } finally { data.fill(0); }
          }
          const expected = [...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (await target.digestFile!() !== expected) throw new Error("Document migration verification failed.");
          await original.verify();
          if (existing.some(value => value.path === file.path)) {
            const current = await source(documentId(registered, file.path)), currentHash = sha256.create();
            try {
              for (let offset = 0; offset < current.size; offset += 131072) {
                const data = await current.readRange(offset, Math.min(131072, current.size - offset));
                try { currentHash.update(data); } finally { data.fill(0); }
              }
              if (current.size !== original.size || [...currentHash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("") !== expected) {
                throw new Error("A document already contains different data. Migration left both copies unchanged.");
              }
            } finally { await current.close(); }
            await request({ operation: "setSyncBaseline", id: documentId(registered, file.path), hash: expected,
              sizeBytes: original.size, modifiedMs: file.modifiedMs ?? file.cachedAtMs });
            await target.abort(new Error("Already imported"));
          } else await target.commit();
        } catch (error) { await target.abort(error); throw error; }
        finally { await original.close(); }
      }
      await request({ operation: "attachDownloads", id: folder.id });
    } finally { migrating.delete(folder.id); }
  };
  return { platformAdapter, connectFolder };
}
