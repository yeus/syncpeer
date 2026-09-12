import { normalizePath } from "@syncpeer/core/browser";
import type { AppActions } from "./actions.ts";
import type { AppState } from "./state.ts";

const ROUTE_VERSION = "1";
const NAVIGATION_STATE = "syncpeer.navigation";

export type AppRoute = {
  page: AppState["currentPage"];
  tab: AppState["activeTab"];
  folderId: string;
  path: string;
};

type NavigationHistory = Pick<History, "pushState" | "replaceState" | "back"> & {
  readonly state: unknown;
};

type NavigationLocation = Pick<Location, "hash">;
type NavigationEvents = Pick<Window, "addEventListener" | "removeEventListener">;

type NavigationState = {
  readonly namespace: typeof NAVIGATION_STATE;
  readonly key: string;
  readonly route: AppRoute;
};

type NavigationActions = Pick<
  AppActions,
  | "switchTab"
  | "openDiagnosticsPage"
  | "closeDiagnosticsPage"
  | "openAboutPage"
  | "closeAboutPage"
  | "openFolderSettings"
  | "closeFolderSettings"
  | "openFolderRoot"
  | "openDirectory"
  | "goToBreadcrumb"
  | "goToRootView"
  | "openFavorite"
>;

const pages: AppRoute["page"][] = ["main", "diagnostics", "about", "folder-settings"];
const tabs: AppRoute["tab"][] = ["favorites", "folders", "devices", "pim"];

const isPage = (value: string): value is AppRoute["page"] =>
  pages.includes(value as AppRoute["page"]);

const isTab = (value: string): value is AppRoute["tab"] =>
  tabs.includes(value as AppRoute["tab"]);

export const routeFromState = (state: AppState): AppRoute => ({
  page: state.currentPage,
  tab: state.activeTab,
  folderId: state.session.currentFolderId.trim(),
  path: normalizePath(state.session.currentPath),
});

export const routeEquals = (left: AppRoute, right: AppRoute): boolean =>
  left.page === right.page &&
  left.tab === right.tab &&
  left.folderId === right.folderId &&
  left.path === right.path;

export const routeToHash = (route: AppRoute): string => {
  const params = new URLSearchParams({
    v: ROUTE_VERSION,
    page: route.page,
    tab: route.tab,
  });
  if (route.folderId) params.set("folder", route.folderId);
  if (route.path && route.folderId) params.set("path", normalizePath(route.path));
  return `#${params.toString()}`;
};

export const routeFromHash = (hash: string): AppRoute | null => {
  if (!hash.startsWith("#")) return null;
  const params = new URLSearchParams(hash.slice(1));
  const page = params.get("page") ?? "main";
  const tab = params.get("tab") ?? "favorites";
  if (params.get("v") !== ROUTE_VERSION || !isPage(page) || !isTab(tab)) return null;
  const folderId = params.get("folder")?.trim() ?? "";
  return {
    page,
    tab,
    folderId,
    path: folderId ? normalizePath(params.get("path") ?? "") : "",
  };
};

const stateFor = (key: string, route: AppRoute): NavigationState => ({
  namespace: NAVIGATION_STATE,
  key,
  route,
});

const navigationState = (value: unknown): NavigationState | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NavigationState>;
  if (
    candidate.namespace === NAVIGATION_STATE &&
    typeof candidate.key === "string" &&
    candidate.route
  ) return candidate as NavigationState;
  return null;
};

const routeFromNavigationState = (value: unknown): AppRoute | null =>
  navigationState(value)?.route ?? null;

const applyPageAndTab = (state: AppState, route: AppRoute): void => {
  state.currentPage = route.page;
  state.activeTab = route.tab;
};

type NavigationRuntime = {
  readonly state: AppState;
  readonly actions: AppActions;
  readonly history: NavigationHistory;
  readonly location: NavigationLocation;
  readonly events: NavigationEvents;
  started: boolean;
  restoring: boolean;
  recording: boolean;
  restoreToken: number;
  sequence: number;
  pendingRoute: AppRoute | null;
  routeCameFromUrl: boolean;
};

type NavigationHistoryOperations = {
  readonly currentState: () => NavigationState | null;
  readonly replaceRoute: (route: AppRoute) => void;
  readonly syncCurrentRoute: () => void;
  readonly pushCurrentRoute: () => string | null;
  readonly reconcileRoute: (key: string) => void;
};

const createNavigationRuntime = (args: {
  readonly state: AppState;
  readonly actions: AppActions;
  readonly history: NavigationHistory;
  readonly location: NavigationLocation;
  readonly events: NavigationEvents;
}) => ({
  ...args,
  started: false,
  restoring: false,
  recording: false,
  restoreToken: 0,
  sequence: 0,
  pendingRoute: null,
  routeCameFromUrl: false,
});

const createHistoryOperations = (runtime: NavigationRuntime): NavigationHistoryOperations => {
  const currentRoute = (): AppRoute => routeFromState(runtime.state);
  const currentState = (): NavigationState | null => navigationState(runtime.history.state);
  const replaceRoute = (route: AppRoute): void => {
    const key = currentState()?.key ?? `initial-${++runtime.sequence}`;
    runtime.history.replaceState(stateFor(key, route), "", routeToHash(route));
  };
  const syncCurrentRoute = (): void => {
    if (
      !runtime.started ||
      runtime.pendingRoute ||
      runtime.restoring ||
      runtime.recording
    ) return;
    const route = currentRoute();
    if (
      runtime.location.hash !== routeToHash(route) ||
      !routeFromNavigationState(runtime.history.state)
    ) replaceRoute(route);
  };
  const pushCurrentRoute = (): string | null => {
    if (runtime.restoring) return null;
    const route = currentRoute();
    if (runtime.location.hash === routeToHash(route)) return null;
    const key = `navigation-${++runtime.sequence}`;
    runtime.history.pushState(stateFor(key, route), "", routeToHash(route));
    return key;
  };
  const reconcileRoute = (key: string): void => {
    if (currentState()?.key !== key) return;
    const route = currentRoute();
    if (runtime.location.hash !== routeToHash(route)) replaceRoute(route);
  };
  return { currentState, replaceRoute, syncCurrentRoute, pushCurrentRoute, reconcileRoute };
};

const createNavigationRecorder = (
  runtime: NavigationRuntime,
  historyOperations: NavigationHistoryOperations,
) => {
  const cancelRestore = (): void => {
    if (!runtime.restoring) return;
    runtime.restoreToken += 1;
    runtime.restoring = false;
    runtime.pendingRoute = null;
  };
  const recordAction = <Args extends readonly unknown[], Result>(
    action: (...values: Args) => Result,
  ) => (...values: Args): Result => {
    cancelRestore();
    runtime.pendingRoute = null;
    runtime.routeCameFromUrl = false;
    runtime.recording = true;
    let result: Result;
    try {
      result = action(...values);
    } finally {
      runtime.recording = false;
    }
    const key = historyOperations.pushCurrentRoute();
    if (key && result instanceof Promise) {
      void result.then(
        () => historyOperations.reconcileRoute(key),
        () => historyOperations.reconcileRoute(key),
      );
    }
    return result;
  };
  return { recordAction };
};

const createRouteOperations = (
  runtime: NavigationRuntime,
  historyOperations: NavigationHistoryOperations,
) => {
  const restoreRoute = async (route: AppRoute, finalize: boolean): Promise<boolean> => {
    const token = ++runtime.restoreToken;
    runtime.pendingRoute = route;
    runtime.restoring = true;
    applyPageAndTab(runtime.state, route);
    try {
      if (!route.folderId) await runtime.actions.goToRootView();
      else {
        await runtime.actions.openLocation(
          route.folderId,
          route.path,
          "navigation.restore.failed",
          route,
        );
      }
    } finally {
      if (runtime.restoreToken === token) runtime.restoring = false;
    }
    if (
      runtime.restoreToken !== token ||
      !runtime.pendingRoute ||
      !routeEquals(runtime.pendingRoute, route)
    ) return false;
    const restored = routeEquals(routeFromState(runtime.state), route);
    if (restored) runtime.pendingRoute = null;
    else if (finalize) {
      runtime.pendingRoute = null;
      runtime.routeCameFromUrl = false;
      historyOperations.replaceRoute(routeFromState(runtime.state));
    }
    return restored;
  };
  const restoreNavigationRoute = async (finalize = true): Promise<boolean> => {
    if (!runtime.routeCameFromUrl && !runtime.pendingRoute) {
      historyOperations.syncCurrentRoute();
      return true;
    }
    const requested = runtime.pendingRoute ?? routeFromHash(runtime.location.hash);
    if (!requested) {
      historyOperations.syncCurrentRoute();
      return true;
    }
    if (routeEquals(routeFromState(runtime.state), requested)) {
      if (!runtime.restoring) runtime.pendingRoute = null;
      return true;
    }
    return restoreRoute(requested, finalize);
  };
  const handlePopState = (): void => {
    const route = routeFromHash(runtime.location.hash);
    if (!route) {
      historyOperations.syncCurrentRoute();
      return;
    }
    runtime.routeCameFromUrl = true;
    void restoreRoute(route, true);
  };
  const startNavigation = (): (() => void) => {
    if (runtime.started) return () => {};
    runtime.started = true;
    const route = routeFromHash(runtime.location.hash);
    if (route) {
      runtime.pendingRoute = route;
      runtime.routeCameFromUrl = true;
      applyPageAndTab(runtime.state, route);
      historyOperations.replaceRoute(route);
    } else {
      runtime.routeCameFromUrl = false;
      historyOperations.syncCurrentRoute();
    }
    runtime.events.addEventListener("popstate", handlePopState);
    return () => {
      runtime.events.removeEventListener("popstate", handlePopState);
      runtime.started = false;
    };
  };
  const goBackFromPage = (fallback: () => void): void => {
    const stateEntry = historyOperations.currentState();
    if (stateEntry?.key.startsWith("navigation-")) runtime.history.back();
    else {
      fallback();
      historyOperations.syncCurrentRoute();
    }
  };
  return { restoreNavigationRoute, startNavigation, goBackFromPage };
};

export const createNavigableAppActions = (args: {
  readonly state: AppState;
  readonly actions: AppActions;
  readonly history: NavigationHistory;
  readonly location: NavigationLocation;
  readonly events: NavigationEvents;
}) => {
  const runtime = createNavigationRuntime(args);
  const historyOperations = createHistoryOperations(runtime);
  const { recordAction } = createNavigationRecorder(runtime, historyOperations);
  const routeOperations = createRouteOperations(runtime, historyOperations);
  const navigable: NavigationActions = {
    switchTab: recordAction(args.actions.switchTab),
    openDiagnosticsPage: recordAction(args.actions.openDiagnosticsPage),
    openAboutPage: recordAction(args.actions.openAboutPage),
    openFolderSettings: recordAction(args.actions.openFolderSettings),
    closeFolderSettings: () => routeOperations.goBackFromPage(args.actions.closeFolderSettings),
    openFolderRoot: recordAction(args.actions.openFolderRoot),
    openDirectory: recordAction(args.actions.openDirectory),
    goToBreadcrumb: recordAction(args.actions.goToBreadcrumb),
    goToRootView: recordAction(args.actions.goToRootView),
    openFavorite: recordAction(args.actions.openFavorite),
    closeDiagnosticsPage: () => routeOperations.goBackFromPage(args.actions.closeDiagnosticsPage),
    closeAboutPage: () => routeOperations.goBackFromPage(args.actions.closeAboutPage),
  };
  return {
    ...args.actions,
    ...navigable,
    startNavigation: routeOperations.startNavigation,
    restoreNavigationRoute: routeOperations.restoreNavigationRoute,
    syncNavigationRoute: historyOperations.syncCurrentRoute,
  };
};
