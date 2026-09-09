import {
  cachedFileKey,
  normalizePath,
  type SyncpeerBrowserClient,
} from "@syncpeer/core/browser";
import type { AppState } from "./state.ts";

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
  );
  const next = new Set(state.favorites.cachedFileKeys);
  for (const response of responses) {
    const key = cachedFileKey(response.folderId, "");
    if (response.statuses[0]?.available ?? false) next.add(key);
    else next.delete(key);
  }
  state.favorites.cachedFileKeys = next;
};
