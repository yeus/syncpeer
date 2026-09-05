import assert from "node:assert/strict";
import test from "node:test";
import { remoteFavoriteNeedsDownload } from "../packages/app/src/app/favoriteSyncPolicies.ts";
import { createInitialState } from "../packages/app/src/app/state.ts";

test("keeps experimental PIM synchronization disabled by default", () => {
  assert.equal(createInitialState(null).pim.enabled, false);
});

test("detects a remote favorite update from persisted cache metadata", () => {
  assert.equal(
    remoteFavoriteNeedsDownload(
      { sizeBytes: 12, modifiedMs: 200 },
      undefined,
      { sizeBytes: 12, modifiedMs: 100 },
    ),
    true,
  );
});

test("uses the live sync baseline before persisted cache metadata", () => {
  assert.equal(
    remoteFavoriteNeedsDownload(
      { sizeBytes: 12, modifiedMs: 200 },
      { lastRemoteSizeBytes: 12, lastRemoteModifiedMs: 200 },
      { sizeBytes: 8, modifiedMs: 100 },
    ),
    false,
  );
  assert.equal(
    remoteFavoriteNeedsDownload(
      { sizeBytes: 13, modifiedMs: 200 },
      { lastRemoteSizeBytes: 12, lastRemoteModifiedMs: 200 },
      undefined,
    ),
    true,
  );
});

test("does not invent a remote change without a comparable baseline", () => {
  assert.equal(
    remoteFavoriteNeedsDownload(
      { sizeBytes: 12, modifiedMs: 200 },
      undefined,
      { sizeBytes: 12 },
    ),
    false,
  );
});
