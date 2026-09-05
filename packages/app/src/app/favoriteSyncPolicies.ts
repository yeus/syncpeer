export interface FavoriteRemoteVersion {
  sizeBytes: number;
  modifiedMs: number;
}

export interface FavoriteSyncBaseline {
  lastRemoteSizeBytes: number;
  lastRemoteModifiedMs: number;
}

const sameRemoteVersion = (
  remote: FavoriteRemoteVersion,
  baseline: FavoriteRemoteVersion,
): boolean =>
  remote.sizeBytes === baseline.sizeBytes &&
  remote.modifiedMs === baseline.modifiedMs;

export const remoteFavoriteNeedsDownload = (
  remote: FavoriteRemoteVersion,
  liveBaseline?: FavoriteSyncBaseline,
  cachedBaseline?: { sizeBytes: number; modifiedMs?: number },
): boolean => {
  if (liveBaseline) {
    return !sameRemoteVersion(remote, {
      sizeBytes: liveBaseline.lastRemoteSizeBytes,
      modifiedMs: liveBaseline.lastRemoteModifiedMs,
    });
  }
  if (!Number.isFinite(cachedBaseline?.modifiedMs)) return false;
  return !sameRemoteVersion(remote, {
    sizeBytes: cachedBaseline?.sizeBytes ?? 0,
    modifiedMs: cachedBaseline?.modifiedMs ?? 0,
  });
};
