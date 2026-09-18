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

export function resolveFavoriteRenameTarget(
  renames: readonly { from: string; to: string }[],
  path: string,
): { target: string; chain: string[] } | undefined {
  const chain = [path], seen = new Set(chain);
  while (chain.length <= maxRenameHops) {
    const rename = renames.find(entry => entry.from === chain.at(-1));
    if (!rename || seen.has(rename.to)) break;
    seen.add(rename.to);
    chain.push(rename.to);
  }
  return chain.length > 1 ? { target: chain.at(-1)!, chain } : undefined;
}
