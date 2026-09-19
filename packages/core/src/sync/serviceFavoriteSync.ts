import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { RemoteFs } from "../core/model/remoteFs.js";
import type { CachedFileRecord, FavoriteRecord } from "../ui/browserClient.js";
import { favoriteKey, normalizePath } from "../ui/helpers.js";
import type { FileDownloadSink, FileUploadSource } from "../transfer/stream.js";
import type { DocumentFilesystem } from "./documentFilesystem.js";
import type { FolderRegistration } from "./folderRegistry.js";
import { favoriteRetryDelayMs, type FavoriteRename,
  type FavoriteSyncEntry } from "./documentFavoriteState.js";
import { applyFavoriteRename, planFavoriteCandidates, planFavoriteRename,
  planFavoriteRenames, planFavoriteSync, type FavoriteCandidate,
  type FavoriteRemoteVersion } from "./favoriteSyncPlan.js";
import { collectFavoriteFiles, type FavoriteExclusion } from "../ui/favoriteSelection.js";
import type { FileEntry } from "../core/model/remoteFs.js";

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

/** Hashes one document without materializing it. */
async function hashDocument(documents: DocumentFilesystem, id: string): Promise<string> {
  const handle = await documents.open(id, "r");
  try {
    const size = await documents.size(handle), hash = sha256.create();
    for (let offset = 0; offset < size; offset += 131072) {
      const chunk = await documents.read(handle, offset, Math.min(131072, size - offset));
      try { hash.update(chunk); } finally { chunk.fill(0); }
    }
    return bytesToHex(hash.digest());
  } finally { await documents.release(handle); }
}

/** Random-access source over an open document handle; the caller closes it. */
async function documentUploadSource(documents: DocumentFilesystem, id: string): Promise<FileUploadSource> {
  const handle = await documents.open(id, "r");
  let released = false;
  return {
    size: await documents.size(handle),
    read: (offset, size) => documents.read(handle, offset, size),
    close: async () => {
      if (released) return;
      released = true;
      await documents.release(handle);
    },
  };
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
  hashDocument(context.documents, documentId(context.storageId, path));

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
  const source = await documentUploadSource(context.documents, id);
  const modifiedMs = context.nowMs;
  try {
    await context.remoteFs.writeFileStream(context.folderId, path, source,
      { modifiedMs, waitForRemote: true, expectedHash: local.hash });
    const baseline = { hash: local.hash, sizeBytes: source.size, modifiedMs };
    await context.documents.setSyncBaseline(id, baseline);
    return baseline;
  } finally { await source.close?.(); }
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

const updateFavoritePaths = async (context: FavoriteContext, renames: readonly FavoriteRename[]): Promise<void> => {
  const settings = await context.documents.profileSettings();
  const folderSettings = settings.folders[context.folderId];
  if (!folderSettings) return;
  const favorites = folderSettings.favorites.map(item => {
    const resolved = applyFavoriteRename(renames, normalizePath(item.path));
    if (!resolved) return item;
    const name = resolved.target.split("/").at(-1)!;
    return { ...item, path: resolved.target, name, key: favoriteKey(context.folderId, resolved.target, item.kind) };
  });
  settings.folders = { ...settings.folders, [context.folderId]: { ...folderSettings, favorites } };
  await context.documents.saveProfileSettings(settings);
};

/** Publishes one renamed path and tombstones its old peer name. A target whose
 * published baseline already matches the peer copy resumes after an interruption.
 */
const renameFavorite = async (context: FavoriteContext, from: string, to: string): Promise<FavoriteSyncResult> => {
  const local = context.cached.get(to);
  if (!local) throw new Error("Renamed favorite is unavailable locally.");
  const localHash = await hashLocal(context, to);
  const baseline = await context.documents.syncBaseline(documentId(context.storageId, from));
  const remoteSource = await readRemoteVersion(context.remoteFs, context.folderId, from);
  const remoteTarget = await readRemoteVersion(context.remoteFs, context.folderId, to);
  const targetBaseline = await context.documents.syncBaseline(documentId(context.storageId, to));
  const published = !!targetBaseline && !!remoteTarget &&
    remoteTarget.size === targetBaseline.sizeBytes && remoteTarget.modifiedMs === targetBaseline.modifiedMs;
  const action = planFavoriteRename({ local: { size: local.sizeBytes, hash: localHash },
    remoteSource, remoteTarget, baseline, resumeTarget: published });
  if (action.kind === "conflict") {
    const entry = await recordIssue(context, from, "conflict", action.message);
    return { folderId: context.folderId, path: from, result: "conflict", message: entry.message };
  }
  await setEntry(context, to, { phase: "uploading", attempts: 0, updatedAtMs: context.nowMs, nextAttemptMs: 0 });
  if (!published) await uploadFavorite(context, to, { hash: localHash });
  if (action.removeRemote) {
    await context.remoteFs.deleteFile(context.folderId, from, { modifiedMs: context.nowMs, waitForRemote: true });
  }
  await context.documents.clearSyncBaseline(documentId(context.storageId, from)).catch(() => {});
  delete context.entries[from];
  await markSynced(context, to);
  return { folderId: context.folderId, path: from, result: "renamed" };
};

const runRenames = async (context: FavoriteContext, results: FavoriteSyncResult[]): Promise<boolean> => {
  const renames = [...context.renames];
  const pairs = planFavoriteRenames([...context.cached.keys()], renames);
  const paired = new Set(pairs.map(pair => pair.from));
  let failed = false;
  for (const pair of pairs) {
    try { results.push(await renameFavorite(context, pair.from, pair.to)); }
    catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : "Favorite rename failed.";
      await recordIssue(context, pair.from, "error", message);
      results.push({ folderId: context.folderId, path: pair.from, result: "error", message });
    }
  }
  if (failed) return false;
  for (const rename of renames.filter(entry => !paired.has(entry.from))) {
    const remote = await readRemoteVersion(context.remoteFs, context.folderId, rename.from);
    const baseline = await context.documents.syncBaseline(documentId(context.storageId, rename.from));
    const action = planFavoriteSync({ remote, baseline });
    if (action.kind === "delete-remote") results.push(await runDeleteRemote(context, rename.from));
    else if (action.kind === "conflict") await recordIssue(context, rename.from, "conflict", action.message);
  }
  await updateFavoritePaths(context, renames);
  await context.documents.clearFavoriteRenames(context.folderId, renames.flatMap(rename => [rename.from, rename.to]));
  context.renames = [];
  return true;
};

/** Executes a resolution the app recorded for a conflicted favorite.
 * `keep-local` re-publishes the local copy; `keep-remote` replaces it.
 * The stored resolution is consumed only after the operation succeeds.
 */
const runResolution = async (context: FavoriteContext, candidate: FavoriteCandidate,
  resolution: "keep-local" | "keep-remote"): Promise<FavoriteSyncResult> => {
  const path = candidate.path, local = candidate.local;
  const consume = async () => {
    await context.documents.clearFavoriteSyncEntry(context.folderId, path);
    delete context.entries[path];
  };
  if (resolution === "keep-local") {
    if (!local) throw new Error("The local copy is unavailable; the resolution was not applied.");
    const hash = await hashLocal(context, path);
    await setEntry(context, path, { phase: "uploading", attempts: 0, updatedAtMs: context.nowMs, nextAttemptMs: 0 });
    await uploadFavorite(context, path, { hash });
    await consume();
    await markSynced(context, path);
    return { folderId: context.folderId, path, result: "uploaded" };
  }
  if (!candidate.remote) throw new Error("The peer copy is unavailable; the resolution was not applied.");
  const expected = local ? await hashLocal(context, path) : null;
  await runDownload(context, path, candidate.remote, expected);
  await consume();
  await markSynced(context, path);
  return { folderId: context.folderId, path, result: "downloaded" };
};

const planAndRunCandidate = async (context: FavoriteContext, candidate: FavoriteCandidate): Promise<FavoriteSyncResult> => {
  const path = candidate.path, id = documentId(context.storageId, path);
  const pending = context.entries[path];
  if (pending?.resolution) {
    if (pending.nextAttemptMs > context.nowMs) {
      return { folderId: context.folderId, path, result: pending.phase === "conflict" ? "conflict" : "error",
        ...(pending.message === undefined ? {} : { message: pending.message }) };
    }
    return runResolution(context, candidate, pending.resolution);
  }
  const baseline = candidate.local?.baseline ?? await context.documents.syncBaseline(id);
  const local = candidate.local ? { size: candidate.local.sizeBytes, hash: await hashLocal(context, path) } : undefined;
  const action = planFavoriteSync({ local, remote: candidate.remote, baseline });
  switch (action.kind) {
    case "unchanged":
      if (context.entries[path]?.phase !== "synced") await markSynced(context, path);
      return { folderId: context.folderId, path, result: "unchanged" };
    case "download": return runDownload(context, path, candidate.remote!, action.expectedLocalHash);
    case "upload": return runUpload(context, path, local!);
    case "delete-remote": return runDeleteRemote(context, path);
    case "delete-local": return runDeleteLocal(context, path);
    default: {
      const entry = await recordIssue(context, path, "conflict", action.message);
      return { folderId: context.folderId, path, result: "conflict", message: entry.message };
    }
  }
};

const runCandidate = async (context: FavoriteContext, candidate: FavoriteCandidate): Promise<FavoriteSyncResult> => {
  const path = candidate.path;
  const pending = context.entries[path];
  if (!pending?.resolution && pending && pending.nextAttemptMs > context.nowMs) {
    return { folderId: context.folderId, path, result: pending.phase === "conflict" ? "conflict" : "error",
      ...(pending.message === undefined ? {} : { message: pending.message }) };
  }
  try {
    return await planAndRunCandidate(context, candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Favorite sync failed.";
    await recordIssue(context, path, "error", message);
    return { folderId: context.folderId, path, result: "error", message };
  }
};

const pruneEntries = (entries: Record<string, FavoriteSyncEntry>, candidates: readonly FavoriteCandidate[],
  favorites: readonly FavoriteRecord[], renames: readonly FavoriteRename[]): Record<string, FavoriteSyncEntry> => {
  const retained = new Set(candidates.map(candidate => candidate.path));
  for (const favorite of favorites) retained.add(normalizePath(favorite.path));
  for (const rename of renames) { retained.add(rename.from); retained.add(rename.to); }
  return Object.fromEntries(Object.entries(entries).filter(([path]) => retained.has(path)));
};

const favoriteFolderResults = (folderId: string, favorites: readonly FavoriteRecord[],
  result: FavoriteSyncResult["result"], message: string): FavoriteSyncResult[] =>
  favorites.map(favorite => ({ folderId, path: normalizePath(favorite.path), result, message }));

const collectRemoteFavorites = async (args: {
  remoteFs: RemoteFs;
  folderId: string;
  favorites: readonly FavoriteRecord[];
  exclusions: readonly FavoriteExclusion[];
  patterns: readonly string[];
  onDirectory?: (path: string, entries: FileEntry[]) => Promise<void> | void;
}) => collectFavoriteFiles({ folderId: args.folderId, favorites: args.favorites, exclusions: args.exclusions,
  patterns: args.patterns, readDir: path => args.remoteFs.readDir(args.folderId, path),
  ...(args.onDirectory ? { onDirectory: args.onDirectory } : {}) });

const syncFolderFavorites = async (args: {
  documents: DocumentFilesystem;
  remoteFs: RemoteFs;
  folder: FolderRegistration;
  favorites: FavoriteRecord[];
  exclusions: FavoriteExclusion[];
  patterns: string[];
  nowMs: number;
}): Promise<FavoriteSyncResult[]> => {
  const { documents, remoteFs, folder, favorites, exclusions, patterns, nowMs } = args;
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
  const hadRenames = context.renames.length > 0;
  if (!await runRenames(context, results)) return results;
  if (hadRenames) {
    cached = await documents.cachedFiles(folder.id);
    context.cached = new Map(cached.map(file => [file.path, file]));
  }
  const current = (await documents.profileSettings()).folders[folder.id];
  const activeFavorites = current?.favorites ?? favorites;
  const activeExclusions = current?.exclusions ?? exclusions;
  const activePatterns = current?.ignorePatterns ?? patterns;
  const sourceDeviceId = remoteFs.getRemoteDeviceInfo()?.id;
  const onDirectory = sourceDeviceId ? async (path: string, entries: FileEntry[]) => {
    await documents.saveDirectorySnapshot(folder.id, sourceDeviceId, path,
      { entries, versionKey: "", loadedAtMs: nowMs });
  } : undefined;
  let remote: FileEntry[];
  try {
    remote = await collectRemoteFavorites({ remoteFs, folderId: folder.id, favorites: activeFavorites,
      exclusions: activeExclusions, patterns: activePatterns, ...(onDirectory ? { onDirectory } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Folder contents are unavailable.";
    return results.concat(favoriteFolderResults(folder.id, activeFavorites, "unavailable", message));
  }
  const baselines = new Map<string, NonNullable<CachedFileRecord["syncBaseline"]>>();
  for (const file of cached) if (file.syncBaseline) baselines.set(file.path, file.syncBaseline);
  const candidates = planFavoriteCandidates({ folderId: folder.id, favorites: activeFavorites,
    exclusions: activeExclusions, patterns: activePatterns,
    remote, local: cached.map(file => ({ path: file.path, sizeBytes: file.sizeBytes, modifiedMs: file.modifiedMs ?? file.cachedAtMs })),
    baselines });
  for (const candidate of candidates) results.push(await runCandidate(context, candidate));
  const retained = pruneEntries(context.entries, candidates, activeFavorites, context.renames);
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
    const favorites = folderSettings.favorites;
    if (!folder || folderSettings.paused || favorites.length === 0) continue;
    const info = folderInfos.get(folderId);
    if (!info || info.needsPassword || info.passwordError || info.stopReason) {
      results.push(...favoriteFolderResults(folderId, favorites, "unavailable",
        "Folder metadata is unavailable for synchronization."));
      continue;
    }
    results.push(...await syncFolderFavorites({ documents, remoteFs, folder, favorites,
      exclusions: folderSettings.exclusions, patterns: folderSettings.ignorePatterns, nowMs }));
  }
  return { results };
}
