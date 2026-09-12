import assert from "node:assert/strict";
import test from "node:test";
import { createSyncpeerSessionStore } from "../packages/core/src/ui/sessionStore.ts";
import type { RemoteFsLike } from "../packages/core/src/ui/browserClient.ts";

test("a stale directory failure cannot overwrite a newer location", async () => {
  let rejectFirstRead: ((error: Error) => void) | undefined;
  let firstReadStarted: (() => void) | undefined;
  const firstRead = new Promise<void>((resolve) => {
    firstReadStarted = resolve;
  });
  const folder = {
    id: "documents",
    label: "Documents",
    readOnly: false,
    encrypted: false,
    needsPassword: false,
  };
  const remoteFs: RemoteFsLike = {
    listFolders: async () => [folder],
    requestFolderIndex: async () => undefined,
    setFocusedFolder: () => undefined,
    waitForFolderIndex: async () => true,
    readDir: async (_folderId, path) => {
      if (path === "first") {
        firstReadStarted?.();
        return new Promise((_resolve, reject) => {
          rejectFirstRead = reject;
        });
      }
      return [{
        name: "new.txt",
        path: "new.txt",
        type: "file",
        size: 1,
        modifiedMs: 1,
      }];
    },
    readFileFully: async () => new Uint8Array(),
    writeFileFully: async () => undefined,
  };
  const folderSyncState = {
    folderId: folder.id,
    remoteIndexId: "1",
    remoteMaxSequence: "1",
    indexReceived: true,
  };
  const store = createSyncpeerSessionStore({
    transport: {
      connectAndSync: async () => remoteFs,
      connectAndGetOverview: async () => ({
        folders: [folder],
        device: null,
        folderSyncStates: [folderSyncState],
        connectedVia: "fixture",
        transportKind: "direct-tcp" as const,
      }),
      connectAndGetFolderVersions: async () => [folderSyncState],
    },
  });
  const options = {
    host: "127.0.0.1",
    port: 22000,
    deviceName: "navigation-fixture",
    discoveryMode: "direct" as const,
  };

  await store.actions.connect(options);
  const openingFirst = store.actions.goToPath("documents", "first", options);
  await firstRead;
  const openingSecond = store.actions.goToPath("documents", "second", options);
  await openingSecond;
  rejectFirstRead?.(new Error("first directory failed"));
  await assert.rejects(openingFirst, /first directory failed/);

  const state = store.getState();
  assert.equal(state.currentPath, "second");
  assert.equal(state.directory.status, "ready");
  assert.deepEqual(state.entries.map((entry) => entry.name), ["new.txt"]);
});
