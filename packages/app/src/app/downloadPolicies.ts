import { cachedFileKey } from "@syncpeer/core/browser";
import type { AppState } from "./state.ts";

export const updateCachedKey = (
  state: AppState,
  folderId: string,
  path: string,
  available: boolean,
) => {
  const next = new Set(state.favorites.cachedFileKeys);
  const key = cachedFileKey(folderId, path);
  if (available) next.add(key);
  else next.delete(key);
  state.favorites.cachedFileKeys = next;
};
