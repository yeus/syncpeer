import { PIM_TAB_VISIBLE } from "./features.ts";
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
type ForegroundPass = {
  work: Promise<void>;
  targetAtDial: string;
  followUpTarget: string;
  followUp: Promise<void> | null;
};
let foregroundPass: ForegroundPass | null = null;

const switchTab = (tab: AppState["activeTab"], event?: MouseEvent) => {
  event?.preventDefault();
  event?.stopPropagation();
  if (tab === "pim" && !PIM_TAB_VISIBLE) return;
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
  // Peer-session discovery is already owned by the transport. Do not start an
  // additional LAN scan (and native multicast work) before a saved-peer dial.
  if (!state.ui.isAppVisible || state.ui.autoConnectPaused || !state.ui.deviceNameConfirmed ||
    state.session.isConnected || state.session.isConnecting) return;
  if (!targetAtStart) {
    await discoverLocalDevices({ timeoutMs: 1200 });
    return;
  }
  if (currentAutoTarget() !== targetAtStart || !state.ui.isAppVisible ||
    state.ui.autoConnectPaused || state.session.isConnected || state.session.isConnecting) return;
  await connect();
};

const onNetworkOnline = async () => {
  await sessionStore.actions.setOnline(true);
  await discoverThenConnect();
};

const onAppForeground = (): Promise<void> => {
  const target = currentAutoTarget();
  if (foregroundPass) {
    const pass = foregroundPass;
    // The first pass can be busy with LAN discovery when the encrypted roster
    // finishes loading. Coalesce its post-unlock retry, rather than losing the
    // only saved-peer dial to the earlier empty-roster foreground pass.
    if (target && target !== pass.targetAtDial) {
      if (pass.followUp && pass.followUpTarget === target) return pass.followUp;
      pass.followUpTarget = target;
      pass.followUp = pass.work.then(() =>
        pass.targetAtDial === target ? undefined : discoverThenConnect(target));
      return pass.followUp;
    }
    return pass.work;
  }
  const pass: ForegroundPass = {
    work: Promise.resolve(), targetAtDial: target, followUpTarget: "", followUp: null,
  };
  // A peer restored during a still-running native handoff is already
  // authorized. A new peer added during a subsequent UI-only scan is not.
  const waitForHandoff = visibilityRunning;
  const work = (async () => {
    await visibilityTransition;
    if (!state.ui.isAppVisible) return;
    pass.targetAtDial = waitForHandoff ? currentAutoTarget() : target;
    await discoverThenConnect(pass.targetAtDial);
  })();
  pass.work = work;
  foregroundPass = pass;
  void work.finally(() => {
    if (foregroundPass === pass) foregroundPass = null;
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
    openGeneralSettings: (section: AppState["settingsSection"] = "personal-space") => {
      state.settingsSection = typeof section === "string" ? section : "personal-space";
      state.currentPage = "general-settings";
    },
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
