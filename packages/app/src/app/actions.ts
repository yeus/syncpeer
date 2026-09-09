import {
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import { getAppBuildInfo } from "../lib/appInfo.ts";
import {
  cacheFileKeyExists,
  favoriteEntryKey,
  formatBytes,
  formatModified,
  isSavedDeviceConnected,
  rootFolderEntries,
  persistState,
  type AppState,
} from "./state.ts";
import { restoreOfflineSnapshot } from "./syncPolicies.ts";
import { createConnectionActions } from "./connectionActions.ts";
import { createDirectoryActions } from "./directoryActions.ts";
import { createDeviceActions } from "./deviceActions.ts";
import { createFileActions } from "./fileActions.ts";
import { createPageActions } from "./pageActions.ts";
import { createStarredActions } from "./starredActions.ts";
import type { TransferRuntime } from "./transferRuntime.ts";
import { clearDirectoryView } from "./actionSupport.ts";

export const createAppActions = (args: {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly transfers: TransferRuntime;
}) => {
  const { state, client, sessionStore, transfers } = args;
  const appInfo = getAppBuildInfo();
  const starred = createStarredActions({ state, client, transfers });
  const connection = createConnectionActions({
    state,
    client,
    sessionStore,
    transfers,
    syncStarredFiles: starred.syncStarredFiles,
    appInfo,
  });
  const directory = createDirectoryActions({
    state,
    client,
    sessionStore,
    refreshActiveView: connection.refreshActiveView,
  });
  const files = createFileActions({
    state,
    client,
    sessionStore,
    transfers,
    ensureConnectedForTransfer: connection.ensureConnectedForTransfer,
    openCachedFile: directory.openCachedFile,
  });
  const devices = createDeviceActions({
    state,
    client,
    sessionStore,
    refreshOverview: connection.refreshOverview,
    refreshActiveView: connection.refreshActiveView,
    refreshCurrentDeviceId: connection.refreshCurrentDeviceId,
  });
  const page = createPageActions({
    state,
    sessionStore,
    refreshActiveView: connection.refreshActiveView,
    discoverLocalDevices: connection.discoverLocalDevices,
    connect: connection.connect,
  });

  return {
    ...connection,
    ...directory,
    ...files,
    ...devices,
    ...page,
    starredSync: starred.syncStarredFiles,
    persist: () => persistState(state),
    restoreOfflineSnapshot: (deviceId?: string, reason?: string) =>
      restoreOfflineSnapshot(state, clearDirectoryView, deviceId, reason),
  };
};

export {
  cacheFileKeyExists,
  favoriteEntryKey,
  formatBytes,
  formatModified,
  isSavedDeviceConnected,
  rootFolderEntries,
};
