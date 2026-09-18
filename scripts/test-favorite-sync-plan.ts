import assert from "node:assert/strict";
import test from "node:test";
import {
  planFavoriteRename,
  planFavoriteSync,
  resolveFavoriteRenameTarget,
} from "../packages/core/src/sync/favoriteSyncPlan.ts";

const baseline = { hash: "a".repeat(64), sizeBytes: 3, modifiedMs: 10 };
const remote = { size: 3, modifiedMs: 10 };

test("downloads a remote favorite that has no local copy and no baseline", () => {
  assert.deepEqual(
    planFavoriteSync({ remote }),
    { kind: "download", expectedLocalHash: null },
  );
});

test("refuses to guess when a local favorite has no verified baseline", () => {
  assert.equal(planFavoriteSync({ local: { hash: "b".repeat(64) }, remote }).kind, "conflict");
  assert.equal(planFavoriteSync({ local: { hash: "b".repeat(64) } }).kind, "conflict");
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
    resolveFavoriteRenameTarget([{ from: "a.txt", to: "b.txt" }, { from: "b.txt", to: "c.txt" }], "a.txt"),
    { target: "c.txt", chain: ["a.txt", "b.txt", "c.txt"] },
  );
  assert.deepEqual(resolveFavoriteRenameTarget([{ from: "a.txt", to: "b.txt" }], "b.txt"), undefined);
  assert.deepEqual(resolveFavoriteRenameTarget([{ from: "a.txt", to: "b.txt" }], "z.txt"), undefined);
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
