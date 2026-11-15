import assert from "node:assert/strict";
import test from "node:test";
import { parseServiceFavoriteSyncStatus, parseServiceSessionStatusEvent } from "../packages/core/src/sync/serviceSessionStatus.ts";

const valid = {
  runId: 12, stage: "download", folderOrdinal: 1, folderCount: 2,
  itemOrdinal: 3, itemCount: 4, resultCount: 1, problemCount: 0,
  waitingCount: 0, elapsedMs: 12200, idleMs: 0, stalled: false,
  transferredBytes: 1048576, totalBytes: 4194304,
};

test("Android service sync progress is accepted only with bounded non-sensitive fields", () => {
  assert.deepEqual(parseServiceFavoriteSyncStatus(valid), valid);
  const parsed = parseServiceFavoriteSyncStatus({ ...valid, path: "secret.docx", token: "secret-token" });
  assert.deepEqual(parsed, valid, "An untrusted payload must not forward unexpected properties.");
  assert.ok(!JSON.stringify(parsed).includes("secret"));
  assert.equal(parseServiceFavoriteSyncStatus({ ...valid, stage: "secret-name" }), null);
  assert.equal(parseServiceFavoriteSyncStatus({ ...valid, itemCount: -1 }), null);
  assert.equal(parseServiceFavoriteSyncStatus({ ...valid, elapsedMs: Infinity }), null);
  assert.equal(parseServiceFavoriteSyncStatus({ ...valid, transferredBytes: -1 }), null);
  assert.equal(parseServiceFavoriteSyncStatus({ ...valid, transferredBytes: Number.MAX_SAFE_INTEGER + 1 }), null);
});

test("Android service events preserve valid sync diagnostics and reject untrusted data", () => {
  const event = { type: "sessionStatus", revision: 7, phase: "connected", active: true,
    foreground: true, sync: valid };
  assert.deepEqual(parseServiceSessionStatusEvent(event)?.sync, valid);
  assert.equal(parseServiceSessionStatusEvent({ ...event, sync: { ...valid, stage: "secret/path" } })?.sync, undefined);
});
