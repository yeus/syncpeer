import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionActions } from "../packages/app/src/app/connectionActions.ts";
import { createInitialState } from "../packages/app/src/app/state.ts";
import { createInitialSessionState } from "../packages/core/src/ui/sessionPolicies.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { resolve, promise };
};

const fixture = (refreshOverview: () => Promise<void>,
  syncStarredFiles: () => Promise<void> = async () => {},
  loadFavoriteSyncStates: () => Promise<void> = async () => {}) => {
  const state = createInitialState(null);
  const connection = createConnectionActions({
    state,
    client: {} as never,
    sessionStore: {
      actions: { refreshOverview }, getState: createInitialSessionState,
    } as never,
    transfers: { transferInProgress: () => false } as never,
    syncStarredFiles,
    loadFavoriteSyncStates,
    appInfo: { runtimeSurface: "android-ui" } as never,
  });
  return { connection, state };
};

test("simultaneous foreground and interval overview refresh uses only one native request", async () => {
  const gate = deferred();
  let calls = 0;
  const { connection, state } = fixture(async () => { calls++; await gate.promise; });
  state.session.isConnected = true;
  state.session.remoteFs = {} as never;
  const first = connection.refreshOverview();
  const second = connection.refreshOverview();
  assert.equal(first, second, "Concurrent callers share the same pending pass.");
  assert.equal(calls, 1);
  gate.resolve();
  await Promise.all([first, second]);
  // A later actual refresh is never suppressed indefinitely.
  state.session.isConnected = true;
  state.session.remoteFs = {} as never;
  await connection.refreshOverview();
  assert.equal(calls, 2);
  connection.dispose();
});

test("simultaneous view-refresh signals do not multiply document-index refresh work", async () => {
  const gate = deferred();
  let syncs = 0, statuses = 0;
  const { connection } = fixture(async () => { throw new Error("Should skip while disconnected"); },
    async () => { syncs++; await gate.promise; },
    async () => { statuses++; });
  const first = connection.refreshActiveView();
  const second = connection.refreshActiveView();
  assert.equal(first, second);
  assert.equal(syncs, 0, "The asynchronous coalesced pass has not resumed yet.");
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(syncs, 1);
  assert.equal(statuses, 1);
  await connection.refreshActiveView();
  assert.equal(syncs, 2);
  connection.dispose();
});
