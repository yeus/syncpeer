import assert from "node:assert/strict";
import test from "node:test";
import type { AppActions } from "../packages/app/src/app/actions.ts";
import {
  createNavigableAppActions,
  routeEquals,
  routeFromHash,
  routeFromState,
  routeToHash,
  type AppRoute,
} from "../packages/app/src/app/navigation.ts";
import { createInitialState, type AppState } from "../packages/app/src/app/state.ts";

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
