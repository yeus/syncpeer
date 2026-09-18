import ignore from "ignore";
import { normalizePath } from "./helpers.js";
import type { FavoriteRecord } from "./browserClient.js";
import type { FileEntry } from "../core/model/remoteFs.js";

export const DEFAULT_FAVORITE_IGNORE_PATTERNS = [
  "node_modules/",
  ".git/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  ".cache/",
  ".idea/caches/",
  ".idea/system/",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
] as const;

export interface FavoriteExclusion {
  folderId: string;
  path: string;
  kind: "folder" | "file";
}

export type FavoritePathState =
  | { status: "favorite" }
  | { status: "remote-only" }
  | { status: "ignored"; reason: "explicit" | "pattern"; rule: string };

const contains = (owner: Pick<FavoriteRecord | FavoriteExclusion, "path" | "kind">, path: string) => {
  const root = normalizePath(owner.path);
  return owner.kind === "file" ? root === path : root === "" || path === root || path.startsWith(`${root}/`);
};

const deepest = <T extends Pick<FavoriteRecord | FavoriteExclusion, "path" | "kind">>(items: readonly T[], path: string) =>
  items.filter(item => contains(item, path)).sort((left, right) => normalizePath(right.path).length - normalizePath(left.path).length)[0];

const matchingPattern = (patterns: readonly string[], path: string, kind: "folder" | "file") =>
  patterns.find(pattern => ignore().add(pattern).ignores(kind === "folder" ? `${path}/` : path));

export function classifyFavoritePath(
  target: { folderId: string; path: string; kind: "folder" | "file" },
  favorites: readonly FavoriteRecord[],
  exclusions: readonly FavoriteExclusion[],
  patterns: readonly string[] = DEFAULT_FAVORITE_IGNORE_PATTERNS,
): FavoritePathState {
  const path = normalizePath(target.path);
  const localFavorites = favorites.filter(item => item.folderId === target.folderId);
  const favorite = deepest(localFavorites, path);
  if (!favorite) return { status: "remote-only" };

  const exclusion = deepest(exclusions.filter(item => item.folderId === target.folderId), path);
  const explicitFavoriteWins = exclusion && normalizePath(favorite.path).length >= normalizePath(exclusion.path).length;
  if (exclusion && !explicitFavoriteWins) {
    return { status: "ignored", reason: "explicit", rule: normalizePath(exclusion.path) };
  }

  const pattern = matchingPattern(patterns, path, target.kind);
  if (!pattern) return { status: "favorite" };
  const favoriteOverridesPattern = normalizePath(favorite.path) !== "" &&
    matchingPattern(patterns, normalizePath(favorite.path), favorite.kind) !== undefined;
  return favoriteOverridesPattern ? { status: "favorite" } :
    { status: "ignored", reason: "pattern", rule: pattern };
}

export async function collectFavoriteFiles(options: {
  folderId: string;
  favorites: readonly FavoriteRecord[];
  exclusions: readonly FavoriteExclusion[];
  patterns?: readonly string[];
  readDir: (path: string) => Promise<FileEntry[]>;
  /** Called with each visited favorite directory so callers can persist listings. */
  onDirectory?: (path: string, entries: FileEntry[]) => Promise<void> | void;
}): Promise<FileEntry[]> {
  const patterns = options.patterns ?? DEFAULT_FAVORITE_IGNORE_PATTERNS;
  const directFiles = options.favorites
    .filter(item => item.folderId === options.folderId && item.kind === "file");
  const directDirectories = new Map<string, Promise<FileEntry[]>>();
  const files = (await Promise.all(directFiles.map(async favorite => {
    const path = normalizePath(favorite.path);
    const parent = path.split("/").slice(0, -1).join("/");
    const entries = directDirectories.get(parent) ?? options.readDir(parent);
    directDirectories.set(parent, entries);
    return (await entries).find(entry => entry.type === "file" && normalizePath(entry.path) === path);
  }))).filter((file): file is FileEntry => file !== undefined);
  const pending = options.favorites
    .filter(item => item.folderId === options.folderId && item.kind === "folder")
    .map(item => normalizePath(item.path));
  const visited = new Set<string>();
  while (pending.length) {
    const directory = pending.shift()!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    const entries = await options.readDir(directory);
    await options.onDirectory?.(directory, entries);
    for (const entry of entries) {
      const kind = entry.type === "directory" ? "folder" as const : "file" as const;
      const state = classifyFavoritePath({ folderId: options.folderId, path: entry.path, kind },
        options.favorites, options.exclusions, patterns);
      if (state.status !== "favorite") continue;
      if (entry.type === "directory") pending.push(normalizePath(entry.path));
      else if (entry.type === "file") files.push(entry);
    }
  }
  return [...new Map(files.map(file => [normalizePath(file.path), file])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
}
