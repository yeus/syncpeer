import assert from "node:assert/strict";
import test from "node:test";
import { remoteFavoriteNeedsDownload } from "../packages/app/src/app/favoriteSyncPolicies.ts";
import { createInitialState } from "../packages/app/src/app/state.ts";
import { createDirectoryActions } from "../packages/app/src/app/directoryActions.ts";
import { createStarredActions } from "../packages/app/src/app/starredActions.ts";

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

test("marking an uncached file favorite immediately downloads it", async () => {
  const state = createInitialState(null);
  state.ui.isAppVisible = true;
  state.session.isConnected = true;
  const content = new TextEncoder().encode("favorite content\n");
  const events: string[] = [];
  let cachedBytes: Uint8Array | undefined;
  const remoteFs = {
    readDir: async () => [{
      name: "favorite.txt",
      path: "favorite.txt",
      type: "file" as const,
      size: content.length,
      modifiedMs: 10,
    }],
    readFileFully: async () => {
      events.push("download");
      return content;
    },
  } as unknown as NonNullable<typeof state.session.remoteFs>;
  state.session.remoteFs = remoteFs;
  const client = {
    upsertFavorite: async (favorite: unknown) => {
      events.push("favorite");
      return [favorite];
    },
    getCachedStatuses: async () => [{ path: "favorite.txt", available: false }],
    listCachedFiles: async () => [],
    cacheFile: async (_folderId: string, _path: string, _name: string, bytes: Uint8Array) => {
      cachedBytes = bytes;
      events.push("cached");
    },
  } as unknown as Parameters<typeof createDirectoryActions>[0]["client"];
  const transfers = {
    begin: async () => undefined,
    update: () => undefined,
    finish: async () => undefined,
  } as unknown as Parameters<typeof createStarredActions>[0]["transfers"];
  const starred = createStarredActions({ state, client, transfers });
  const actions = createDirectoryActions({
    state,
    client,
    sessionStore: {} as Parameters<typeof createDirectoryActions>[0]["sessionStore"],
    refreshActiveView: async () => undefined,
    syncStarredFiles: starred.syncStarredFiles,
  });

  await actions.toggleFavorite("fixture-folder", "favorite.txt", "favorite.txt", "file");

  assert.deepEqual(events, ["favorite", "download", "cached"]);
  assert.deepEqual(cachedBytes, content);
  assert.equal(state.favorites.items.length, 1);
  assert.equal(state.favorites.cachedFileKeys.has("fixture-folder:favorite.txt"), true);
});
