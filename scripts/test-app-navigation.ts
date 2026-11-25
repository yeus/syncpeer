import assert from "node:assert/strict";
import test from "node:test";
import type { SyncpeerSessionStore } from "@syncpeer/core/browser";
import type { AppActions } from "../packages/app/src/app/actions.ts";
import { createPageActions } from "../packages/app/src/app/pageActions.ts";
import {
  createNavigableAppActions,
  routeEquals,
  routeFromHash,
  routeFromState,
  routeToHash,
  type AppRoute,
} from "../packages/app/src/app/navigation.ts";
import { createInitialState, visibleDirectoryEntries, type AppState } from "../packages/app/src/app/state.ts";

type Listener = () => void;

const createHistoryHarness = (initialHash = "") => {
  let hash = initialHash;
  let index = 0;
  const entries: Array<{ hash: string; state: unknown }> = [{ hash, state: null }];
  const listeners = new Set<Listener>();
  const events = {
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
  };
  const setHash = (url: string | null | undefined) => {
    hash = String(url ?? "").split("#")[1] ? `#${String(url).split("#")[1]}` : "";
  };
  const history = {
    get state() {
      return entries[index]?.state ?? null;
    },
    pushState: (state: unknown, _title: string, url?: string | URL | null) => {
      setHash(url?.toString());
      entries.splice(index + 1);
      entries.push({ hash, state });
      index += 1;
    },
    replaceState: (state: unknown, _title: string, url?: string | URL | null) => {
      setHash(url?.toString());
      entries[index] = { hash, state };
    },
    back: () => {
      if (index === 0) return;
      index -= 1;
      hash = entries[index]?.hash ?? "";
      for (const listener of listeners) listener();
    },
  };
  return {
    history,
    location: {
      get hash() {
        return hash;
      },
    },
    events,
    entries,
  };
};

const createBaseActions = (
  state: AppState,
  delayedLocation?: Promise<void>,
  locationAvailable = true,
  onLocationStateChange?: () => void,
): AppActions => {
  const setLocation = (folderId: string, path: string) => {
    state.session.currentFolderId = folderId;
    state.session.currentPath = path;
    onLocationStateChange?.();
    return delayedLocation ?? Promise.resolve();
  };
  return {
    ...createPageActions({ state, sessionStore: {} as SyncpeerSessionStore,
      discoverLocalDevices: async () => {}, connect: async () => {} }),
    switchTab: (tab) => {
      state.activeTab = tab;
    },
    openDiagnosticsPage: () => {
      state.currentPage = "diagnostics";
    },
    closeDiagnosticsPage: () => {
      state.currentPage = "main";
    },
    openAboutPage: () => {
      state.currentPage = "about";
    },
    closeAboutPage: () => {
      state.currentPage = "main";
    },
    openLocation: async (folderId, path) => {
      if (locationAvailable) await setLocation(folderId, path);
    },
    openFolderRoot: async (folderId) => {
      state.activeTab = "folders";
      await setLocation(folderId, "");
    },
    openDirectory: async () => {},
    goToBreadcrumb: async (segment) => {
      if (!segment.ellipsis) await setLocation(segment.targetFolderId, segment.targetPath);
    },
    goToRootView: async () => {
      state.session.currentFolderId = "";
      state.session.currentPath = "";
    },
    openFavorite: async () => {},
    openVersions: async (folderId, path, name) => {
      state.currentPage = "versions";
      state.versions.folderId = folderId;
      state.versions.path = path;
      state.versions.name = name;
    },
    closeVersions: () => { state.currentPage = "main"; },
  } as unknown as AppActions;
};

const createActions = (
  state: AppState,
  initialHash = "",
  delayedLocation?: Promise<void>,
  locationAvailable = true,
  onLocationStateChange?: () => void,
) => {
  const harness = createHistoryHarness(initialHash);
  const actions = createNavigableAppActions({
    state,
    actions: createBaseActions(
      state,
      delayedLocation,
      locationAvailable,
      onLocationStateChange,
    ),
    history: harness.history,
    location: harness.location,
    events: harness.events,
  });
  return { ...harness, actions };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("serializes and validates the navigation route in the URL fragment", () => {
  const route: AppRoute = {
    page: "main",
    tab: "folders",
    folderId: "folder with spaces",
    path: "nested/deeper",
  };
  const hash = routeToHash(route);
  assert.equal(routeFromHash(hash)?.folderId, route.folderId);
  assert.equal(routeFromHash(hash)?.path, route.path);
  assert.equal(routeFromHash(hash)?.tab, route.tab);
  assert.equal(routeFromHash("#v=1&page=unknown&tab=folders"), null);
  assert.equal(routeToHash({ ...route, path: "/nested/deeper/" }), hash);
  const versionRoute: AppRoute = { ...route, page: "versions", path: "nested", versionPath: "nested/file.txt" };
  assert.equal(routeFromHash(routeToHash(versionRoute))?.versionPath, "nested/file.txt");
  assert.equal(routeFromHash("#v=1&page=folder-settings&tab=folders")?.page, "general-settings");
});

test("hidden PIM tab falls back without deleting persisted PIM data", () => {
  assert.equal(createInitialState({ activeTab: "pim" }).activeTab, "favorites");
  assert.equal(routeFromHash("#v=1&page=main&tab=pim")?.tab, "favorites");
});

test("records a route after synchronous session updates", async () => {
  const state = createInitialState(null);
  const navigation = { sync: undefined as (() => void) | undefined };
  const harness = createActions(
    state,
    "",
    undefined,
    true,
    () => navigation.sync?.(),
  );
  navigation.sync = harness.actions.syncNavigationRoute;
  harness.actions.startNavigation();
  await harness.actions.openFolderRoot("folder");
  assert.equal(harness.entries.length, 2);
  assert.equal(harness.location.hash, routeToHash(routeFromState(state)));
});

test("Back reverses tab and folder actions in chronological order", async () => {
  const state = createInitialState(null);
  const { actions, history, location } = createActions(state);
  const stop = actions.startNavigation();

  actions.switchTab("folders");
  await actions.openFolderRoot("folder");
  await actions.goToBreadcrumb({
    key: "nested",
    label: "nested",
    targetFolderId: "folder",
    targetPath: "nested",
  });
  actions.switchTab("devices");

  assert.equal(state.activeTab, "devices");
  assert.equal(location.hash, routeToHash(routeFromState(state)));
  history.back();
  await flush();
  assert.equal(state.activeTab, "folders");
  assert.equal(state.session.currentPath, "nested");
  history.back();
  await flush();
  assert.equal(state.session.currentPath, "");
  history.back();
  await flush();
  assert.equal(state.activeTab, "folders");
  history.back();
  await flush();
  assert.equal(state.activeTab, "favorites");
  assert.equal(state.session.currentFolderId, "");
  stop();
});

test("async folder navigation records the previous directory instead of replacing it", async () => {
  const state = createInitialState(null);
  state.activeTab = "folders";
  const harness = createHistoryHarness();
  let release!: () => void;
  let gate = Promise.resolve();
  const base = createBaseActions(state);
  let notify = () => {};
  const visit = async (folderId: string, path: string) => {
    await gate;
    state.session.currentFolderId = folderId;
    state.session.currentPath = path;
    notify();
  };
  const actions = createNavigableAppActions({
    ...harness, state, actions: {
      ...base,
      openFolderRoot: folderId => visit(folderId, ""),
      openDirectory: path => visit("photos", path),
      goToBreadcrumb: segment => visit(segment.targetFolderId, segment.targetPath),
    },
  });
  notify = actions.syncNavigationRoute;
  actions.startNavigation();
  gate = new Promise<void>(resolve => { release = resolve; });
  const opening = actions.openFolderRoot("photos");
  assert.equal(harness.entries.length, 1);
  release();
  await opening;
  assert.equal(harness.entries.length, 2);
  await actions.openDirectory("holiday");
  await actions.openDirectory("holiday/beach");
  await actions.goToBreadcrumb({ key: "holiday", label: "holiday",
    targetFolderId: "photos", targetPath: "holiday" });
  assert.equal(harness.entries.length, 5);
  for (const [folder, path] of [["photos", "holiday/beach"], ["photos", "holiday"], ["photos", ""], ["", ""]]) {
    harness.history.back();
    await flush();
    assert.equal(state.session.currentFolderId, folder);
    assert.equal(state.session.currentPath, path);
    assert.equal(state.activeTab, "folders");
    assert.equal(harness.location.hash, routeToHash(routeFromState(state)));
  }
});

test("offline asynchronous navigation without a session notification still records history", async () => {
  const state = createInitialState(null);
  state.activeTab = "folders";
  const harness = createHistoryHarness();
  const actions = createNavigableAppActions({
    ...harness, state, actions: {
      ...createBaseActions(state),
      openFolderRoot: async folderId => {
        await Promise.resolve();
        state.session.currentFolderId = folderId;
      },
      openDirectory: async path => {
        await Promise.resolve();
        state.session.currentPath = path;
      },
    },
  });
  actions.startNavigation();
  await actions.openFolderRoot("photos");
  await actions.openDirectory("holiday");
  assert.equal(harness.entries.length, 3);
  harness.history.back();
  await flush();
  assert.equal(state.session.currentPath, "");
  harness.history.back();
  await flush();
  assert.equal(state.session.currentFolderId, "");
});

test("folder settings have a URL and Back restores the previous folder without adding a tab", async () => {
  const state = createInitialState(null);
  const { actions, history, location } = createActions(state);
  const stop = actions.startNavigation();
  await actions.openFolderRoot("photos");
  actions.openFolderSettings("photos");
  assert.equal(routeFromHash(location.hash)?.page, "folder-settings");
  assert.equal(state.activeTab, "folders");
  history.back();
  await flush();
  assert.equal(state.currentPage, "main");
  assert.equal(state.session.currentFolderId, "photos");
  stop();
});

test("folder settings select a root-row folder without changing the browsing location", async () => {
  const state = createInitialState(null);
  const { actions, location, history } = createActions(state);
  actions.startNavigation();
  await actions.openFolderRoot("photos");
  state.session.currentPath = "holiday";
  actions.syncNavigationRoute();
  actions.openFolderSettings("documents");
  assert.equal(state.folderSettingsId, "documents");
  assert.equal(state.session.currentFolderId, "photos");
  assert.equal(state.session.currentPath, "holiday");
  assert.equal(routeFromHash(location.hash)?.folderId, "documents");
  assert.equal(routeFromHash(location.hash)?.path, "");
  actions.closeFolderSettings();
  await flush();
  assert.equal(state.currentPage, "main");
  assert.equal(state.session.currentFolderId, "photos");
  assert.equal(state.session.currentPath, "holiday");
  assert.equal(history.state !== null, true);
});

test("a folder-settings deep link opens settings without browsing or contacting that folder", async () => {
  const state = createInitialState(null);
  const { actions } = createActions(state, "#v=1&page=folder-settings&tab=folders&folder=documents");
  actions.startNavigation();
  await actions.restoreNavigationRoute();
  assert.equal(state.currentPage, "folder-settings");
  assert.equal(state.folderSettingsId, "documents");
  assert.equal(state.session.currentFolderId, "");
});

test("general settings and folder creation have distinct routes and restore on Back", async () => {
  const state = createInitialState(null);
  const { actions, location } = createActions(state);
  actions.startNavigation();
  actions.openNewFolder();
  assert.equal(routeFromHash(location.hash)?.page, "new-folder");
  actions.openGeneralSettings();
  assert.equal(routeFromHash(location.hash)?.page, "general-settings");
  actions.closeGeneralSettings();
  await flush();
  assert.equal(state.currentPage, "new-folder");
  actions.closeNewFolder();
  await flush();
  assert.equal(state.currentPage, "main");
});
test("settings categories have independent routes and Back restores the originating folder", async () => {
  const state = createInitialState(null);
  const { actions, location } = createActions(state);
  actions.startNavigation();
  await actions.openFolderRoot("photos");
  state.session.currentPath = "holiday";
  actions.syncNavigationRoute();
  actions.openGeneralSettings("overview");
  assert.equal(routeFromHash(location.hash)?.section, "overview");
  actions.openGeneralSettings("synchronization");
  assert.equal(routeFromHash(location.hash)?.section, "synchronization");
  actions.closeGeneralSettings();
  await flush();
  assert.equal(state.settingsSection, "overview");
  actions.closeGeneralSettings();
  await flush();
  assert.equal(state.currentPage, "main");
  assert.equal(state.session.currentFolderId, "photos");
  assert.equal(state.session.currentPath, "holiday");
});


test("general settings and creation deep links do not carry a browsing folder", async () => {
  for (const page of ["general-settings", "new-folder"]) {
    const state = createInitialState(null);
    const { actions, location } = createActions(state, `#v=1&page=${page}&tab=devices&folder=photos&path=holiday`);
    actions.startNavigation();
    await actions.restoreNavigationRoute();
    assert.equal(state.currentPage, page);
    assert.equal(state.session.currentFolderId, "");
    assert.equal(routeFromHash(location.hash)?.folderId, "");
  }
});

test("Back from a folder conflict to general settings preserves the existing browsing location", async () => {
  const state = createInitialState(null);
  const { actions } = createActions(state);
  actions.startNavigation();
  await actions.openFolderRoot("photos");
  state.session.currentPath = "holiday";
  actions.syncNavigationRoute();
  actions.openGeneralSettings();
  actions.openFolderSettings("documents");
  actions.closeFolderSettings();
  await flush();
  assert.equal(state.currentPage, "general-settings");
  assert.equal(state.session.currentFolderId, "photos");
  assert.equal(state.session.currentPath, "holiday");
});

test("restores a deep URL route and gives the URL precedence over persisted state", async () => {
  const requested: AppRoute = {
    page: "main",
    tab: "devices",
    folderId: "url-folder",
    path: "from-url",
  };
  const state = createInitialState(null);
  state.activeTab = "favorites";
  const { actions, location } = createActions(state, routeToHash(requested));
  actions.startNavigation();
  assert.equal(state.activeTab, "devices");
  await actions.restoreNavigationRoute();
  assert.ok(routeEquals(routeFromState(state), requested));
  assert.equal(location.hash, routeToHash(requested));
});

test("does not keep an already-restored URL route pending", async () => {
  const state = createInitialState(null);
  const initialRoute = routeFromState(state);
  const { actions, location } = createActions(state, routeToHash(initialRoute));
  actions.startNavigation();
  await actions.restoreNavigationRoute();
  actions.switchTab("devices");
  assert.equal(location.hash, routeToHash(routeFromState(state)));
});

test("canonicalizes a deep URL when its folder is unavailable", async () => {
  const requested: AppRoute = {
    page: "main",
    tab: "folders",
    folderId: "missing-folder",
    path: "missing-path",
  };
  const state = createInitialState(null);
  const { actions, location } = createActions(
    state,
    routeToHash(requested),
    undefined,
    false,
  );
  actions.startNavigation();
  assert.equal(await actions.restoreNavigationRoute(), false);
  assert.equal(location.hash, routeToHash(routeFromState(state)));
  assert.equal(state.session.currentFolderId, "");
});

test("does not let a stale restoration replace a newer navigation", async () => {
  let resolveOld: (() => void) | undefined;
  const oldRequest = new Promise<void>((resolve) => {
    resolveOld = resolve;
  });
  const state = createInitialState(null);
  const { actions, history } = createActions(state, "", oldRequest);
  actions.startNavigation();
  actions.switchTab("folders");
  const oldOpen = actions.openFolderRoot("old-folder");
  history.back();
  await flush();
  actions.switchTab("devices");
  resolveOld?.();
  await flush();
  assert.equal(state.activeTab, "devices");
  await oldOpen;
});

test("coalesces rapid Android visibility notifications into one current handoff", async () => {
  const state = createInitialState(null);
  state.ui.deviceNameConfirmed = false;
  const transitions: boolean[] = [];
  const actions = createPageActions({
    state,
    sessionStore: { actions: { setForeground: async (visible: boolean) => {
      transitions.push(visible);
    } } } as unknown as SyncpeerSessionStore,
    discoverLocalDevices: async () => {}, connect: async () => {},
  });
  actions.setAppVisibility(false);
  actions.setAppVisibility(false);
  actions.setAppVisibility(true);
  actions.setAppVisibility(true);
  await actions.onAppForeground();
  assert.deepEqual(transitions, [false, true],
    "Only the initial hide and final show may run; duplicate visibility events must collapse.");
});

test("a foreground handoff waits for an already-running background transition", async () => {
  const state = createInitialState(null);
  state.ui.deviceNameConfirmed = false;
  const transitions: string[] = [];
  let resumeBackground = () => {};
  const background = new Promise<void>(resolve => { resumeBackground = resolve; });
  const actions = createPageActions({
    state,
    sessionStore: { actions: { setForeground: async (visible: boolean) => {
      transitions.push(visible ? "foreground" : "background");
      if (!visible) await background;
    } } } as unknown as SyncpeerSessionStore,
    discoverLocalDevices: async () => {}, connect: async () => {},
  });
  actions.setAppVisibility(false);
  await Promise.resolve();
  actions.setAppVisibility(true);
  const foreground = actions.onAppForeground();
  await Promise.resolve();
  assert.deepEqual(transitions, ["background"]);
  resumeBackground();
  await foreground;
  assert.deepEqual(transitions, ["background", "foreground"]);
});

test("a service-connected peer needs no redundant foreground LAN discovery or reconnect", async () => {
  const state = createInitialState(null);
  state.ui.isAppVisible = true;
  state.ui.deviceNameConfirmed = true;
  state.session.isConnected = true;
  const calls: string[] = [];
  const actions = createPageActions({
    state,
    sessionStore: { actions: {
      setForeground: async (foreground: boolean) => { calls.push(`foreground:${foreground}`); },
      setOnline: async (online: boolean) => { calls.push(`online:${online}`); },
    } } as unknown as SyncpeerSessionStore,
    discoverLocalDevices: async () => { calls.push("discover"); },
    connect: async () => { calls.push("connect"); },
  });
  actions.setAppVisibility(true);
  await actions.onAppForeground();
  await actions.onNetworkOnline();
  assert.deepEqual(calls, ["foreground:true", "online:true"]);
});

test("folder view merges local Save As documents with the remote list and hides .stfolder", () => {
  const state = createInitialState(null);
  state.session.currentFolderId = "folder";
  const file = (path: string, size: number) => ({ path, name: path.split("/").at(-1)!, type: "file" as const, size, modifiedMs: 1 });
  state.session.entries = [file("remote.txt", 1), file("same.txt", 2),
    { ...file(".stfolder", 0), type: "directory" }];
  state.session.localDirectoryOverlay = { folderId: "folder", path: "", sourceDeviceId: "", entries: [file("saved.txt", 3), file("same.txt", 4)] };
  assert.deepEqual(visibleDirectoryEntries(state).map(entry => [entry.path, entry.size]),
    [["remote.txt", 1], ["same.txt", 2], ["saved.txt", 3]]);
  state.session.currentPath = "other";
  assert.equal(visibleDirectoryEntries(state).some(entry => entry.path === "saved.txt"), false);
});
