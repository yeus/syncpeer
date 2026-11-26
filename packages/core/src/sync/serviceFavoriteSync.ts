import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { RemoteFs } from "../core/model/remoteFs.js";
import type { CachedFileRecord, FavoriteRecord } from "../ui/browserClient.js";
import { favoriteKey, normalizePath } from "../ui/helpers.js";
import { createSha256DownloadSink, type FileDownloadSink, type FileUploadSource } from "../transfer/stream.js";
import type { DocumentFilesystem } from "./documentFilesystem.js";
import type { FolderRegistration } from "./folderRegistry.js";
import { favoriteRetryDelayMs, type FavoriteRename,
  type FavoriteSyncEntry } from "./documentFavoriteState.js";
import { applyFavoriteRename, planFavoriteCandidates, planFavoriteRename,
  planFavoriteRenames, planFavoriteSync, type FavoriteCandidate,
  type FavoriteRemoteVersion } from "./favoriteSyncPlan.js";
import { classifyFavoritePath, collectFavoriteFiles, type FavoriteExclusion } from "../ui/favoriteSelection.js";
import type { FileEntry } from "../core/model/remoteFs.js";
import { writeDocumentDownload } from "./documentDownloadWrites.js";
import { defaultFolderSettings } from "./profileSettings.js";
import { isInternalReplicaPath } from "./replicaPaths.js";

type Baseline = NonNullable<CachedFileRecord["syncBaseline"]>;

export interface FavoriteSyncResult {
  folderId: string;
  path: string;
  result: "downloaded" | "uploaded" | "unchanged" | "deleted" | "deleted-local" | "renamed"
    | "waiting" | "conflict" | "error" | "unavailable";
  message?: string;
}
/** Redacted progress for Android diagnostics; never includes folder IDs or paths. */
export type FavoriteSyncProgress = {
  stage: "index" | "storage" | "listing" | "planning" | "download" | "upload" | "delete" | "processing" | "folder_done" | "complete";
  folderOrdinal: number;
  folderCount: number;
  itemOrdinal?: number;
  itemCount?: number;
  transferredBytes?: number;
  totalBytes?: number;
};


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
  reportTransfer?: (stage: "download" | "upload" | "delete", transferredBytes?: number, totalBytes?: number) => void;
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
      await writeDocumentDownload(documents, handle, offset, bytes);
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
  try {
    await context.remoteFs.readFileToSink(context.folderId, path, sink, progress =>
      context.reportTransfer?.("download", progress.downloadedBytes, progress.totalBytes));
  }
  catch (error) { await sink.abort(error); throw error; }
};

const uploadFavorite = async (context: FavoriteContext, path: string,
  local: { hash: string }): Promise<Baseline> => {
  const id = documentId(context.storageId, path);
  const source = await documentUploadSource(context.documents, id);
  const modifiedMs = context.nowMs;
  try {
    await context.remoteFs.writeFileStream(context.folderId, path, source,
      { modifiedMs, waitForRemote: true, expectedHash: local.hash,
        onProgress: progress => context.reportTransfer?.("upload", progress.processedBytes, progress.totalBytes) });
    context.reportTransfer?.("upload", source.size, source.size);
    const baseline = { hash: local.hash, sizeBytes: source.size, modifiedMs,
      versionKey: context.cached.get(path)?.localVersionKey };
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

/** Destructive operations must verify bytes, not just size and timestamp.
 * The sink hashes the verified stream without materializing or caching it.
 */
const matchesRemoteBaseline = async (context: FavoriteContext, path: string, baseline: Baseline): Promise<boolean> => {
  const { sink, digestHex } = createSha256DownloadSink({
    begin: () => {}, write: () => {}, commit: () => {}, abort: () => {},
  });
  await context.remoteFs.readFileToSink(context.folderId, path, sink);
  return digestHex() === baseline.hash;
};

const runDeleteRemote = async (context: FavoriteContext, path: string, baseline: Baseline): Promise<FavoriteSyncResult> => {
  if (!await matchesRemoteBaseline(context, path, baseline)) {
    const entry = await recordIssue(context, path, "conflict", "Peer content changed since the last sync; deletion was cancelled.");
    return { folderId: context.folderId, path, result: "conflict", message: entry.message };
  }
  await setEntry(context, path, { phase: "deleting-remote", attempts: context.entries[path]?.attempts ?? 0,
    updatedAtMs: context.nowMs, nextAttemptMs: 0 });
  const id = documentId(context.storageId, path);
  const current = await context.documents.syncBaseline(id);
  const [status] = await context.documents.cachedStatuses(context.folderId, [path]);
  if (status?.available || !current?.localDeletion || current.hash !== baseline.hash) {
    return { folderId: context.folderId, path, result: "waiting", message: "Local deletion intent changed; replanning." };
  }
  await context.remoteFs.deleteFile(context.folderId, path, { modifiedMs: context.nowMs, waitForRemote: true });
  await clearFavoriteRecords(context, path);
  await markSynced(context, path);
  return { folderId: context.folderId, path, result: "deleted" };
};

const runDeleteLocal = async (context: FavoriteContext, path: string): Promise<FavoriteSyncResult> => {
  const id = documentId(context.storageId, path);
  const version = context.cached.get(path)?.localVersionKey;
  const evidence = await context.remoteFs.indexedFile(context.folderId, path);
  if (!evidence?.deleted || evidence.invalid || !version ||
      !await context.documents.removeSyncedFile(id, version)) {
    return { folderId: context.folderId, path, result: "waiting", message: "Deletion is not yet verified or the local document is in use." };
  }
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
    remoteTarget.size === targetBaseline.sizeBytes && remoteTarget.modifiedMs === targetBaseline.modifiedMs &&
    targetBaseline.hash === localHash && await matchesRemoteBaseline(context, to, targetBaseline);
  const conflict = async (message: string): Promise<FavoriteSyncResult> => {
    const entry = await recordIssue(context, from, "conflict", message);
    return { folderId: context.folderId, path: from, result: "conflict", message: entry.message };
  };
  const action = planFavoriteRename({ local: { size: local.sizeBytes, hash: localHash },
    remoteSource, remoteTarget, baseline, resumeTarget: published });
  if (action.kind === "conflict") return conflict(action.message);
  if (action.removeRemote && (!baseline || !await matchesRemoteBaseline(context, from, baseline))) {
    return conflict("Peer content changed since the last sync; rename was cancelled.");
  }
  await setEntry(context, to, { phase: "uploading", attempts: 0, updatedAtMs: context.nowMs, nextAttemptMs: 0 });
  if (!published) await uploadFavorite(context, to, { hash: localHash });
  if (action.removeRemote) {
    // Publishing a large target may take time; verify the source again before
    // tombstoning it, rather than relying on the earlier planning snapshot.
    if (!baseline || !await matchesRemoteBaseline(context, from, baseline)) {
      return conflict("Peer content changed during rename publication; both copies were preserved.");
    }
    await context.remoteFs.deleteFile(context.folderId, from, { modifiedMs: context.nowMs, waitForRemote: true });
  }
  await context.documents.clearSyncBaseline(documentId(context.storageId, from)).catch(() => {});
  delete context.entries[from];
  await markSynced(context, to);
  return { folderId: context.folderId, path: from, result: "renamed" };
};

const runRenames = async (context: FavoriteContext, results: FavoriteSyncResult[]): Promise<boolean> => {
  const renames = [...context.renames];
  if (!renames.length) return true;
  const pairs = planFavoriteRenames([...context.cached.keys()], renames);
  const paired = new Set(pairs.map(pair => pair.from));
  // An interrupted rename with no cached target is not a deletion request.
  // Keep its durable rename intent and the original peer copy for recovery.
  for (const rename of renames.filter(entry => !paired.has(entry.from))) {
    const baseline = await context.documents.syncBaseline(documentId(context.storageId, rename.from));
    if (!baseline) continue; // Directory rename roots have no file baseline.
    const remote = await readRemoteVersion(context.remoteFs, context.folderId, rename.from);
    if (!remote) continue;
    const entry = await recordIssue(context, rename.from, "conflict", "Renamed local document is missing; the original peer copy was preserved.");
    results.push({ folderId: context.folderId, path: rename.from, result: "conflict", message: entry.message });
  }
  if (results.length) return false;
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
  if (context.cached.get(path)?.localWriteOpen) return {
    folderId: context.folderId, path, result: "waiting", message: "Document is still open for writing.",
  };
  const pending = context.entries[path];
  if (pending?.resolution) {
    if (pending.nextAttemptMs > context.nowMs) {
      return { folderId: context.folderId, path, result: pending.phase === "conflict" ? "conflict" : "error",
        ...(pending.message === undefined ? {} : { message: pending.message }) };
    }
    return runResolution(context, candidate, pending.resolution);
  }
  const baseline = candidate.local?.baseline ?? await context.documents.syncBaseline(id);
  // An absent listing is not a remote tombstone. Preserve the local bytes.
  if (!candidate.uploadOnly && candidate.local && baseline && !candidate.remote) {
    const evidence = await context.remoteFs.indexedFile(context.folderId, path);
    if (!evidence?.deleted || evidence.invalid) return {
      folderId: context.folderId, path, result: "waiting", message: "Waiting for verified peer deletion or file metadata.",
    };
  }
  if (!candidate.local && candidate.remote && baseline && !baseline.localDeletion) {
    // An unrecorded local disappearance (eviction, interruption or storage
    // failure) is not authority to delete the peer's original.
    return runDownload(context, path, candidate.remote, null);
  }
  if (candidate.local && baseline?.localDeletion) {
    // A recreated local document supersedes the old delete intent.
    await context.documents.setSyncBaseline(id, { ...baseline, localDeletion: undefined });
  }
  // Reuse the authenticated baseline only for a no-op. Uploads, replacements,
  // deletions and resolutions still verify actual content, not size or mtime.
  const cached = context.cached.get(path);
  const unchanged = baseline && cached?.localVersionKey && baseline.versionKey === cached.localVersionKey &&
    cached.sizeBytes === baseline.sizeBytes && candidate.remote?.size === baseline.sizeBytes &&
    candidate.remote.modifiedMs === baseline.modifiedMs;
  const local = candidate.local ? { size: candidate.local.sizeBytes,
    hash: unchanged ? baseline.hash : await hashLocal(context, path) } : undefined;
  if (candidate.uploadOnly && local) {
    // Local edits outside the favorite selection are upload-only. Never
    // download an unrelated peer change or propagate a deletion implicitly.
    if (baseline && local.hash === baseline.hash) {
      await context.documents.setSyncBaseline(id, { ...baseline, localDeletion: undefined, versionKey: cached?.localVersionKey });
      return { folderId: context.folderId, path, result: "unchanged" };
    }
    const evidence = await context.remoteFs.indexedFile(context.folderId, path);
    const conflict = evidence && (evidence.invalid || evidence.type !== "file" ||
      (!baseline && !evidence.deleted) || (baseline && (evidence.deleted ||
        evidence.size !== baseline.sizeBytes || evidence.modifiedMs !== baseline.modifiedMs ||
        !await matchesRemoteBaseline(context, path, baseline))));
    if (conflict || (baseline && !evidence)) {
      const entry = await recordIssue(context, path, "conflict", "Local document and peer contents differ; both copies were preserved.");
      return { folderId: context.folderId, path, result: "conflict", message: entry.message };
    }
    if ((await context.remoteFs.getFolderSyncState(context.folderId))?.indexReceived !== true)
      return { folderId: context.folderId, path, result: "waiting", message: "Waiting for peer index." };
    context.reportTransfer?.("upload");
    return runUpload(context, path, local);
  }
  const action = planFavoriteSync({ local, remote: candidate.remote, baseline });
  switch (action.kind) {
    case "unchanged":
      if (context.entries[path]?.phase !== "synced") await markSynced(context, path);
      return { folderId: context.folderId, path, result: "unchanged" };
    case "download": context.reportTransfer?.("download"); return runDownload(context, path, candidate.remote!, action.expectedLocalHash);
    case "upload": {
      // Equal size and mtime do not establish that the remote bytes still
      // match the common baseline. Verify before replacing a peer file.
      if (baseline && candidate.remote && !await matchesRemoteBaseline(context, path, baseline)) {
        const entry = await recordIssue(context, path, "conflict", "Local document and peer contents differ; both copies were preserved.");
        return { folderId: context.folderId, path, result: "conflict", message: entry.message };
      }
      context.reportTransfer?.("upload");
      return runUpload(context, path, local!);
    }
    case "delete-remote": {
      const evidence = await context.remoteFs.indexedFile(context.folderId, path);
      if (!evidence || evidence.deleted || evidence.invalid || evidence.type !== "file" ||
          evidence.size !== baseline?.sizeBytes || evidence.modifiedMs !== baseline.modifiedMs)
        return { folderId: context.folderId, path, result: "waiting", message: "Waiting for verified peer metadata before deletion." };
      context.reportTransfer?.("delete");
      return runDeleteRemote(context, path, baseline!);
    }
    case "delete-local": context.reportTransfer?.("delete"); return runDeleteLocal(context, path);
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

// Only reuse a fully successful, unchanged run, and periodically audit even
// private storage to recover from unexpected external corruption/disappearance.
export const createFavoriteSyncMemo = () => new WeakMap<RemoteFs, Map<string, {
  remote: number; local: number; storageId: string; settings: string; checkedAtMs: number;
}>>();
const FULL_RECONCILIATION_INTERVAL_MS = 120_000;

const collectRemoteFavorites = async (args: {
  remoteFs: RemoteFs;
  folderId: string;
  favorites: readonly FavoriteRecord[];
  exclusions: readonly FavoriteExclusion[];
  patterns: readonly string[];
  shouldYield?: () => boolean;
  onDirectory?: (path: string, entries: FileEntry[]) => Promise<void> | void;
}) => collectFavoriteFiles({ folderId: args.folderId, favorites: args.favorites, exclusions: args.exclusions,
  patterns: args.patterns, readDir: async path => {
    if (args.shouldYield?.()) throw new Error("Interactive work has priority.");
    const entries = await args.remoteFs.readDir(args.folderId, path);
    if (args.shouldYield?.()) throw new Error("Interactive work has priority.");
    return entries;
  },
  ...(args.onDirectory ? { onDirectory: args.onDirectory } : {}) });

const syncFolderFavorites = async (args: {
  documents: DocumentFilesystem;
  remoteFs: RemoteFs;
  folder: FolderRegistration;
  favorites: FavoriteRecord[];
  exclusions: FavoriteExclusion[];
  patterns: string[];
  nowMs: number;
  onClean?: () => void;
  shouldYield?: () => boolean;
  report?: (stage: FavoriteSyncProgress["stage"], itemOrdinal?: number, itemCount?: number,
    transferredBytes?: number, totalBytes?: number) => void;
}): Promise<FavoriteSyncResult[]> => {
  const { documents, remoteFs, folder, favorites, exclusions, patterns, nowMs, report, shouldYield } = args;
  const deferred = () => favoriteFolderResults(folder.id, favorites, "waiting", "Manual transfer has priority.");
  if (shouldYield?.()) return deferred();
  report?.("index");
  let indexState = await remoteFs.getFolderSyncState(folder.id);
  if (indexState?.indexReceived !== true) {
    await remoteFs.waitForFolderIndex(folder.id, 6000, 120);
    indexState = await remoteFs.getFolderSyncState(folder.id);
  }
  if (indexState?.indexReceived !== true) {
    return favoriteFolderResults(folder.id, favorites, "waiting", "Folder index is still being received.");
  }
  if (shouldYield?.()) return deferred();
  report?.("storage");
  let cached: CachedFileRecord[], state;
  try {
    cached = await documents.cachedFiles(folder.id);
    state = await documents.favoriteSyncState(folder.id);
  } catch (error) {
    return favoriteFolderResults(folder.id, favorites, "unavailable",
      error instanceof Error ? error.message : "Document folder is unavailable.");
  }
  let itemOrdinal = 0, itemCount = 0;
  const context: FavoriteContext = { documents, remoteFs, folderId: folder.id, storageId: folder.storageId,
    cached: new Map(cached.map(file => [file.path, file])), entries: state.entries, renames: state.renames,
    nowMs, persist: async () => { await documents.saveFavoriteSyncEntries(folder.id, context.entries); },
    reportTransfer: (stage, transferredBytes, totalBytes) =>
      report?.(stage, itemOrdinal, itemCount, transferredBytes, totalBytes) };
  const results: FavoriteSyncResult[] = [];
  if (shouldYield?.()) return deferred();
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
  report?.("listing");
  const sourceDeviceId = remoteFs.getRemoteDeviceInfo()?.id;
  const onDirectory = sourceDeviceId ? async (path: string, entries: FileEntry[]) => {
    // Offline-listing persistence is best effort. It must not abort transfers.
    await documents.saveDirectorySnapshot(folder.id, sourceDeviceId, path,
      { entries, versionKey: "", loadedAtMs: nowMs }).catch(() => undefined);
  } : undefined;
  let remote: FileEntry[];
  try {
    remote = await collectRemoteFavorites({ remoteFs, folderId: folder.id, favorites: activeFavorites,
      exclusions: activeExclusions, patterns: activePatterns, shouldYield, ...(onDirectory ? { onDirectory } : {}) });
  } catch (error) {
    if (shouldYield?.()) return results.concat(deferred());
    const message = error instanceof Error ? error.message : "Folder contents are unavailable.";
    return results.concat(favoriteFolderResults(folder.id, activeFavorites, "unavailable", message));
  }
  if (shouldYield?.()) return results.concat(deferred());
  report?.("planning");
  const baselines = new Map<string, NonNullable<CachedFileRecord["syncBaseline"]>>();
  for (const file of cached) if (file.syncBaseline) baselines.set(file.path, file.syncBaseline);
  const candidates = planFavoriteCandidates({ folderId: folder.id, favorites: activeFavorites,
    exclusions: activeExclusions, patterns: activePatterns,
    remote, local: cached.map(file => ({ path: file.path, sizeBytes: file.sizeBytes, modifiedMs: file.modifiedMs ?? file.cachedAtMs })),
    baselines });
  // A Save As or edit in an attached folder is explicit local publication,
  // not a request to favorite or download all remote contents. All downloaded
  // documents have an authenticated baseline; version changes identify edits.
  const selected = new Set(candidates.map(candidate => candidate.path));
  const rootSelection: FavoriteRecord[] = [{ folderId: folder.id, path: "", name: folder.label,
    key: favoriteKey(folder.id, "", "folder"), kind: "folder" }];
  for (const file of cached) {
    if (selected.has(file.path) || isInternalReplicaPath(file.path) ||
        (file.syncBaseline && file.syncBaseline.versionKey === file.localVersionKey && !file.syncBaseline.localDeletion)) continue;
    const target = { folderId: folder.id, path: file.path, kind: "file" as const };
    if (classifyFavoritePath(target, rootSelection, activeExclusions, activePatterns).status !== "favorite") continue;
    const indexed = await remoteFs.indexedFile(folder.id, file.path);
    candidates.push({ path: file.path, uploadOnly: true,
      ...(indexed && !indexed.deleted && !indexed.invalid && indexed.type === "file"
        ? { remote: { size: indexed.size, modifiedMs: indexed.modifiedMs } } : {}),
      local: { sizeBytes: file.sizeBytes, modifiedMs: file.modifiedMs ?? file.cachedAtMs, baseline: file.syncBaseline } });
  }
  itemCount = candidates.length;
  for (const [index, candidate] of candidates.entries()) {
    // Never interrupt a publication, deletion, or rename transaction. Discard
    // the remaining plan so a manual transfer cannot make its baselines stale.
    if (shouldYield?.()) return results.concat(candidates.slice(index).map(item => ({
      folderId: folder.id, path: item.path, result: "waiting" as const, message: "Manual transfer has priority.",
    })));
    itemOrdinal = index + 1;
    report?.("processing", itemOrdinal, itemCount);
    results.push(await runCandidate(context, candidate));
  }
  const retained = pruneEntries(context.entries, candidates, activeFavorites, context.renames);
  if (Object.keys(retained).length !== Object.keys(context.entries).length) {
    context.entries = retained;
    await context.persist();
  }
  if (!shouldYield?.() && results.every(result => result.result === "unchanged")) args.onClean?.();
  return results;
};

export async function syncServiceFileFavorites(
  documents: DocumentFilesystem,
  remoteFs: RemoteFs,
  options: { nowMs?: number; excludeFolderIds?: readonly string[];
    onProgress?: (progress: FavoriteSyncProgress) => void; shouldYield?: () => boolean;
    memo?: ReturnType<typeof createFavoriteSyncMemo> } = {},
): Promise<{ skipped?: "locked"; yielded?: true; results: FavoriteSyncResult[] }> {
  if (options.shouldYield?.()) return { yielded: true, results: [] };
  const nowMs = options.nowMs ?? Date.now();
  const status = await documents.status();
  if (status.vault.phase !== "unlocked") return { skipped: "locked", results: [] };
  const memo = options.memo;
  let cleanFolders = memo?.get(remoteFs);
  if (memo && !cleanFolders) {
    cleanFolders = new Map();
    memo.set(remoteFs, cleanFolders);
  }
  const settings = await documents.profileSettings();
  const excluded = new Set(options.excludeFolderIds ?? []);
  const registered = new Map(status.folders
    .filter(folder => folder.downloads && !excluded.has(folder.id))
    .map(folder => [folder.id, folder]));
  const folderInfos = new Map((await remoteFs.listFolders()).map(folder => [folder.id, folder]));
  const results: FavoriteSyncResult[] = [];
  const targets = [...registered.keys()].filter(folderId => folderInfos.has(folderId))
    .map(folderId => [folderId, settings.folders[folderId] ?? defaultFolderSettings()] as const)
    .filter(([, value]) => !value.paused);
  const report = (progress: FavoriteSyncProgress) => {
    // Diagnostics must never be allowed to break synchronization.
    try { options.onProgress?.(progress); } catch { /* nonessential */ }
  };
  for (const [index, [folderId, folderSettings]] of targets.entries()) {
    if (options.shouldYield?.()) return { yielded: true, results };
    const folder = registered.get(folderId)!;
    const favorites = folderSettings.favorites;
    const folderOrdinal = index + 1, folderCount = targets.length;
    const emit = (stage: FavoriteSyncProgress["stage"], itemOrdinal?: number, itemCount?: number,
      transferredBytes?: number, totalBytes?: number) =>
      report({ stage, folderOrdinal, folderCount,
        ...(itemOrdinal !== undefined ? { itemOrdinal } : {}),
        ...(itemCount !== undefined ? { itemCount } : {}),
        ...(transferredBytes !== undefined ? { transferredBytes } : {}),
        ...(totalBytes !== undefined ? { totalBytes } : {}) });
    try {
      const info = folderInfos.get(folderId);
      if (!info || info.needsPassword || info.passwordError || info.stopReason) {
        results.push(...favoriteFolderResults(folderId, favorites, "unavailable",
          "Folder metadata is unavailable for synchronization."));
        continue;
      }
      const remoteRevision = remoteFs.folderSyncRevision?.(folderId);
      const localRevision = documents.favoriteSyncRevision();
      const selection = JSON.stringify(folderSettings);
      const previous = cleanFolders?.get(folderId);
      if (remoteRevision !== undefined && previous && previous.remote === remoteRevision &&
          previous.local === localRevision && previous.storageId === folder.storageId &&
          previous.settings === selection && nowMs >= previous.checkedAtMs &&
          nowMs - previous.checkedAtMs < FULL_RECONCILIATION_INTERVAL_MS) continue;
      cleanFolders?.delete(folderId);
      results.push(...await syncFolderFavorites({ documents, remoteFs, folder, favorites,
        exclusions: folderSettings.exclusions, patterns: folderSettings.ignorePatterns, nowMs, report: emit,
        shouldYield: options.shouldYield,
        onClean: () => {
          if (remoteRevision !== undefined && remoteFs.folderSyncRevision?.(folderId) === remoteRevision &&
              documents.favoriteSyncRevision() === localRevision) cleanFolders?.set(folderId, {
            remote: remoteRevision, local: localRevision, storageId: folder.storageId,
            settings: selection, checkedAtMs: nowMs,
          });
        },
      }));
    } catch (error) {
      // A transient failure on one folder must not prevent all other favorites syncing.
      results.push(...favoriteFolderResults(folderId, favorites, "unavailable",
        error instanceof Error ? error.message : "Folder sync failed."));
    } finally {
      emit("folder_done");
    }
  }
  if (options.shouldYield?.()) return { yielded: true, results };
  report({ stage: "complete", folderOrdinal: targets.length, folderCount: targets.length });
  return { results };
}
