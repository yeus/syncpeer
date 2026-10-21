// code-analysis-disable lines -- Session navigation scenario matrix kept linear for readability.
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
      return [
        {
          name: "new.txt",
          path: "new.txt",
          type: "file",
          size: 1,
          modifiedMs: 1,
        },
      ];
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
  assert.deepEqual(
    state.entries.map((entry) => entry.name),
    ["new.txt"],
  );
});
test("an overview refresh preserves an open folder across a transient reconnect view", async () => {
  const documents = {
    id: "documents",
    label: "Documents",
    readOnly: false,
    encrypted: false,
    needsPassword: false,
  };
  const settings = {
    id: "settings",
    label: "Settings",
    readOnly: true,
    encrypted: false,
    needsPassword: false,
  };
  const documentSync = {
    folderId: documents.id,
    remoteIndexId: "1",
    remoteMaxSequence: "1",
    indexReceived: true,
  };
  const settingsSync = {
    folderId: settings.id,
    remoteIndexId: "2",
    remoteMaxSequence: "1",
    indexReceived: true,
  };
  const remoteFs: RemoteFsLike = {
    listFolders: async () => [settings, documents],
    requestFolderIndex: async () => undefined,
    setFocusedFolder: () => undefined,
    waitForFolderIndex: async () => true,
    readDir: async () => [],
    readFileFully: async () => new Uint8Array(),
    writeFileFully: async () => undefined,
  };
  let transientRefresh = false;
  let refreshOverviewCalls = 0;
  let now = 0;
  const store = createSyncpeerSessionStore({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    transport: {
      connectAndSync: async () => remoteFs,
      connectAndGetOverview: async () => {
        if (transientRefresh) {
          refreshOverviewCalls += 1;
          if (refreshOverviewCalls === 1) {
            return {
              folders: [settings],
              device: null,
              folderSyncStates: [settingsSync],
              connectedVia: "fixture",
              transportKind: "direct-tcp" as const,
            };
          }
        }
        return {
          folders: [settings, documents],
          device: null,
          folderSyncStates: [settingsSync, documentSync],
          connectedVia: "fixture",
          transportKind: "direct-tcp" as const,
        };
      },
      connectAndGetFolderVersions: async () => [settingsSync, documentSync],
    },
  });
  const options = {
    host: "127.0.0.1",
    port: 22000,
    deviceName: "reconnect-navigation-fixture",
    discoveryMode: "direct" as const,
  };

  await store.actions.connect(options);
  await store.actions.openFolder(documents.id, options);
  assert.equal(store.getState().currentFolderId, documents.id);

  transientRefresh = true;
  await store.actions.refreshOverview(options);

  assert.ok(
    refreshOverviewCalls >= 2,
    "A transient reconnect overview must be retried before dropping the selected folder.",
  );
  assert.equal(store.getState().currentFolderId, documents.id);
  assert.equal(store.getState().directory.folderId, documents.id);
});
test("an older overview refresh cannot clear a folder opened while it was in flight", async () => {
  const documents = {
    id: "documents",
    label: "Documents",
    readOnly: false,
    encrypted: false,
    needsPassword: false,
  };
  const settings = {
    id: "settings",
    label: "Settings",
    readOnly: true,
    encrypted: false,
    needsPassword: false,
  };
  const documentSync = {
    folderId: documents.id,
    remoteIndexId: "1",
    remoteMaxSequence: "1",
    indexReceived: true,
  };
  const settingsSync = {
    folderId: settings.id,
    remoteIndexId: "2",
    remoteMaxSequence: "1",
    indexReceived: true,
  };
  const remoteFs: RemoteFsLike = {
    listFolders: async () => [settings, documents],
    requestFolderIndex: async () => undefined,
    setFocusedFolder: () => undefined,
    waitForFolderIndex: async () => true,
    readDir: async () => [],
    readFileFully: async () => new Uint8Array(),
    writeFileFully: async () => undefined,
  };
  let blockNextOverview = false;
  let resolveBlockedOverview!: (value: {
    folders: (typeof settings)[];
    device: null;
    folderSyncStates: (typeof settingsSync)[];
    connectedVia: string;
    transportKind: "direct-tcp";
  }) => void;
  let markOverviewStarted!: () => void;
  const overviewStarted = new Promise<void>((resolve) => {
    markOverviewStarted = resolve;
  });
  const blockedOverview = new Promise<{
    folders: (typeof settings)[];
    device: null;
    folderSyncStates: (typeof settingsSync)[];
    connectedVia: string;
    transportKind: "direct-tcp";
  }>((resolve) => {
    resolveBlockedOverview = resolve;
  });
  let postBlockedOverviewCalls = 0;
  let now = 0;
  const fullOverview = () => ({
    folders: [settings, documents],
    device: null,
    folderSyncStates: [settingsSync, documentSync],
    connectedVia: "fixture",
    transportKind: "direct-tcp" as const,
  });
  const store = createSyncpeerSessionStore({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    transport: {
      connectAndSync: async () => remoteFs,
      connectAndGetOverview: async () => {
        if (blockNextOverview) {
          blockNextOverview = false;
          markOverviewStarted();
          return blockedOverview;
        }
        postBlockedOverviewCalls += 1;
        return fullOverview();
      },
      connectAndGetFolderVersions: async () => [settingsSync, documentSync],
    },
  });
  const options = {
    host: "127.0.0.1",
    port: 22000,
    deviceName: "stale-refresh-navigation-fixture",
    discoveryMode: "direct" as const,
  };

  await store.actions.connect(options);
  postBlockedOverviewCalls = 0;
  blockNextOverview = true;
  const refresh = store.actions.refreshOverview(options);
  await overviewStarted;

  await store.actions.openFolder(documents.id, options);
  assert.equal(store.getState().currentFolderId, documents.id);

  resolveBlockedOverview({
    folders: [settings],
    device: null,
    folderSyncStates: [settingsSync],
    connectedVia: "fixture",
    transportKind: "direct-tcp",
  });
  await refresh;

  assert.ok(
    postBlockedOverviewCalls >= 1,
    "The stale overview must be followed by a fresh read for the folder selected while it was in flight.",
  );
  assert.equal(store.getState().currentFolderId, documents.id);
  assert.equal(store.getState().directory.folderId, documents.id);
});
test("a lifecycle replacement rebinds remoteFs while preserving the selected folder", async () => {
  const documents = {
    id: "documents",
    label: "Documents",
    readOnly: false,
    encrypted: false,
    needsPassword: false,
  };
  const settings = {
    id: "settings",
    label: "Settings",
    readOnly: true,
    encrypted: false,
    needsPassword: false,
  };
  const syncState = {
    folderId: documents.id,
    remoteIndexId: "1",
    remoteMaxSequence: "1",
    indexReceived: true,
  };
  const settingsSyncState = {
    folderId: settings.id,
    remoteIndexId: "2",
    remoteMaxSequence: "1",
    indexReceived: true,
  };
  const makeRemoteFs = (name: string): RemoteFsLike => ({
    listFolders: async () => [documents],
    requestFolderIndex: async () => undefined,
    setFocusedFolder: () => undefined,
    waitForFolderIndex: async () => true,
    readDir: async () => [
      { name, path: name, type: "file", size: 1, modifiedMs: 1 },
    ],
    readFileFully: async () => new Uint8Array(),
    writeFileFully: async () => undefined,
  });
  const firstRemoteFs = makeRemoteFs("first.txt");
  const replacementRemoteFs = makeRemoteFs("replacement.txt");
  const finalRemoteFs = makeRemoteFs("final.txt");
  let currentRemoteFs = firstRemoteFs;
  let blockedConnection: Promise<RemoteFsLike> | undefined;
  let connectionStarted: (() => void) | undefined;
  let connectionCalls = 0;
  let replacementOverviewCalls = 0;
  let lifecycleListener:
    | ((state: {
        phase:
          | "idle"
          | "connecting"
          | "connected"
          | "waiting"
          | "reconnecting"
          | "suspended"
          | "stopping"
          | "error";
        attempt: number;
        nextRetryAtMs: number | null;
        closureReason: string | null;
        upgradeStatus: "idle" | "probing" | "switching";
      }) => void)
    | undefined;
  const store = createSyncpeerSessionStore({
    transport: {
      connectAndSync: async () => {
        connectionCalls++;
        if (blockedConnection) {
          const pending = blockedConnection;
          blockedConnection = undefined;
          connectionStarted?.();
          return pending;
        }
        return currentRemoteFs;
      },
      connectAndGetOverview: async () => {
        if (
          currentRemoteFs === replacementRemoteFs &&
          replacementOverviewCalls++ === 0
        ) {
          return {
            folders: [settings],
            device: null,
            folderSyncStates: [settingsSyncState],
            connectedVia: "fixture",
            transportKind: "direct-tcp" as const,
          };
        }
        return {
          folders: [settings, documents],
          device: null,
          folderSyncStates: [settingsSyncState, syncState],
          connectedVia: "fixture",
          transportKind: "direct-tcp" as const,
        };
      },
      connectAndGetFolderVersions: async () => [settingsSyncState, syncState],
      subscribeLifecycle: (listener) => {
        lifecycleListener = listener;
        return () => {};
      },
    },
  });
  const options = {
    host: "127.0.0.1",
    port: 22000,
    deviceName: "replacement-session-fixture",
    discoveryMode: "direct" as const,
  };

  await store.actions.connect(options);
  await store.actions.openFolder(documents.id, options);
  assert.equal(store.getState().remoteFs, firstRemoteFs);
  assert.equal(store.getState().currentFolderId, documents.id);

  currentRemoteFs = replacementRemoteFs;
  lifecycleListener?.({
    phase: "connecting",
    attempt: 0,
    nextRetryAtMs: null,
    closureReason: null,
    upgradeStatus: "idle",
  });
  lifecycleListener?.({
    phase: "connected",
    attempt: 0,
    nextRetryAtMs: null,
    closureReason: null,
    upgradeStatus: "idle",
  });

  const deadline = Date.now() + 1000;
  while (
    store.getState().remoteFs !== replacementRemoteFs &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    store.getState().remoteFs,
    replacementRemoteFs,
    "The session store must rebind the new RemoteFs after the lifecycle replaces the connection.",
  );
  assert.equal(store.getState().currentFolderId, documents.id);
  assert.equal(store.getState().directory.folderId, documents.id);
  // A second replacement can arrive while the first rebind still awaits the
  // retiring connection. Its failure must not lose the newest connected event.
  await new Promise(resolve => setTimeout(resolve, 0));
  const started = Promise.withResolvers<void>();
  const retiring = Promise.withResolvers<RemoteFsLike>();
  connectionStarted = started.resolve;
  blockedConnection = retiring.promise;
  const emit = (phase: "connecting" | "connected" | "stopping" | "idle") => lifecycleListener?.({
    phase, attempt: 0, nextRetryAtMs: null, closureReason: null, upgradeStatus: "idle",
  });
  emit("connecting");
  emit("connected");
  await started.promise;
  currentRemoteFs = finalRemoteFs;
  emit("connecting");
  emit("connected");
  retiring.reject(new Error("The previous connection was retired."));
  const finalDeadline = Date.now() + 1000;
  while (store.getState().remoteFs !== finalRemoteFs && Date.now() < finalDeadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(store.getState().remoteFs, finalRemoteFs,
    "A replacement during recovery must rebind the latest session after the retired recovery fails.");
  assert.equal(store.getState().currentFolderId, documents.id);
  await new Promise(resolve => setTimeout(resolve, 0));
  const stoppedRecovery = Promise.withResolvers<RemoteFsLike>();
  const stoppingStarted = Promise.withResolvers<void>();
  blockedConnection = stoppedRecovery.promise;
  connectionStarted = stoppingStarted.resolve;
  emit("connecting");
  emit("connected");
  await stoppingStarted.promise;
  emit("connecting");
  emit("connected");
  emit("stopping");
  emit("idle");
  const callsAtStop = connectionCalls;
  stoppedRecovery.reject(new Error("Disconnected during recovery."));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(connectionCalls, callsAtStop,
    "Queued recovery must not reconnect after the lifecycle stops.");
});
