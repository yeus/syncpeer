import type { SyncpeerSessionStore } from "@syncpeer/core/browser";
import { hasAutoConnectTarget } from "./syncPolicies.ts";
import { pushSessionLog, type AppState } from "./state.ts";

export const createPageActions = (args: {
  readonly state: AppState;
  readonly sessionStore: SyncpeerSessionStore;
  readonly refreshActiveView: () => Promise<void>;
  readonly discoverLocalDevices: (options?: { timeoutMs?: number }) => Promise<void>;
  readonly connect: () => Promise<void>;
}) => {
  const {
    state,
    sessionStore,
    refreshActiveView,
    discoverLocalDevices,
    connect,
  } = args;

const switchTab = (tab: AppState["activeTab"], event?: MouseEvent) => {
  event?.preventDefault();
  event?.stopPropagation();
  if (state.activeTab === tab) return;
  state.activeTab = tab;
  pushSessionLog(state, "info", "ui.tab.switch", `Switched tab to ${tab}`);
  void refreshActiveView();
};

const setAutoConnectPaused = (paused: boolean) => {
  state.ui.autoConnectPaused = paused;
};

const setAppVisibility = (isVisible: boolean) => {
  state.ui.isAppVisible = isVisible;
  void sessionStore.actions.setForeground(isVisible);
};

const onNetworkOnline = async () => {
  await sessionStore.actions.setOnline(true);
  if (state.ui.autoConnectPaused) return;
  await discoverLocalDevices({ timeoutMs: 1200 });
  if (!hasAutoConnectTarget(state)) return;
  if (state.session.isConnected || state.session.isConnecting) return;
  await connect();
};

const onAppForeground = async () => {
  if (state.ui.autoConnectPaused) return;
  await discoverLocalDevices({ timeoutMs: 1200 });
  if (!hasAutoConnectTarget(state)) return;
  if (state.session.isConnected || state.session.isConnecting) return;
  await connect();
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
  };
};
