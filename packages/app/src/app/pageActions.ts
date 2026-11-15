import type { SyncpeerSessionStore } from "@syncpeer/core/browser";
import { hasAutoConnectTarget } from "./syncPolicies.ts";
import { pushSessionLog, type AppState } from "./state.ts";

export const createPageActions = (args: {
  readonly state: AppState;
  readonly sessionStore: SyncpeerSessionStore;
  readonly discoverLocalDevices: (options?: { timeoutMs?: number }) => Promise<void>;
  readonly connect: () => Promise<void>;
}) => {
  const {
    state,
    sessionStore,
    discoverLocalDevices,
    connect,
  } = args;

// Visibility and focus events can fire in a burst after Android standby.
// The native service must finish its foreground handoff before a UI dial.
let visibilityTransition: Promise<void> = Promise.resolve();
let lastVisibilityRequested: boolean | null = null;
let visibilityRunning = false;
let lastVisibilityApplied: boolean | null = null;
let foregroundPass: Promise<void> | null = null;

const switchTab = (tab: AppState["activeTab"], event?: MouseEvent) => {
  event?.preventDefault();
  event?.stopPropagation();
  if (state.activeTab === tab) return;
  state.activeTab = tab;
  pushSessionLog(state, "info", "ui.tab.switch", `Switched tab to ${tab}`);
  // Tab switching is pure navigation. Data refresh is driven by the periodic
  // refresh timer and by explicit user actions; the favorites reconciliation
  // scan (remote directory walks plus local hashing) is far too expensive to
  // run on every navigation.
};

const setAutoConnectPaused = (paused: boolean) => {
  state.ui.autoConnectPaused = paused;
};

const setAppVisibility = (isVisible: boolean) => {
  state.ui.isAppVisible = isVisible;
  // Android fires focus, pageshow and visibilitychange in a single wake-up.
  // Serialize native handoffs and collapse duplicate/obsolete requests so a
  // stale background transition cannot finish after the foreground transition.
  if (lastVisibilityRequested === isVisible) return;
  lastVisibilityRequested = isVisible;
  const apply = async () => {
    if (lastVisibilityRequested !== isVisible || lastVisibilityApplied === isVisible) return;
    await sessionStore.actions.setForeground(isVisible);
    lastVisibilityApplied = isVisible;
  };
  // Preserve the initial synchronous handoff. Subsequent changes queue behind
  // the running operation; superseded transitions are dropped before dispatch.
  const work = visibilityRunning
    ? visibilityTransition.catch(() => undefined).then(apply) : apply();
  visibilityRunning = true;
  const settled = work.catch(() => {
    pushSessionLog(state, "warning", "app.visibility.handoff_failed",
      "Android foreground/background session handoff did not complete.");
    throw new Error("Foreground session handoff failed.");
  });
  visibilityTransition = settled;
  void settled.finally(() => {
    if (visibilityTransition === settled) visibilityRunning = false;
  }).catch(() => undefined);
};

const currentAutoTarget = () =>
  hasAutoConnectTarget(state)
    ? state.connection.remoteId || state.devices.selectedSavedDeviceId
    : "";

const discoverThenConnect = async (targetAtStart = currentAutoTarget()) => {
  // The service already owns the authenticated socket. Focus/online events
  // must not perform another native discovery while that socket is usable or
  // while the UI is already waiting for its one service-owned connection.
  if (!state.ui.isAppVisible || state.ui.autoConnectPaused || !state.ui.deviceNameConfirmed ||
    state.session.isConnected || state.session.isConnecting) return;
  await discoverLocalDevices({ timeoutMs: 1200 });
  // Discovery is asynchronous. Adding or selecting a peer while it runs must
  // not let an earlier startup/online callback dial a stale configuration.
  if (!targetAtStart || currentAutoTarget() !== targetAtStart ||
    !state.ui.isAppVisible || state.ui.autoConnectPaused || !state.ui.deviceNameConfirmed ||
    state.session.isConnected || state.session.isConnecting) return;
  await connect();
};

const onNetworkOnline = async () => {
  await sessionStore.actions.setOnline(true);
  await discoverThenConnect();
};

const onAppForeground = (): Promise<void> => {
  if (foregroundPass) return foregroundPass;
  const targetAtStart = currentAutoTarget();
  const work = (async () => {
    await visibilityTransition;
    if (!state.ui.isAppVisible) return;
    await discoverThenConnect(targetAtStart);
  })();
  foregroundPass = work;
  void work.finally(() => {
    if (foregroundPass === work) foregroundPass = null;
  }).catch(() => undefined);
  return work;
};

const openDiagnosticsPage = () => {
  state.currentPage = "diagnostics";
};

const closeDiagnosticsPage = () => {
  state.currentPage = "main";
};

const openAboutPage = () => {
  state.currentPage = "about";
};

const closeAboutPage = () => {
  state.currentPage = "main";
};


  return {
    switchTab,
    setAutoConnectPaused,
    setAppVisibility,
    onNetworkOnline,
    onAppForeground,
    openDiagnosticsPage,
    closeDiagnosticsPage,
    openAboutPage,
    closeAboutPage,
    openGeneralSettings: () => { state.currentPage = "general-settings"; },
    closeGeneralSettings: () => { state.currentPage = "main"; },
    openNewFolder: () => { state.currentPage = "new-folder"; },
    closeNewFolder: () => { state.currentPage = "main"; },
    openFolderSettings: (folderId: string) => {
      state.ui.recentError = "";
      state.folderSettingsId = folderId;
      state.currentPage = "folder-settings";
    },
    closeFolderSettings: () => { state.currentPage = "main"; },
    closeVersions: () => { state.currentPage = "main"; },
  };
};
