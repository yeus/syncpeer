import { DEFAULT_FAVORITE_IGNORE_PATTERNS, type FavoriteExclusion } from "../ui/favoriteSelection.js";
import type { FavoriteRecord } from "../ui/browserClient.js";
import type { FolderVersioningMode } from "./folderSync.js";

export interface SyncpeerFolderSettings {
  favorites: FavoriteRecord[];
  exclusions: FavoriteExclusion[];
  ignorePatterns: string[];
  paused: boolean;
}

export interface SyncpeerProfileSettings {
  format: 1;
  profile: {
    versioning: FolderVersioningMode;
    preserveLocalChanges: boolean;
    cache: { percent: number; minimumBytes: number; maximumBytes: number; overrideBytes?: number };
    allowMetered: boolean;
    autoMount: boolean;
  };
  folders: Record<string, SyncpeerFolderSettings>;
  devices: Record<string, { allowMetered?: boolean }>;
}

export const defaultProfileSettings = (): SyncpeerProfileSettings => ({
  format: 1,
  profile: {
    versioning: "staggered",
    preserveLocalChanges: true,
    cache: { percent: 5, minimumBytes: 512 * 1024 * 1024, maximumBytes: 5 * 1024 * 1024 * 1024 },
    allowMetered: false,
    autoMount: false,
  },
  folders: {},
  devices: {},
});

export const defaultFolderSettings = (): SyncpeerFolderSettings => ({
  favorites: [],
  exclusions: [],
  ignorePatterns: [...DEFAULT_FAVORITE_IGNORE_PATTERNS],
  paused: false,
});

const safeText = (value: unknown, label: string, maximum = 4096) => {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new Error(`Invalid ${label}.`);
  return value;
};

const normalizeFavorite = (folderId: string, value: unknown): FavoriteRecord => {
  const item = value as Partial<FavoriteRecord>;
  if (!item || typeof item !== "object" || (item.kind !== "file" && item.kind !== "folder")) throw new Error("Invalid favorite settings.");
  return { folderId, key: safeText(item.key, "favorite key"), path: safeText(item.path, "favorite path"),
    name: safeText(item.name, "favorite name"), kind: item.kind };
};

const normalizeFolder = (folderId: string, value: unknown): SyncpeerFolderSettings => {
  const folder = value as Partial<SyncpeerFolderSettings>;
  if (!folder || typeof folder !== "object" || !Array.isArray(folder.favorites) || !Array.isArray(folder.exclusions) ||
    !Array.isArray(folder.ignorePatterns) || typeof folder.paused !== "boolean" || folder.favorites.length > 10000 ||
    folder.exclusions.length > 10000 || folder.ignorePatterns.length > 1000) throw new Error("Invalid folder settings.");
  return {
    favorites: folder.favorites.map(item => normalizeFavorite(folderId, item)),
    exclusions: folder.exclusions.map(value => {
      const item = value as Partial<FavoriteExclusion>;
      if (!item || typeof item !== "object" || (item.kind !== "file" && item.kind !== "folder")) throw new Error("Invalid favorite exclusion.");
      return { folderId, path: safeText(item.path, "favorite exclusion"), kind: item.kind };
    }),
    ignorePatterns: folder.ignorePatterns.map(value => safeText(value, "ignore pattern", 1024)),
    paused: folder.paused,
  };
};

export function normalizeProfileSettings(value: unknown): SyncpeerProfileSettings {
  if (value === undefined) return defaultProfileSettings();
  const settings = value as Partial<SyncpeerProfileSettings>;
  const profile = settings?.profile;
  if (!settings || settings.format !== 1 || !profile || typeof profile !== "object" ||
    !settings.folders || typeof settings.folders !== "object" || Array.isArray(settings.folders) ||
    !settings.devices || typeof settings.devices !== "object" || Array.isArray(settings.devices) ||
    Object.keys(settings.folders).length > 10000 || Object.keys(settings.devices).length > 1000 ||
    !["disabled", "trash", "simple", "staggered"].includes(String(profile.versioning)) ||
    typeof profile.preserveLocalChanges !== "boolean" || typeof profile.allowMetered !== "boolean" ||
    typeof profile.autoMount !== "boolean" || !profile.cache || typeof profile.cache !== "object") {
    throw new Error("Invalid profile settings.");
  }
  const cache = profile.cache;
  if (![cache.percent, cache.minimumBytes, cache.maximumBytes].every(Number.isSafeInteger) ||
    cache.percent < 0 || cache.percent > 100 || cache.minimumBytes < 0 || cache.maximumBytes < cache.minimumBytes ||
    (cache.overrideBytes !== undefined && (!Number.isSafeInteger(cache.overrideBytes) || cache.overrideBytes < 0))) {
    throw new Error("Invalid cache settings.");
  }
  const folders = Object.fromEntries(Object.entries(settings.folders).map(([id, folder]) =>
    [safeText(id, "settings folder identifier", 1024), normalizeFolder(id, folder)]));
  const devices = Object.fromEntries(Object.entries(settings.devices).map(([id, device]) => {
    const item = device as { allowMetered?: unknown };
    if (!item || typeof item !== "object" || (item.allowMetered !== undefined && typeof item.allowMetered !== "boolean")) {
      throw new Error("Invalid device settings.");
    }
    return [safeText(id, "settings device identifier", 1024),
      item.allowMetered === undefined ? {} : { allowMetered: item.allowMetered }];
  }));
  return { format: 1, profile: { versioning: profile.versioning as FolderVersioningMode,
    preserveLocalChanges: profile.preserveLocalChanges, cache: { ...cache }, allowMetered: profile.allowMetered,
    autoMount: profile.autoMount }, folders, devices };
}

export const cacheQuotaBytes = (availableBytes: number, settings: SyncpeerProfileSettings["profile"]["cache"]) => {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) throw new Error("Invalid available storage size.");
  if (settings.overrideBytes !== undefined) return Math.min(settings.overrideBytes, availableBytes);
  return Math.min(availableBytes, settings.maximumBytes,
    Math.max(settings.minimumBytes, Math.floor(availableBytes * settings.percent / 100)));
};

export interface CacheCandidate {
  key: string;
  sizeBytes: number;
  lastAccessedMs: number;
  protected: boolean;
}

export function planCacheEvictions(candidates: readonly CacheCandidate[], quotaBytes: number): string[] {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0 || candidates.some(candidate =>
    !candidate.key || !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < 0 ||
    !Number.isSafeInteger(candidate.lastAccessedMs) || candidate.lastAccessedMs < 0)) throw new Error("Invalid cache inventory.");
  let retainedBytes = candidates.reduce((total, candidate) => total + candidate.sizeBytes, 0);
  const evicted: string[] = [];
  for (const candidate of [...candidates].filter(candidate => !candidate.protected)
    .sort((left, right) => left.lastAccessedMs - right.lastAccessedMs || left.key.localeCompare(right.key))) {
    if (retainedBytes <= quotaBytes) break;
    retainedBytes -= candidate.sizeBytes;
    evicted.push(candidate.key);
  }
  return evicted;
}
