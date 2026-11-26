import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSessionState } from "../packages/core/src/ui/sessionPolicies.ts";
import { createDirectoryActions } from "../packages/app/src/app/directoryActions.ts";
import { loadDirectorySideEffects } from "../packages/app/src/app/actionSupport.ts";
import { applySessionState, createInitialState, localDocumentFolders } from "../packages/app/src/app/state.ts";
import { saveOfflineDirectorySnapshot, saveOfflineSnapshot } from "../packages/app/src/app/syncPolicies.ts";

const createFixture = (options: { localFolder: boolean; snapshotFails: boolean; browseOnly?: boolean }) => {
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
  if (options.localFolder) state.localFolders = [{ id: "f1", label: "Photos", readOnly: false,
    ...(options.browseOnly ? { browseOnly: true } : {}) }];
  const snapshotWrites: string[] = [];
  const client = {
    listLocalDirectory: async () => [],
    getCachedStatuses: async () => [],
    saveDirectorySnapshot: async (folderId: string) => {
      snapshotWrites.push(folderId);
      if (options.snapshotFails) throw new Error("Document folder is unavailable.");
    },
  } as never;
  const actions = createDirectoryActions({
    state,
    client,
    sessionStore: {
      getState: () => session,
      actions: { goToPath: async () => undefined },
    } as never,
    refreshActiveView: async () => undefined,
    syncStarredFiles: async () => undefined,
  });
  return { state, actions, snapshotWrites, client };
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

test("refreshing a registered browse-only folder never writes an unavailable snapshot", async () => {
  const { state, client, snapshotWrites } = createFixture({
    localFolder: true, browseOnly: true, snapshotFails: true,
  });
  // This is the 15-second refresh path, not the open-folder catch boundary.
  await loadDirectorySideEffects(state, client);
  assert.deepEqual(snapshotWrites, [],
    "Registered browse-only folders are not writable local replicas.");
});

test("browse-only periodic refresh preserves remote browsing and writable-folder snapshot behavior", async () => {
  const { state, client, actions, snapshotWrites } = createFixture({
    localFolder: true, browseOnly: true, snapshotFails: false,
  });
  state.session.folders.push({ id: "writable", label: "Writable", readOnly: false } as never);
  state.localFolders.push({ id: "writable", label: "Writable", readOnly: false });
  await loadDirectorySideEffects(state, client);
  await loadDirectorySideEffects(state, client);
  assert.deepEqual(snapshotWrites, [], "Repeated browse-only refreshes cannot write a derived local replica.");
  await actions.openLocation("f1", "photos", "test.browse_only", {});
  assert.equal(state.ui.recentError, null);
  assert.equal(state.session.currentFolderId, "f1", "Remote browsing must remain usable after refresh.");
  assert.deepEqual(snapshotWrites, []);
  state.session.currentFolderId = "writable";
  await loadDirectorySideEffects(state, client);
  assert.deepEqual(snapshotWrites, ["writable"],
    "Browse-only policy must not suppress snapshots for unrelated writable folders.");
});

test("session folder projection preserves browse-only storage policy across overview updates", async () => {
  const { state, client, snapshotWrites } = createFixture({ localFolder: false, snapshotFails: true });
  state.localFolders = localDocumentFolders([
    { id: "f1", label: "Photos", browseOnly: true, downloads: false },
  ]);
  assert.equal(state.localFolders[0]?.browseOnly, true);
  await loadDirectorySideEffects(state, client);
  assert.deepEqual(snapshotWrites, [], "A session update must not turn browsing into a snapshot write.");
});

test("offline browsing prefers the saved remote listing to an empty local downloads folder", async () => {
  const state = createInitialState(null);
  const peerId = "A".repeat(52);
  state.connection.remoteId = peerId;
  const cached = [{ name: "remote.txt", path: "album/remote.txt", type: "file" as const, size: 4, modifiedMs: 1 }];
  saveOfflineSnapshot(state, peerId, { folders: [{ id: "f1", label: "Photos" } as never],
    remoteDevice: null, folderSyncStates: [], connectedVia: "", transportKind: "" });
  state.session.directory = { ...state.session.directory, folderId: "f1", path: "album",
    entries: cached, status: "ready", loadedAtMs: 10 };
  saveOfflineDirectorySnapshot(state, peerId);
  state.session.currentFolderId = "";
  state.session.currentPath = "";
  state.session.entries = [];
  const actions = createDirectoryActions({ state,
    client: { listLocalDirectory: async () => [], loadDirectorySnapshot: async () => null } as never,
    sessionStore: {} as never, refreshActiveView: async () => {}, syncStarredFiles: async () => {} });
  await actions.openLocation("f1", "album", "fixture.open", {});
  assert.deepEqual(state.session.entries.map(entry => entry.name), ["remote.txt"]);
  assert.equal(state.session.isOfflineSnapshot, true);
});

test("an Android-style canceled directory refresh retains cached entries and no abort banner", async () => {
  const state = createInitialState(null);
  const peerId = "A".repeat(52);
  state.connection.remoteId = peerId;
  const cached = [{ name: "known.txt", path: "album/known.txt", type: "file" as const, size: 5, modifiedMs: 1 }];
  const session = createInitialSessionState();
  session.phase = "connected";
  session.remoteFs = { setFocusedFolder: () => {} } as never;
  session.folders = [{ id: "f1", label: "Photos", needsPassword: false } as never];
  state.session.isConnected = true;
  state.session.remoteFs = session.remoteFs;
  state.session.folders = session.folders;
  saveOfflineSnapshot(state, peerId, { folders: session.folders, remoteDevice: null,
    folderSyncStates: [], connectedVia: "", transportKind: "" });
  state.session.directory = { ...state.session.directory, folderId: "f1", path: "album",
    entries: cached, status: "ready", loadedAtMs: 10 };
  saveOfflineDirectorySnapshot(state, peerId);
  state.session.currentFolderId = "";
  state.session.currentPath = "";
  state.session.entries = [];
  let started = () => {};
  const attempting = new Promise<void>(resolve => { started = resolve; });
  let fail: (error: Error) => void = () => {};
  const remote = new Promise<void>((_resolve, reject) => { fail = reject; });
  const actions = createDirectoryActions({ state,
    client: { loadDirectorySnapshot: async () => null, getCachedStatuses: async () => [] } as never,
    sessionStore: { getState: () => session, actions: { goToPath: async () => {
      session.directory = { ...session.directory, folderId: "f1", path: "album", entries: [], status: "loading" };
      session.pending.loadingDirectory = true;
      applySessionState(state, session);
      started();
      await remote;
    } } } as never,
    refreshActiveView: async () => {}, syncStarredFiles: async () => {} });
  const opening = actions.openLocation("f1", "album", "fixture.open", {});
  assert.equal(await Promise.race([attempting.then(() => true), opening.then(() => false)]), true,
    `Expected live refresh; got ${state.ui.recentError ?? "no error"}`);
  assert.deepEqual(state.session.entries.map(entry => entry.name), ["known.txt"],
    "The core loading event must not erase cached rows while Android reads the index.");
  state.ui.autoConnectPaused = true;
  state.session.isConnected = false;
  fail(new Error("signal is aborted without reason"));
  await opening;
  assert.deepEqual(state.session.entries.map(entry => entry.name), ["known.txt"]);
  assert.equal(state.ui.recentError, null, "A deliberate pause must not show an aborted-request error.");
});
