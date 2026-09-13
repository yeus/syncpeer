import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FAVORITE_IGNORE_PATTERNS,
  classifyFavoritePath,
  collectFavoriteFiles,
  cacheQuotaBytes,
  defaultProfileSettings,
  planCacheEvictions,
  type FavoriteRecord,
} from "../packages/core/dist/browser.js";

const folder = (path: string): FavoriteRecord => ({
  key: `folder:${path}`,
  folderId: "photos",
  path,
  name: path.split("/").at(-1) || "Photos",
  kind: "folder",
});

test("folder favorites include present and future descendants", () => {
  const favorite = folder("album");
  assert.equal(classifyFavoritePath({ folderId: "photos", path: "album/new/image.jpg", kind: "file" },
    [favorite], []).status, "favorite");
  assert.equal(classifyFavoritePath({ folderId: "photos", path: "elsewhere/image.jpg", kind: "file" },
    [favorite], []).status, "remote-only");
});

test("default rules ignore expensive generated trees and explain why", () => {
  const result = classifyFavoritePath({ folderId: "photos", path: "project/node_modules/pkg/index.js", kind: "file" },
    [folder("")], [], DEFAULT_FAVORITE_IGNORE_PATTERNS);
  assert.deepEqual(result, { status: "ignored", reason: "pattern", rule: "node_modules/" });
});

test("explicit exclusions win inside a favorite tree", () => {
  const result = classifyFavoritePath({ folderId: "photos", path: "album/raw/image.dng", kind: "file" },
    [folder("album")], [{ folderId: "photos", path: "album/raw", kind: "folder" }]);
  assert.deepEqual(result, { status: "ignored", reason: "explicit", rule: "album/raw" });
});

test("a nested explicit favorite overrides a pattern or broader exclusion", () => {
  const favorites = [folder("project"), folder("project/node_modules/required-package")];
  const exclusions = [{ folderId: "photos", path: "project/node_modules", kind: "folder" as const }];
  assert.equal(classifyFavoritePath({ folderId: "photos",
    path: "project/node_modules/required-package/index.js", kind: "file" },
  favorites, exclusions, DEFAULT_FAVORITE_IGNORE_PATTERNS).status, "favorite");
});

test("rules and favorites do not leak between folders", () => {
  const result = classifyFavoritePath({ folderId: "documents", path: "album/image.jpg", kind: "file" },
    [folder("album")], [{ folderId: "photos", path: "album", kind: "folder" }]);
  assert.equal(result.status, "remote-only");
});

test("recursive collection traverses favorite folders without entering ignored trees", async () => {
  const reads: string[] = [];
  const tree = new Map([
    ["project", [
      { name: "src", path: "project/src", type: "directory" as const, size: 0, modifiedMs: 1 },
      { name: "node_modules", path: "project/node_modules", type: "directory" as const, size: 0, modifiedMs: 1 },
    ]],
    ["project/src", [
      { name: "index.ts", path: "project/src/index.ts", type: "file" as const, size: 4, modifiedMs: 2 },
    ]],
  ]);
  const files = await collectFavoriteFiles({
    folderId: "photos",
    favorites: [folder("project")],
    exclusions: [],
    readDir: async path => { reads.push(path); return tree.get(path) ?? []; },
  });
  assert.deepEqual(files.map(file => file.path), ["project/src/index.ts"]);
  assert.deepEqual(reads, ["project", "project/src"]);
});

test("explicit file favorites use live remote metadata", async () => {
  const files = await collectFavoriteFiles({
    folderId: "photos",
    favorites: [{ key: "photo", folderId: "photos", path: "album/photo.jpg",
      name: "photo.jpg", kind: "file" }],
    exclusions: [],
    readDir: async path => path === "album" ? [
      { name: "photo.jpg", path: "album/photo.jpg", type: "file", size: 42, modifiedMs: 123 },
    ] : [],
  });
  assert.deepEqual(files, [
    { name: "photo.jpg", path: "album/photo.jpg", type: "file", size: 42, modifiedMs: 123 },
  ]);
});

test("adaptive cache quota is bounded and LRU eviction never selects protected content", () => {
  const cache = defaultProfileSettings().profile.cache;
  assert.equal(cacheQuotaBytes(100 * 1024 * 1024 * 1024, cache), 5 * 1024 * 1024 * 1024);
  assert.equal(cacheQuotaBytes(1024 * 1024 * 1024, cache), 512 * 1024 * 1024);
  assert.deepEqual(planCacheEvictions([
    { key: "favorite", sizeBytes: 8, lastAccessedMs: 1, protected: true },
    { key: "old", sizeBytes: 5, lastAccessedMs: 2, protected: false },
    { key: "new", sizeBytes: 5, lastAccessedMs: 3, protected: false },
  ], 13), ["old"]);
});
