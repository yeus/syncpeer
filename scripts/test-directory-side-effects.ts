import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSessionState } from "../packages/core/src/ui/sessionPolicies.ts";
import { createDirectoryActions } from "../packages/app/src/app/directoryActions.ts";
import { createInitialState } from "../packages/app/src/app/state.ts";

const createFixture = (options: { localFolder: boolean; snapshotFails: boolean }) => {
  const state = createInitialState(null);
  const session = createInitialSessionState();
  session.phase = "connected";
  session.remoteFs = {} as never;
  session.folders = [{ id: "f1", label: "Photos", encrypted: false, needsPassword: false } as never];
  session.directory = {
    ...session.directory,
    folderId: "f1",
    path: "photos",
    entries: [{ name: "a.txt", path: "photos/a.txt", type: "file", sizeBytes: 1 } as never],
    status: "ready",
    versionKey: "v1",
  };
  state.session.isConnected = true;
  state.session.remoteFs = session.remoteFs;
  state.session.folders = session.folders;
  state.session.currentFolderId = "f1";
  state.session.currentPath = "photos";
  if (options.localFolder) state.localFolders = [{ id: "f1", label: "Photos", readOnly: false }];
  const snapshotWrites: string[] = [];
  const actions = createDirectoryActions({
    state,
    client: {
      getCachedStatuses: async () => [],
      saveDirectorySnapshot: async (folderId: string) => {
        snapshotWrites.push(folderId);
        // The document owner rejects a folder it has no local storage for.
        if (options.snapshotFails) throw new Error("Document folder is unavailable.");
      },
    } as never,
    sessionStore: {
      getState: () => session,
      actions: { goToPath: async () => undefined },
    } as never,
    refreshActiveView: async () => undefined,
    syncStarredFiles: async () => undefined,
  });
  return { state, actions, snapshotWrites };
};

test("opening a remote-only folder does not write a listing snapshot", async () => {
  const { state, actions, snapshotWrites } = createFixture({ localFolder: false, snapshotFails: true });
  await actions.openDirectory("sub");
  assert.deepEqual(snapshotWrites, [],
    "A folder without local storage cannot store a snapshot and must not try.");
  assert.equal(state.ui.recentError, null);
});

test("a failing listing snapshot does not report the opened folder as failed", async () => {
  const { state, actions, snapshotWrites } = createFixture({ localFolder: true, snapshotFails: true });
  await actions.openDirectory("sub");
  assert.deepEqual(snapshotWrites, ["f1"]);
  assert.equal(state.ui.recentError, null,
    "Browsing succeeded; an unwritable offline listing must not raise a failure banner.");
  assert.ok(state.logs.items.some(item => item.event === "folder.side_effects.failed"),
    "The skipped offline listing must still be visible as a warning.");
});
