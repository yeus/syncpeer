import type { FileEntry, FolderInfo, FolderSyncState, RemoteDeviceInfo } from "../core/model/remoteFs.js";
import type { ConnectOptions, ConnectionOverview, RemoteFsLike } from "./browserClient.js";
import type { ConnectionScope } from "../client.js";
import type { ConnectionLifecycleState } from "./connectionLifecycle.js";

export type SessionPhase = "idle" | "connecting" | "connected" | "waiting" | "reconnecting" | "suspended" | "stopping" | "refreshing" | "error";
export type DirectoryStatus = "idle" | "loading" | "ready" | "stale" | "locked" | "error";

export interface SessionDirectoryState {
  folderId: string;
  path: string;
  entries: FileEntry[];
  status: DirectoryStatus;
  versionKey: string;
  loadedAtMs: number;
  error: string | null;
  requestSeq: number;
}

export interface SessionSnapshotState {
  active: boolean;
  sourceDeviceId: string;
  restoredAtMs?: number;
  liveDataSeenInSession: boolean;
}

export interface SessionPendingState {
  connecting: boolean;
  loadingDirectory: boolean;
  refreshingOverview: boolean;
}

export interface SessionState {
  phase: SessionPhase;
  sourceDeviceId: string;
  remoteFs: RemoteFsLike | null;
  remoteDevice: RemoteDeviceInfo | null;
  connectionPath: string;
  connectionTransport: "direct-tcp" | "direct-quic" | "relay" | "";
  connectionScope: ConnectionScope | "";
  folders: FolderInfo[];
  folderSyncStates: FolderSyncState[];
  directory: SessionDirectoryState;
  currentFolderId: string;
  currentPath: string;
  entries: FileEntry[];
  currentFolderVersionKey: string;
  snapshot: SessionSnapshotState;
  pending: SessionPendingState;
  connectOptions: ConnectOptions | null;
  requestEpoch: number;
  directoryLoadSeq: number;
  lastError: string | null;
  attempt: number;
  nextRetryAtMs: number | null;
  closureReason: string | null;
  upgradeStatus: "idle" | "probing" | "switching";
}

export interface SessionTraceEvent {
  atMs: number;
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SessionTransport {
  connectAndSync: (options: ConnectOptions) => Promise<RemoteFsLike>;
  connectAndGetOverview: (options: ConnectOptions) => Promise<ConnectionOverview>;
  connectAndGetFolderVersions: (options: ConnectOptions) => Promise<FolderSyncState[]>;
  disconnect?: () => Promise<void>;
  subscribeLifecycle?: (listener: (state: ConnectionLifecycleState) => void) => () => void;
  setOnline?: (online: boolean) => Promise<void>;
  setForeground?: (foreground: boolean) => Promise<void>;
  setTransferActive?: (active: boolean) => Promise<void>;
}

export interface SessionRuntimeDeps {
  transport: SessionTransport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onTrace?: (event: SessionTraceEvent) => void;
}

export interface SessionRuntimeActions {
  connect: (options: ConnectOptions) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshOverview: (options?: ConnectOptions) => Promise<void>;
  goToRoot: () => Promise<void>;
  openFolder: (folderId: string, options?: ConnectOptions) => Promise<void>;
  openPath: (path: string, options?: ConnectOptions) => Promise<void>;
  goToPath: (folderId: string, path: string, options?: ConnectOptions) => Promise<void>;
  reloadCurrentDirectory: (options?: ConnectOptions) => Promise<void>;
  setFolderPasswords: (folderPasswords: Record<string, string>) => Promise<void>;
  setOnline: (online: boolean) => Promise<void>;
  setForeground: (foreground: boolean) => Promise<void>;
  setTransferActive: (active: boolean) => Promise<void>;
}

export interface SyncpeerSessionStore {
  getState: () => SessionState;
  subscribe: (listener: (state: SessionState) => void) => () => void;
  actions: SessionRuntimeActions;
}
