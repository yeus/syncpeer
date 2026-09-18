import type { FavoriteRecord } from "../ui/browserClient.js";
import { classifyFavoritePath, type FavoriteExclusion } from "../ui/favoriteSelection.js";
import { normalizePath } from "../ui/helpers.js";
import type { FileEntry } from "../core/model/remoteFs.js";

export interface FavoriteSyncBaseline {
  hash: string;
  sizeBytes: number;
  modifiedMs: number;
}

export interface FavoriteRemoteVersion {
  size: number;
  modifiedMs: number;
}

export interface FavoriteLocalVersion {
  size: number;
  hash: string;
}

export interface FavoriteCandidate {
  path: string;
  remote?: FavoriteRemoteVersion;
  local?: { sizeBytes: number; modifiedMs: number; baseline?: FavoriteSyncBaseline };
}

export type FavoriteSyncAction =
  | { kind: "unchanged" }
  | { kind: "download"; expectedLocalHash: string | null }
  | { kind: "upload" }
  | { kind: "delete-remote"; reason: "local-deleted" }
  | { kind: "delete-local"; reason: "remote-deleted" }
  | { kind: "conflict"; message: string };

export type FavoriteRenameAction =
  | { kind: "publish"; removeRemote: boolean }
  | { kind: "conflict"; message: string };

const remoteChanged = (remote: FavoriteRemoteVersion, baseline: FavoriteSyncBaseline): boolean =>
  remote.size !== baseline.sizeBytes || remote.modifiedMs !== baseline.modifiedMs;

const noBaselineConflict = (): FavoriteSyncAction => ({
  kind: "conflict",
  message: "Favorite has no verified sync baseline; resolve it in the app.",
});

/** Deletion and rename only ever propagate from a verified common baseline.
 * Both sides changed means the conflict is reported and neither copy is replaced.
 */
export function planFavoriteSync(input: {
  local?: FavoriteLocalVersion;
  remote?: FavoriteRemoteVersion;
  baseline?: FavoriteSyncBaseline;
}): FavoriteSyncAction {
  const { local, remote, baseline } = input;
  if (!baseline) {
    if (!local && remote) return { kind: "download", expectedLocalHash: null };
    if (!local) return { kind: "unchanged" };
    if (!remote) return { kind: "upload" };
    return noBaselineConflict();
  }
  const localChanged = local ? local.hash !== baseline.hash : true;
  const peerChanged = remote ? remoteChanged(remote, baseline) : true;
  if (local && remote) {
    if (!localChanged && !peerChanged) return { kind: "unchanged" };
    if (remoteChanged(remote, baseline)) {
      return localChanged
        ? { kind: "conflict", message: "Favorite conflict: local and peer copies both changed." }
        : { kind: "download", expectedLocalHash: local.hash };
    }
    return { kind: "upload" };
  }
  if (!local && !remote) return { kind: "unchanged" };
  if (!local) {
    return peerChanged
      ? { kind: "conflict", message: "Favorite was deleted locally while the peer copy changed; both sides were preserved." }
      : { kind: "delete-remote", reason: "local-deleted" };
  }
  return localChanged
    ? { kind: "conflict", message: "Favorite was deleted on the peer while the local copy changed; both sides were preserved." }
    : { kind: "delete-local", reason: "remote-deleted" };
}

/** Renames publish the local target and tombstone the old peer path.
 * A changed old path or an unexpected new path is a conflict; no copy is replaced.
 * `resumeTarget` accepts a new path left by an interrupted rename publication.
 */
export function planFavoriteRename(input: {
  local: FavoriteLocalVersion;
  remoteSource?: FavoriteRemoteVersion;
  remoteTarget?: FavoriteRemoteVersion;
  baseline?: FavoriteSyncBaseline;
  resumeTarget?: boolean;
}): FavoriteRenameAction {
  if (!input.baseline) return { kind: "conflict", message: "Favorite has no verified sync baseline; resolve it in the app." };
  if (input.remoteTarget && !(input.resumeTarget && input.remoteTarget.size === input.local.size)) {
    return { kind: "conflict", message: "Favorite was renamed locally while a peer copy already exists at the new name; both sides were preserved." };
  }
  if (input.remoteSource && remoteChanged(input.remoteSource, input.baseline)) {
    return { kind: "conflict", message: "Favorite was renamed locally while the old peer copy changed; both sides were preserved." };
  }
  return { kind: "publish", removeRemote: !!input.remoteSource };
}

const maxRenameHops = 8;

/** A rename matches its exact path and every descendant, so a directory rename
 * rewrites the prefix of each selected path. Chains are followed to the end.
 */
export function applyFavoriteRename(
  renames: readonly { from: string; to: string }[],
  path: string,
): { target: string; chain: string[] } | undefined {
  const chain = [path], seen = new Set(chain);
  while (chain.length <= maxRenameHops) {
    const current = chain.at(-1)!;
    const rename = renames.find(entry => current === entry.from || current.startsWith(entry.from + "/"));
    if (!rename) break;
    const target = rename.to + current.slice(rename.from.length);
    if (seen.has(target)) break;
    seen.add(target);
    chain.push(target);
  }
  return chain.length > 1 ? { target: chain.at(-1)!, chain } : undefined;
}

/** Walks a current local path back to the name it had before pending renames. */
export function resolveFavoriteRenameSource(
  renames: readonly { from: string; to: string }[],
  path: string,
): string | undefined {
  const seen = new Set([path]);
  let current = path;
  while (seen.size <= maxRenameHops) {
    const rename = renames.find(entry => current === entry.to || current.startsWith(entry.to + "/"));
    if (!rename) break;
    const source = rename.from + current.slice(rename.to.length);
    if (seen.has(source)) break;
    seen.add(source);
    current = source;
  }
  return current === path ? undefined : current;
}

/** Local paths whose pre-rename name is derivable from pending rename records,
 * including directory renames and chained renames. Only paths that still exist
 * under the new name can be published.
 */
export function planFavoriteRenames(
  cachedPaths: readonly string[],
  renames: readonly { from: string; to: string }[],
): Array<{ from: string; to: string }> {
  const affected = cachedPaths.flatMap(to => {
    const from = resolveFavoriteRenameSource(renames, normalizePath(to));
    return from ? [{ from, to: normalizePath(to) }] : [];
  });
  return [...new Map(affected.map(entry => [entry.from, entry])).values()]
    .sort((left, right) => left.from.localeCompare(right.from));
}

/** The selected set is the union of remote favorite descendants and locally
 * cached files that still classify as favorites. Files that only exist locally
 * stay selected so an offline deletion or an exclusion is the only way out.
 * A never-synced local file with no baseline stays selected and is reported as
 * a conflict rather than silently deleted.
 */
export function planFavoriteCandidates(input: {
  folderId: string;
  favorites: readonly FavoriteRecord[];
  exclusions: readonly FavoriteExclusion[];
  patterns?: readonly string[];
  remote: readonly FileEntry[];
  local: readonly { path: string; sizeBytes: number; modifiedMs: number }[];
  baselines?: ReadonlyMap<string, FavoriteSyncBaseline>;
}): FavoriteCandidate[] {
  const candidates = new Map<string, FavoriteCandidate>();
  const isFavorite = (path: string) => classifyFavoritePath({ folderId: input.folderId, path, kind: "file" },
    input.favorites, input.exclusions, input.patterns).status === "favorite";
  for (const entry of input.remote) {
    if (entry.type !== "file") continue;
    const path = normalizePath(entry.path);
    if (!isFavorite(path)) continue;
    candidates.set(path, { path, remote: { size: entry.size, modifiedMs: entry.modifiedMs } });
  }
  for (const file of input.local) {
    const path = normalizePath(file.path);
    if (!isFavorite(path)) continue;
    const baseline = input.baselines?.get(path);
    candidates.set(path, { ...candidates.get(path), path,
      local: { sizeBytes: file.sizeBytes, modifiedMs: file.modifiedMs, ...(baseline ? { baseline } : {}) } });
  }
  return [...candidates.values()].sort((left, right) => left.path.localeCompare(right.path));
}
