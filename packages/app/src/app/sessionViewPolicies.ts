import type { SessionState } from "@syncpeer/core/browser";
import type { AppState } from "./state.ts";

type SessionView = AppState["session"];

const withIdleDirectory = (
  directory: SessionView["directory"],
  overrides: Partial<SessionView["directory"]> = {},
): SessionView["directory"] => ({
  ...directory,
  status: "idle" as SessionState["directory"]["status"],
  error: null,
  ...overrides,
});

export const clearDirectoryViewState = (
  session: SessionView,
): SessionView => ({
  ...session,
  directory: withIdleDirectory(session.directory, {
    folderId: "",
    path: "",
    entries: [],
    versionKey: "",
  }),
  currentFolderId: "",
  currentPath: "",
  entries: [],
  currentFolderVersionKey: "",
  directoryPage: 1,
});

export const resetRuntimeSessionState = (
  session: SessionView,
): SessionView => ({
  ...session,
  isConnected: false,
  remoteFs: null,
  directory: withIdleDirectory(session.directory, {
    entries: [],
  }),
  entries: [],
  activeConnectDeviceId: "",
  connectedSourceDeviceId: "",
  hasNonEmptyOverviewInSession: false,
});
