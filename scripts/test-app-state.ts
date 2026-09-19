import assert from "node:assert/strict";
import test from "node:test";
import { createInitialSessionState } from "../packages/core/src/ui/sessionPolicies.ts";
import {
  activeDownloadForFile,
  activeDownloadProgressPercent,
  activeDownloadSummary,
  applySessionState,
  applySensitiveAppState,
  createInitialState,
  downloadButtonLabel,
  readLegacySensitiveState,
  rootFolderEntries,
  persistState,
  sensitiveAppState,
} from "../packages/app/src/app/state.ts";

test("stability warning appears on first run and stays dismissed", () => {
  assert.equal(createInitialState(null).ui.showStabilityNotice, true);
  assert.equal(createInitialState({ stabilityNoticeAcknowledged: true }).ui.showStabilityNotice, false);
});

test("stability warning dismissal is persisted without storing private state", t => {
  let written = "";
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true,
    value: { localStorage: { setItem: (_key: string, value: string) => { written = value; } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window"); });
  const state = createInitialState(null);
  state.ui.showStabilityNotice = false;
  persistState(state);
  assert.equal(JSON.parse(written).stabilityNoticeAcknowledged, true);
});

test("secure credentials are excluded from browser persistence", t => {
  let written = "";
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { setItem: (_key: string, value: string) => { written = value; } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  const state = createInitialState(null);
  state.passwords.saved = { photos: "synthetic-secret" };
  state.passwords.secureStorage = true;
  persistState(state);
  assert.equal(JSON.parse(written).folderPasswords, undefined);
  assert.ok(!written.includes("synthetic-secret"));
});

test("browser persistence never stores a private key or folder password without secure storage", t => {
  let written = "";
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    setItem: (_key: string, value: string) => { written = value; },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window"); });
  const state = createInitialState(null);
  state.connection.key = "synthetic-private-key";
  state.passwords.saved = { photos: "synthetic-folder-password" };
  state.passwords.secureStorage = false;
  persistState(state);
  assert.ok(!written.includes("synthetic-private-key"));
  assert.ok(!written.includes("synthetic-folder-password"));
  const restored = createInitialState({ connection: { ...state.connection, key: "legacy-private-key" } });
  assert.equal(restored.connection.key, "");
  assert.deepEqual(restored.passwords.saved, {});
});

test("sensitive UI state is excluded from browser persistence", t => {
  let written = "";
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true,
    value: { localStorage: { setItem: (_key: string, value: string) => { written = value; } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window"); });
  const state = createInitialState(null);
  state.approvals.syncApprovedFolderKeys = new Set(["device:folder"]);
  state.offline.snapshots.device = { deviceId: "device", remoteDevice: null, folders: [{ id: "folder", label: "Private folder", readOnly: false }],
    folderSyncStates: [], connectedVia: "fixture", transportKind: "", lastSeenAtMs: 1,
    directories: { directory: { folderId: "folder", path: "", versionKey: "v1", loadedAtMs: 1,
      entries: [{ name: "private-name.txt", path: "private-name.txt", type: "file", size: 1, modifiedMs: 1 }] } } };
  state.pim.syncFolderPath = "private/pim";
  persistState(state);
  const persisted = JSON.parse(written);
  assert.equal(written.includes("private-name.txt"), false);
  assert.equal(written.includes("Private folder"), false);
  assert.equal(persisted.offlineFolderSnapshots, undefined);
  assert.equal(persisted.syncApprovedIntroducedFolderKeys, undefined);
  assert.equal(persisted.pim, undefined);
});

test("sensitive UI state round-trips through the encrypted payload", () => {
  const state = createInitialState(null);
  state.approvals.syncApprovedFolderKeys = new Set(["device:folder"]);
  state.offline.snapshots.device = { deviceId: "device", remoteDevice: null, folders: [],
    folderSyncStates: [], connectedVia: "fixture", transportKind: "", lastSeenAtMs: 1 };
  state.pim.enabled = true;
  state.pim.syncFolderPath = "private/pim";
  const payload = sensitiveAppState(state);
  assert.deepEqual(payload.approvals, ["device:folder"]);
  assert.equal(payload.offlineFolderSnapshots.device.lastSeenAtMs, 1);
  assert.equal(payload.pim.syncFolderPath, "private/pim");

  const restored = createInitialState(null);
  assert.equal(applySensitiveAppState(restored, JSON.parse(JSON.stringify(payload))), true);
  assert.deepEqual([...restored.approvals.syncApprovedFolderKeys], ["device:folder"]);
  assert.equal(restored.offline.snapshots.device.lastSeenAtMs, 1);
  assert.equal(restored.pim.enabled, true);
  assert.equal(restored.pim.syncFolderPath, "private/pim");
  assert.equal(applySensitiveAppState(restored, "invalid"), false);
});

test("legacy plaintext UI state is discoverable for one-time migration", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => JSON.stringify({
    syncApprovedIntroducedFolderKeys: ["device:folder"],
    offlineFolderSnapshots: { device: { deviceId: "device", folders: [], folderSyncStates: [],
      connectedVia: "", transportKind: "", lastSeenAtMs: 3, remoteDevice: null } },
    pim: { enabled: true, syncFolderPath: "private/pim" },
    theme: "dark",
  }) } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window"); });
  const legacy = readLegacySensitiveState();
  assert.deepEqual(legacy?.approvals, ["device:folder"]);
  assert.equal(legacy?.offlineFolderSnapshots.device.lastSeenAtMs, 3);
  assert.equal(legacy?.pim.enabled, true);
});

test("peer updates preserve the directory currently browsed from local storage", () => {
  const state = createInitialState(null);
  state.localFolders = [{ id: "photos", label: "Photos", readOnly: false }];
  state.session.isLocalDirectory = true;
  state.session.currentFolderId = "photos";
  state.session.directory = { ...state.session.directory, folderId: "photos", path: "", status: "ready" };
  applySessionState(state, { ...createInitialSessionState(), phase: "connected", folders: [{ id: "music", label: "Music", readOnly: false }] });
  assert.equal(state.session.currentFolderId, "photos");
});

test("local folder roots remain visible when switching peers or disconnecting", () => {
  const app = createInitialState(null);
  app.localFolders = [{ id: "photos", label: "Photos", readOnly: false }];
  applySessionState(app, { ...createInitialSessionState(), phase: "connected",
    folders: [{ id: "music", label: "Music", readOnly: false }] });
  assert.deepEqual(rootFolderEntries(app).map(folder => folder.name), ["Music", "Photos"]);
  applySessionState(app, createInitialSessionState());
  assert.deepEqual(rootFolderEntries(app).map(folder => folder.name), ["Photos"]);
});

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

test("tracks active manual downloads independently", () => {
  const app = createInitialState(null);
  app.favorites.activeDownloads = {
    "documents:alpha.bin": {
      name: "alpha.bin",
      text: "25% | 1 MB/s | ETA 12s | direct | LAN",
      progressPercent: 25,
    },
    "documents:beta.bin": {
      name: "beta.bin",
      text: "75% | 2 MB/s | ETA 4s | direct | LAN",
      progressPercent: 75,
    },
  };

  assert.equal(
    activeDownloadForFile(app, "documents", "alpha.bin")?.progressPercent,
    25,
  );
  assert.equal(downloadButtonLabel(app, "documents", "beta.bin"), "75% | 2 MB/s | ETA 4s | direct | LAN");
  assert.equal(downloadButtonLabel(app, "documents", "gamma.bin"), "Download");
  assert.equal(
    activeDownloadProgressPercent(Object.values(app.favorites.activeDownloads)),
    50,
  );
  assert.equal(
    activeDownloadSummary(Object.values(app.favorites.activeDownloads)),
    "2 downloads: 50%",
  );
});

test("startup persistence retains legacy sensitive state until verified migration", t => {
  let raw = JSON.stringify({ pim: { enabled: true, syncFolderPath: "synthetic/private" },
    folderPasswords: { folder: "synthetic-password" }, syncApprovedIntroducedFolderKeys: ["device:folder"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window"); });
  const state = createInitialState(null);
  persistState(state);
  assert.equal(readLegacySensitiveState()?.pim.syncFolderPath, "synthetic/private");
  assert.equal(JSON.parse(raw).folderPasswords.folder, "synthetic-password");
  persistState(state, true);
  assert.equal(JSON.parse(raw).pim, undefined);
  assert.equal(JSON.parse(raw).folderPasswords, undefined);
});
