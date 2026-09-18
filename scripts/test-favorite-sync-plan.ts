import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFavoriteRename,
  planFavoriteCandidates,
  planFavoriteRename,
  planFavoriteRenames,
  planFavoriteSync,
} from "../packages/core/src/sync/favoriteSyncPlan.ts";
import { DEFAULT_FAVORITE_IGNORE_PATTERNS } from "../packages/core/src/ui/favoriteSelection.ts";

const baseline = { hash: "a".repeat(64), sizeBytes: 3, modifiedMs: 10 };
const remote = { size: 3, modifiedMs: 10 };

test("downloads a remote favorite that has no local copy and no baseline", () => {
  assert.deepEqual(
    planFavoriteSync({ remote }),
    { kind: "download", expectedLocalHash: null },
  );
});

test("refuses to guess when both copies exist without a verified baseline", () => {
  assert.equal(planFavoriteSync({ local: { hash: "b".repeat(64) }, remote }).kind, "conflict");
});

test("uploads a local-only file that has no verified baseline", () => {
  assert.deepEqual(
    planFavoriteSync({ local: { hash: "b".repeat(64) } }),
    { kind: "upload" },
  );
});

test("stays unchanged when neither side exists", () => {
  assert.deepEqual(planFavoriteSync({}), { kind: "unchanged" });
  assert.deepEqual(planFavoriteSync({ baseline }), { kind: "unchanged" });
});

test("keeps an unchanged favorite untouched", () => {
  assert.deepEqual(
    planFavoriteSync({ local: { hash: baseline.hash }, remote, baseline }),
    { kind: "unchanged" },
  );
});

test("downloads a changed peer copy without touching the local hash", () => {
  assert.deepEqual(
    planFavoriteSync({ local: { hash: baseline.hash }, remote: { size: 4, modifiedMs: 20 }, baseline }),
    { kind: "download", expectedLocalHash: baseline.hash },
  );
});

test("uploads an offline local edit", () => {
  assert.deepEqual(
    planFavoriteSync({ local: { hash: "c".repeat(64) }, remote, baseline }),
    { kind: "upload" },
  );
});

test("preserves both sides when local and peer copies changed", () => {
  assert.equal(
    planFavoriteSync({ local: { hash: "c".repeat(64) }, remote: { size: 9, modifiedMs: 20 }, baseline }).kind,
    "conflict",
  );
});

test("propagates a local deletion only while the peer copy is unchanged", () => {
  assert.deepEqual(planFavoriteSync({ remote, baseline }), { kind: "delete-remote", reason: "local-deleted" });
  assert.equal(planFavoriteSync({ remote: { size: 4, modifiedMs: 20 }, baseline }).kind, "conflict");
});

test("propagates a peer deletion only while the local copy is unchanged", () => {
  assert.deepEqual(
    planFavoriteSync({ local: { hash: baseline.hash }, baseline }),
    { kind: "delete-local", reason: "remote-deleted" },
  );
  assert.equal(planFavoriteSync({ local: { hash: "c".repeat(64) }, baseline }).kind, "conflict");
});

test("follows a rename chain and stops at the final local path", () => {
  assert.deepEqual(
    applyFavoriteRename([{ from: "a.txt", to: "b.txt" }, { from: "b.txt", to: "c.txt" }], "a.txt"),
    { target: "c.txt", chain: ["a.txt", "b.txt", "c.txt"] },
  );
  assert.deepEqual(applyFavoriteRename([{ from: "a.txt", to: "b.txt" }], "b.txt"), undefined);
  assert.deepEqual(applyFavoriteRename([{ from: "a.txt", to: "b.txt" }], "z.txt"), undefined);
});

test("a directory rename rewrites the prefix of every descendant path", () => {
  assert.deepEqual(
    applyFavoriteRename([{ from: "docs", to: "notes" }], "docs/2026/report.txt"),
    { target: "notes/2026/report.txt", chain: ["docs/2026/report.txt", "notes/2026/report.txt"] },
  );
  assert.deepEqual(applyFavoriteRename([{ from: "docs", to: "notes" }], "docs-other/report.txt"), undefined);
});

test("groups local paths under a pending directory rename into per-file publications", () => {
  assert.deepEqual(
    planFavoriteRenames(
      ["notes/a.txt", "notes/sub/b.txt", "notes-other/c.txt"],
      [{ from: "docs", to: "notes" }],
    ),
    [
      { from: "docs/a.txt", to: "notes/a.txt" },
      { from: "docs/sub/b.txt", to: "notes/sub/b.txt" },
    ],
  );
});

test("a rename chain groups only the paths that resolve to the new name", () => {
  assert.deepEqual(
    planFavoriteRenames(["c.txt"], [{ from: "a.txt", to: "b.txt" }, { from: "b.txt", to: "c.txt" }]),
    [{ from: "a.txt", to: "c.txt" }],
  );
  assert.deepEqual(planFavoriteRenames(["b.txt"], [{ from: "a.txt", to: "b.txt" }]),
    [{ from: "a.txt", to: "b.txt" }],
    "A pending rename always publishes the new name and tombstones the old one");
});

test("selects remote favorite descendants and locally cached favorites", () => {
  const favorites = [{ key: "folder:folder:docs", folderId: "folder", path: "docs", name: "docs", kind: "folder" as const }];
  const remote = [
    { name: "keep.txt", path: "docs/keep.txt", type: "file" as const, size: 5, modifiedMs: 1 },
    { name: "skip.log", path: "docs/skip.log", type: "file" as const, size: 5, modifiedMs: 1 },
    { name: "other.txt", path: "other.txt", type: "file" as const, size: 5, modifiedMs: 1 },
  ];
  const candidates = planFavoriteCandidates({
    folderId: "folder", favorites, exclusions: [],
    patterns: ["*.log"],
    remote,
    local: [
      { path: "docs/keep.txt", sizeBytes: 5, modifiedMs: 1 },
      { path: "docs/offline.txt", sizeBytes: 7, modifiedMs: 2 },
      { path: "unselected.txt", sizeBytes: 7, modifiedMs: 2 },
    ],
    baselines: new Map([["docs/keep.txt", baseline]]),
  });
  assert.deepEqual(candidates.map(candidate => candidate.path), ["docs/keep.txt", "docs/offline.txt"]);
  assert.equal(candidates[0].remote?.size, 5);
  assert.deepEqual(candidates[0].local?.baseline, baseline);
  assert.equal(candidates[1].local?.sizeBytes, 7);
  assert.equal(candidates[1].remote, undefined);
});

test("keeps a locally cached favorite that an exclusion would otherwise drop", () => {
  const candidates = planFavoriteCandidates({
    folderId: "folder",
    favorites: [{ key: "folder:folder:docs", folderId: "folder", path: "docs", name: "docs", kind: "folder" }],
    exclusions: [{ folderId: "folder", path: "docs/private.txt", kind: "file" }],
    patterns: [...DEFAULT_FAVORITE_IGNORE_PATTERNS],
    remote: [{ name: "private.txt", path: "docs/private.txt", type: "file", size: 5, modifiedMs: 1 }],
    local: [{ path: "docs/private.txt", sizeBytes: 5, modifiedMs: 1 }],
  });
  assert.deepEqual(candidates, [], "Excluded paths are neither downloaded nor reported");
});

test("publishes a rename when the old peer path is unchanged or already gone", () => {
  const local = { size: 3, hash: baseline.hash };
  assert.deepEqual(planFavoriteRename({ local, remoteSource: remote, baseline }),
    { kind: "publish", removeRemote: true });
  assert.deepEqual(planFavoriteRename({ local, baseline }),
    { kind: "publish", removeRemote: false });
});

test("treats a rename as a conflict when the old peer path changed or the new one exists", () => {
  const local = { size: 3, hash: baseline.hash };
  assert.equal(planFavoriteRename({ local, remoteSource: { size: 4, modifiedMs: 20 }, baseline }).kind, "conflict");
  assert.equal(planFavoriteRename({ local, remoteSource: remote, remoteTarget: remote, baseline }).kind, "conflict");
  assert.equal(planFavoriteRename({ local, remoteSource: remote }).kind, "conflict");
});

test("accepts an interrupted rename publication of the same size as a resumable publish", () => {
  const local = { size: 3, hash: baseline.hash };
  assert.deepEqual(
    planFavoriteRename({ local, remoteSource: remote, remoteTarget: remote, baseline, resumeTarget: true }),
    { kind: "publish", removeRemote: true },
  );
  assert.equal(planFavoriteRename({ local, remoteSource: remote,
    remoteTarget: { size: 9, modifiedMs: 30 }, baseline, resumeTarget: true }).kind, "conflict");
});
