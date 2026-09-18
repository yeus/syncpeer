import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { RemoteFs } from "../core/model/remoteFs.js";
import type { CachedFileRecord, FavoriteRecord } from "../ui/browserClient.js";
import { favoriteKey, normalizePath } from "../ui/helpers.js";
import type { FileDownloadSink } from "../transfer/stream.js";
import type { DocumentFilesystem } from "./documentFilesystem.js";
import type { FolderRegistration } from "./folderRegistry.js";
import { favoriteRetryDelayMs, type FavoriteRename,
  type FavoriteSyncEntry } from "./documentFavoriteState.js";
import { planFavoriteRename, planFavoriteSync,
  resolveFavoriteRenameTarget, type FavoriteRemoteVersion } from "./favoriteSyncPlan.js";

const maxServiceUploadBytes = 32 * 1024 * 1024;
type Baseline = NonNullable<CachedFileRecord["syncBaseline"]>;

export interface FavoriteSyncResult {
  folderId: string;
  path: string;
  result: "downloaded" | "uploaded" | "unchanged" | "deleted" | "deleted-local" | "renamed"
    | "waiting" | "conflict" | "error" | "unavailable";
  message?: string;
}

interface FavoriteContext {
  documents: DocumentFilesystem;
  remoteFs: RemoteFs;
  folderId: string;
  storageId: string;
  cached: Map<string, CachedFileRecord>;
  entries: Record<string, FavoriteSyncEntry>;
  renames: FavoriteRename[];
  nowMs: number;
  persist: () => Promise<void>;
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

const documentId = (storageId: string, path: string): string => JSON.stringify([storageId, path]);

const readRemoteVersion = async (remoteFs: RemoteFs, folderId: string, path: string,
): Promise<FavoriteRemoteVersion | undefined> => {
  const parent = path.split("/").slice(0, -1).join("/");
  const entry = (await remoteFs.readDir(folderId, parent))
    .find(item => item.type === "file" && item.path === path);
  return entry ? { size: entry.size, modifiedMs: entry.modifiedMs } : undefined;
};

const setEntry = async (context: FavoriteContext, path: string, entry: FavoriteSyncEntry): Promise<void> => {
  context.entries[path] = entry;
  await context.persist();
};

const recordIssue = async (context: FavoriteContext, path: string,
  phase: "conflict" | "error", message: string): Promise<FavoriteSyncEntry> => {
  const attempts = (context.entries[path]?.attempts ?? 0) + 1;
  const entry: FavoriteSyncEntry = { phase, message, attempts, updatedAtMs: context.nowMs,
    nextAttemptMs: context.nowMs + favoriteRetryDelayMs(attempts) };
  context.entries[path] = entry;
  await context.persist();
  return entry;
};

const markSynced = (context: FavoriteContext, path: string): Promise<void> =>
  setEntry(context, path, { phase: "synced", attempts: 0, updatedAtMs: context.nowMs, nextAttemptMs: 0 });

const hashLocal = async (context: FavoriteContext, path: string): Promise<string> =>
  (await readDocument(context.documents, documentId(context.storageId, path), false)).hash;

const downloadFavorite = async (context: FavoriteContext, path: string,
  remote: FavoriteRemoteVersion, expectedLocalHash: string | null): Promise<void> => {
  await setEntry(context, path, { phase: "downloading", attempts: context.entries[path]?.attempts ?? 0,
    updatedAtMs: context.nowMs, nextAttemptMs: 0 });
  const sink = documentDownloadSink(context.documents, context.folderId, path, remote.modifiedMs, expectedLocalHash);
  try { await context.remoteFs.readFileToSink(context.folderId, path, sink); }
  catch (error) { await sink.abort(error); throw error; }
};

const uploadFavorite = async (context: FavoriteContext, path: string,
  local: { hash: string }): Promise<Baseline> => {
  const id = documentId(context.storageId, path);
  const current = await readDocument(context.documents, id, true);
  try {
    if (current.hash !== local.hash) throw new Error("Favorite changed during upload preparation; retry later.");
    const modifiedMs = context.nowMs;
    await context.remoteFs.writeFileFully(context.folderId, path, current.bytes!, { modifiedMs, waitForRemote: true });
    const baseline = { hash: current.hash, sizeBytes: current.bytes!.length, modifiedMs };
    await context.documents.setSyncBaseline(id, baseline);
    return baseline;
  } finally { current.bytes?.fill(0); }
};

const clearFavoriteRecords = async (context: FavoriteContext, path: string): Promise<void> => {
  await context.documents.clearSyncBaseline(documentId(context.storageId, path)).catch(() => {});
  delete context.entries[path];
};

const runDownload = async (context: FavoriteContext, path: string,
  remote: FavoriteRemoteVersion, expectedLocalHash: string | null): Promise<FavoriteSyncResult> => {
  await downloadFavorite(context, path, remote, expectedLocalHash);
  await markSynced(context, path);
  return { folderId: context.folderId, path, result: "downloaded" };
};

const runUpload = async (context: FavoriteContext, path: string, local: { hash: string }): Promise<FavoriteSyncResult> => {
  await setEntry(context, path, { phase: "uploading", attempts: context.entries[path]?.attempts ?? 0,
    updatedAtMs: context.nowMs, nextAttemptMs: 0 });
  await uploadFavorite(context, path, local);
  await markSynced(context, path);
  return { folderId: context.folderId, path, result: "uploaded" };
};

const runDeleteRemote = async (context: FavoriteContext, path: string): Promise<FavoriteSyncResult> => {
  await setEntry(context, path, { phase: "deleting-remote", attempts: context.entries[path]?.attempts ?? 0,
    updatedAtMs: context.nowMs, nextAttemptMs: 0 });
  await context.remoteFs.deleteFile(context.folderId, path, { modifiedMs: context.nowMs, waitForRemote: true });
  await clearFavoriteRecords(context, path);
  await markSynced(context, path);
  return { folderId: context.folderId, path, result: "deleted" };
};

const runDeleteLocal = async (context: FavoriteContext, path: string): Promise<FavoriteSyncResult> => {
  await setEntry(context, path, { phase: "deleting-local", attempts: context.entries[path]?.attempts ?? 0,
    updatedAtMs: context.nowMs, nextAttemptMs: 0 });
  await context.documents.remove(documentId(context.storageId, path));
  await clearFavoriteRecords(context, path);
  await markSynced(context, path);
  return { folderId: context.folderId, path, result: "deleted-local" };
};

const updateFavoritePath = async (context: FavoriteContext, from: string, to: string): Promise<void> => {
  const settings = await context.documents.profileSettings();
  const folderSettings = settings.folders[context.folderId];
  if (!folderSettings) return;
  const favorites = folderSettings.favorites.map(item => item.kind === "file" && item.path === from
    ? { ...item, path: to, name: to.split("/").at(-1)!, key: favoriteKey(context.folderId, to, "file") }
    : item);
  settings.folders = { ...settings.folders, [context.folderId]: { ...folderSettings, favorites } };
  await context.documents.saveProfileSettings(settings);
};

const runRename = async (context: FavoriteContext, from: string, chain: string[],
  to: string, local: { size: number; hash: string }, baseline: Baseline | undefined): Promise<FavoriteSyncResult> => {
  const remoteSource = await readRemoteVersion(context.remoteFs, context.folderId, from);
  const remoteTarget = await readRemoteVersion(context.remoteFs, context.folderId, to);
  const resumeTarget = context.entries[to]?.phase === "uploading";
  const action = planFavoriteRename({ local, remoteSource, remoteTarget, baseline, resumeTarget });
  if (action.kind === "conflict") {
    const entry = await recordIssue(context, from, "conflict", action.message);
    return { folderId: context.folderId, path: from, result: "conflict", message: entry.message };
  }
  await setEntry(context, to, { phase: "uploading", attempts: 0, updatedAtMs: context.nowMs, nextAttemptMs: 0 });
  await uploadFavorite(context, to, local);
  if (action.removeRemote) {
    await context.remoteFs.deleteFile(context.folderId, from, { modifiedMs: context.nowMs, waitForRemote: true });
  }
  await context.documents.clearSyncBaseline(documentId(context.storageId, from)).catch(() => {});
  await updateFavoritePath(context, from, to);
  await context.documents.clearFavoriteRenames(context.folderId, chain);
  context.renames = context.renames.filter(rename => !chain.includes(rename.from));
  delete context.entries[from];
  await markSynced(context, to);
  return { folderId: context.folderId, path: from, result: "renamed" };
};

const planAndRunFavorite = async (context: FavoriteContext, favorite: FavoriteRecord): Promise<FavoriteSyncResult> => {
  const path = normalizePath(favorite.path), id = documentId(context.storageId, path);
  const baseline = await context.documents.syncBaseline(id);
  const cached = context.cached.get(path);
  const local = cached ? { size: cached.sizeBytes, hash: await hashLocal(context, path) } : undefined;
  const resolved = resolveFavoriteRenameTarget(context.renames, path);
  if (resolved && !local) {
    const target = context.cached.get(resolved.target);
    if (target) {
      const targetHash = await hashLocal(context, resolved.target);
      return runRename(context, path, resolved.chain, resolved.target,
        { size: target.sizeBytes, hash: targetHash }, baseline);
    }
    await context.documents.clearFavoriteRenames(context.folderId, resolved.chain);
    context.renames = context.renames.filter(rename => !resolved.chain.includes(rename.from));
  }
  const completed = context.renames.find(rename => rename.to === path);
  if (completed && local) {
    await context.documents.clearFavoriteRenames(context.folderId, [completed.from, completed.to]);
    context.renames = context.renames.filter(rename => rename.from !== completed.from);
  }
  const remote = await readRemoteVersion(context.remoteFs, context.folderId, path);
  const action = planFavoriteSync({ local, remote, baseline });
  switch (action.kind) {
    case "unchanged":
      if (context.entries[path]?.phase !== "synced") await markSynced(context, path);
      return { folderId: context.folderId, path, result: "unchanged" };
    case "download": return runDownload(context, path, remote!, action.expectedLocalHash);
    case "upload": return runUpload(context, path, local!);
    case "delete-remote": return runDeleteRemote(context, path);
    case "delete-local": return runDeleteLocal(context, path);
    default: {
      const entry = await recordIssue(context, path, "conflict", action.message);
      return { folderId: context.folderId, path, result: "conflict", message: entry.message };
    }
  }
};

const runFavorite = async (context: FavoriteContext, favorite: FavoriteRecord): Promise<FavoriteSyncResult> => {
  const path = normalizePath(favorite.path);
  const pending = context.entries[path];
  if (pending && pending.nextAttemptMs > context.nowMs) {
    return { folderId: context.folderId, path, result: pending.phase === "conflict" ? "conflict" : "error",
      ...(pending.message === undefined ? {} : { message: pending.message }) };
  }
  try {
    return await planAndRunFavorite(context, favorite);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Favorite sync failed.";
    await recordIssue(context, path, "error", message);
    return { folderId: context.folderId, path, result: "error", message };
  }
};

const pruneEntries = (entries: Record<string, FavoriteSyncEntry>, favorites: readonly FavoriteRecord[],
  renames: readonly FavoriteRename[]): Record<string, FavoriteSyncEntry> => {
  const retained = new Set<string>();
  for (const favorite of favorites) {
    const path = normalizePath(favorite.path);
    retained.add(path);
    const resolved = resolveFavoriteRenameTarget(renames, path);
    if (resolved) retained.add(resolved.target);
  }
  return Object.fromEntries(Object.entries(entries).filter(([path]) => retained.has(path)));
};

const favoriteFolderResults = (folderId: string, favorites: readonly FavoriteRecord[],
  result: FavoriteSyncResult["result"], message: string): FavoriteSyncResult[] =>
  favorites.map(favorite => ({ folderId, path: normalizePath(favorite.path), result, message }));

const syncFolderFavorites = async (args: {
  documents: DocumentFilesystem;
  remoteFs: RemoteFs;
  folder: FolderRegistration;
  favorites: FavoriteRecord[];
  nowMs: number;
}): Promise<FavoriteSyncResult[]> => {
  const { documents, remoteFs, folder, favorites, nowMs } = args;
  let indexState = await remoteFs.getFolderSyncState(folder.id);
  if (indexState?.indexReceived !== true) {
    await remoteFs.waitForFolderIndex(folder.id, 6000, 120);
    indexState = await remoteFs.getFolderSyncState(folder.id);
  }
  if (indexState?.indexReceived !== true) {
    return favoriteFolderResults(folder.id, favorites, "waiting", "Folder index is still being received.");
  }
  let cached: CachedFileRecord[], state;
  try {
    cached = await documents.cachedFiles(folder.id);
    state = await documents.favoriteSyncState(folder.id);
  } catch (error) {
    return favoriteFolderResults(folder.id, favorites, "unavailable",
      error instanceof Error ? error.message : "Document folder is unavailable.");
  }
  const context: FavoriteContext = { documents, remoteFs, folderId: folder.id, storageId: folder.storageId,
    cached: new Map(cached.map(file => [file.path, file])), entries: state.entries, renames: state.renames,
    nowMs, persist: async () => { await documents.saveFavoriteSyncEntries(folder.id, context.entries); } };
  const results: FavoriteSyncResult[] = [];
  for (const favorite of favorites) results.push(await runFavorite(context, favorite));
  const retained = pruneEntries(context.entries, favorites, context.renames);
  if (Object.keys(retained).length !== Object.keys(context.entries).length) {
    context.entries = retained;
    await context.persist();
  }
  return results;
};

export async function syncServiceFileFavorites(
  documents: DocumentFilesystem,
  remoteFs: RemoteFs,
  options: { nowMs?: number } = {},
): Promise<{ skipped?: "locked"; results: FavoriteSyncResult[] }> {
  const nowMs = options.nowMs ?? Date.now();
  const status = await documents.status();
  if (status.vault.phase !== "unlocked") return { skipped: "locked", results: [] };
  const settings = await documents.profileSettings();
  const registered = new Map(status.folders.filter(folder => folder.downloads).map(folder => [folder.id, folder]));
  const folderInfos = new Map((await remoteFs.listFolders()).map(folder => [folder.id, folder]));
  const results: FavoriteSyncResult[] = [];
  for (const [folderId, folderSettings] of Object.entries(settings.folders)) {
    const folder = registered.get(folderId);
    const favorites = folderSettings.favorites.filter(item => item.kind === "file");
    if (!folder || folderSettings.paused || favorites.length === 0) continue;
    const info = folderInfos.get(folderId);
    if (!info || info.needsPassword || info.passwordError || info.stopReason) {
      results.push(...favoriteFolderResults(folderId, favorites, "unavailable",
        "Folder metadata is unavailable for synchronization."));
      continue;
    }
    results.push(...await syncFolderFavorites({ documents, remoteFs, folder, favorites, nowMs }));
  }
  return { results };
}
