import type { FileEntry, FolderInfo, FolderSyncState, RemoteDeviceInfo } from "../core/model/remoteFs.ts";
import type { ConnectOptions, ConnectionOverview, RemoteFsLike } from "./browserClient.ts";

export type SessionPhase = "idle" | "connecting" | "connected" | "refreshing" | "error";

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
  connectionTransport: "direct-tcp" | "relay" | "";
  folders: FolderInfo[];
  folderSyncStates: FolderSyncState[];
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
  openFolder: (folderId: string, options?: ConnectOptions) => Promise<void>;
  openPath: (path: string, options?: ConnectOptions) => Promise<void>;
  goToPath: (folderId: string, path: string, options?: ConnectOptions) => Promise<void>;
  reloadCurrentDirectory: (options?: ConnectOptions) => Promise<void>;
  setFolderPasswords: (folderPasswords: Record<string, string>) => Promise<void>;
}

export interface SyncpeerSessionStore {
  getState: () => SessionState;
  subscribe: (listener: (state: SessionState) => void) => () => void;
  actions: SessionRuntimeActions;
}

