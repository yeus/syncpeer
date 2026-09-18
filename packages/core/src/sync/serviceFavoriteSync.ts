import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { RemoteFs } from "../core/model/remoteFs.js";
import type { CachedFileRecord } from "../ui/browserClient.js";
import { normalizePath } from "../ui/helpers.js";
import type { FileDownloadSink } from "../transfer/stream.js";
import type { DocumentFilesystem } from "./documentFilesystem.js";

const maxServiceUploadBytes = 32 * 1024 * 1024;
type Baseline = NonNullable<CachedFileRecord["syncBaseline"]>;

export async function reconcileServiceFavorite(input: {
  folderId: string;
  path: string;
  remote: { size: number; modifiedMs: number };
  local?: Pick<CachedFileRecord, "sizeBytes" | "syncBaseline">;
  hashLocal: () => Promise<string>;
  readLocal: () => Promise<Uint8Array>;
  download: (expectedLocalHash: string | null) => Promise<void>;
  upload: (bytes: Uint8Array, modifiedMs: number) => Promise<void>;
  acknowledge: (baseline: Baseline) => Promise<void>;
}): Promise<"downloaded" | "uploaded" | "unchanged"> {
  if (!input.local) { await input.download(null); return "downloaded"; }
  const baseline = input.local.syncBaseline;
  if (!baseline) throw new Error("Favorite has no verified sync baseline; resolve it in the app.");
  const localHash = await input.hashLocal();
  const localChanged = localHash !== baseline.hash;
  const remoteChanged = input.remote.size !== baseline.sizeBytes || input.remote.modifiedMs !== baseline.modifiedMs;
  if (localChanged && remoteChanged) throw new Error("Favorite conflict: local and peer copies both changed.");
  if (remoteChanged) { await input.download(localHash); return "downloaded"; }
  if (!localChanged) return "unchanged";
  if (input.local.sizeBytes > maxServiceUploadBytes) throw new Error("Favorite upload exceeds the service limit; local edit was preserved.");
  const bytes = await input.readLocal();
  try {
    if (bytesToHex(sha256(bytes)) !== localHash) throw new Error("Favorite changed during upload preparation; retry later.");
    const modifiedMs = Date.now();
    await input.upload(bytes, modifiedMs);
    await input.acknowledge({ hash: localHash, sizeBytes: bytes.length, modifiedMs });
    return "uploaded";
  } finally { bytes.fill(0); }
}

async function readDocument(documents: DocumentFilesystem, id: string, collect: boolean) {
  const handle = await documents.open(id, "r");
  try {
    const size = await documents.size(handle), hash = sha256.create();
    if (collect && size > maxServiceUploadBytes) throw new Error("Favorite upload exceeds the service limit; local edit was preserved.");
    const bytes = collect ? new Uint8Array(size) : undefined;
    for (let offset = 0; offset < size; offset += 131072) {
      const chunk = await documents.read(handle, offset, Math.min(131072, size - offset));
      try { hash.update(chunk); bytes?.set(chunk, offset); } finally { chunk.fill(0); }
    }
    return { hash: bytesToHex(hash.digest()), bytes };
  } finally { await documents.release(handle); }
}

function documentDownloadSink(documents: DocumentFilesystem, folderId: string, path: string,
  modifiedMs: number, expectedLocalHash: string | null): FileDownloadSink {
  let handle: number | undefined;
  return {
    begin: async metadata => {
      handle = await documents.beginDownload(folderId, path, metadata.sizeBytes, modifiedMs,
        expectedLocalHash, metadata);
    },
    write: async (offset, bytes) => {
      if (handle === undefined) throw new Error("Favorite download has not started.");
      for (let done = 0; done < bytes.length; done += 131072) {
        await documents.write(handle, offset + done, bytes.subarray(done, done + 131072));
      }
    },
    commit: async () => {
      if (handle === undefined) throw new Error("Favorite download has not started.");
      await documents.finishDownload(handle); handle = undefined;
    },
    abort: async () => {
      if (handle !== undefined) { await documents.release(handle, true); handle = undefined; }
    },
  };
}

/** The Android service owns this scan; only direct file favorites are in the first milestone. */
export async function syncServiceFileFavorites(documents: DocumentFilesystem, remoteFs: RemoteFs) {
  const status = await documents.status();
  if (status.vault.phase !== "unlocked") return { skipped: "locked" as const, results: [] };
  const settings = await documents.profileSettings();
  const registered = new Map(status.folders.filter(folder => folder.downloads).map(folder => [folder.id, folder]));
  const cached = new Map((await documents.cachedFiles()).map(file => [`${file.folderId}:${file.path}`, file]));
  const results: Array<{ folderId: string; path: string; result: string }> = [];
  for (const [folderId, folderSettings] of Object.entries(settings.folders)) {
    const folder = registered.get(folderId);
    if (!folder || folderSettings.paused) continue;
    for (const favorite of folderSettings.favorites.filter(item => item.kind === "file")) {
      const path = normalizePath(favorite.path), parent = path.split("/").slice(0, -1).join("/");
      const entry = (await remoteFs.readDir(folderId, parent)).find(item => item.type === "file" && item.path === path);
      if (!entry) continue;
      const id = JSON.stringify([folder.storageId, path]);
      const local = cached.get(`${folderId}:${path}`);
      try {
        const result = await reconcileServiceFavorite({ folderId, path,
          remote: { size: entry.size, modifiedMs: entry.modifiedMs }, local,
          hashLocal: async () => (await readDocument(documents, id, false)).hash,
          readLocal: async () => (await readDocument(documents, id, true)).bytes!,
          download: async expectedLocalHash => {
            const sink = documentDownloadSink(documents, folderId, path, entry.modifiedMs, expectedLocalHash);
            try { await remoteFs.readFileToSink(folderId, path, sink); }
            catch (error) { await sink.abort(error); throw error; }
          },
          upload: (bytes, modifiedMs) => remoteFs.writeFileFully(folderId, path, bytes, { modifiedMs }),
          acknowledge: baseline => documents.setSyncBaseline(id, baseline),
        });
        results.push({ folderId, path, result });
      } catch (error) {
        results.push({ folderId, path, result: error instanceof Error ? error.message : "Favorite sync failed." });
      }
    }
  }
  return { results };
}
