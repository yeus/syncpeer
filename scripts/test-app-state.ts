import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSessionState } from "../packages/core/src/ui/sessionPolicies.ts";
import { applySessionState, createInitialState } from "../packages/app/src/app/state.ts";

test("keeps restored folders visible while reconnecting before live state arrives", () => {
  const app = createInitialState(null);
  app.session.isOfflineSnapshot = true;
  app.session.offlineLastSeenAtMs = 1_800_000_000_000;
  app.session.remoteDevice = {
    id: "synthetic-device",
    deviceName: "Synthetic peer",
  };
  app.session.folders = [{
    id: "documents",
    label: "Documents",
    readOnly: false,
    encrypted: false,
    needsPassword: false,
    passwordError: null,
  }];
  app.session.directory = {
    folderId: "documents",
    path: "",
    entries: [{
      name: "cached.txt",
      path: "cached.txt",
      type: "file",
      size: 12,
      modifiedMs: 1_800_000_000_000,
      invalid: false,
    }],
    status: "ready",
    versionKey: "offline-version",
    loadedAtMs: 1_800_000_000_000,
    error: null,
    requestSeq: 1,
  };
  app.session.currentFolderId = "documents";
  app.session.currentPath = "";
  app.session.entries = [...app.session.directory.entries];
  app.session.currentFolderVersionKey = "offline-version";

  applySessionState(app, {
    ...createInitialSessionState(),
    phase: "connecting",
    pending: {
      connecting: true,
      loadingDirectory: false,
      refreshingOverview: false,
    },
  });

  assert.equal(app.session.isConnected, false);
  assert.equal(app.session.isOfflineSnapshot, true);
  assert.deepEqual(app.session.folders.map((folder) => folder.id), ["documents"]);
  assert.deepEqual(app.session.entries.map((entry) => entry.name), ["cached.txt"]);
});

test("replaces restored folders once live connected state arrives", () => {
  const app = createInitialState(null);
  app.session.isOfflineSnapshot = true;
  app.session.folders = [{
    id: "old-folder",
    label: "Old folder",
    readOnly: false,
    encrypted: false,
    needsPassword: false,
    passwordError: null,
  }];

  applySessionState(app, {
    ...createInitialSessionState(),
    phase: "connected",
    remoteFs: {} as never,
    folders: [{
      id: "live-folder",
      label: "Live folder",
      readOnly: false,
      encrypted: false,
      needsPassword: false,
      passwordError: null,
    }],
    pending: {
      connecting: false,
      loadingDirectory: false,
      refreshingOverview: false,
    },
  });

  assert.equal(app.session.isConnected, true);
  assert.equal(app.session.isOfflineSnapshot, false);
  assert.deepEqual(app.session.folders.map((folder) => folder.id), ["live-folder"]);
});
