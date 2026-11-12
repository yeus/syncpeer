import {
  cachedFileKey,
  normalizePath,
  type SyncpeerBrowserClient,
} from "@syncpeer/core/browser";
import { pushSessionLog, type AppState } from "./state.ts";

export const refreshCachedStatuses = async (
  state: AppState,
  client: SyncpeerBrowserClient,
  folderId: string,
  paths: string[],
) => {
  if (!folderId || paths.length === 0) return;
  const statuses = await client.getCachedStatuses(
    folderId,
    paths.map((path) => normalizePath(path)),
  );
  const next = new Set(state.favorites.cachedFileKeys);
  for (const status of statuses) {
    const key = cachedFileKey(folderId, status.path);
    if (status.available) next.add(key);
    else next.delete(key);
  }
  state.favorites.cachedFileKeys = next;
};

export const refreshFolderRootCachedStatuses = async (
  state: AppState,
  client: SyncpeerBrowserClient,
  folderIds: string[],
) => {
  const uniqueIds = [...new Set(folderIds.map((id) => id.trim()).filter(Boolean))];
  const responses = await Promise.all(
    uniqueIds.map(async (folderId) => ({
      folderId,
      statuses: await client.getCachedStatuses(folderId, [""]),
    })),
  ).catch((error: unknown) => {
    // This only decorates favorites with "is cached" flags. An unreadable
    // downloaded-file index must never discard an authenticated peer session.
    pushSessionLog(
      state,
      "warning",
      "peer.cached_status.failed",
      "Downloaded-file status is unavailable; the peer connection is kept.",
      { message: error instanceof Error ? error.message : String(error) },
    );
    return null;
  });
  if (!responses) return;
  const next = new Set(state.favorites.cachedFileKeys);
  for (const response of responses) {
    const key = cachedFileKey(response.folderId, "");
    if (response.statuses[0]?.available ?? false) next.add(key);
    else next.delete(key);
  }
  state.favorites.cachedFileKeys = next;
};
