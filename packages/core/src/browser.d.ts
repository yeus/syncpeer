export interface ConnectOptions {
  host: string;
  port: number;
  discoveryMode?: "global" | "direct";
  discoveryServer?: string;
  cert?: string;
  key?: string;
  remoteId?: string;
  deviceName: string;
  timeoutMs?: number;
  enableRelayFallback?: boolean;
  folderPasswords?: Record<string, string>;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedMs: number;
}

export interface FolderInfo {
  id: string;
  label: string;
  readOnly: boolean;
  advertisedDevices?: Array<{ id: string; name?: string }>;
  encrypted?: boolean;
  needsPassword?: boolean;
  passwordError?: string;
  localDevicePresentInFolder?: boolean;
  stopReason?: number;
}

export interface FolderSyncState {
  folderId: string;
  remoteIndexId: string;
  remoteMaxSequence: string;
  indexReceived: boolean;
}

export interface RemoteFsLike {
  listFolders: () => Promise<FolderInfo[]>;
  readDir: (folderId: string, path: string) => Promise<FileEntry[]>;
  readFileFully: (
    folderId: string,
    path: string,
    onProgress?: (progress: { downloadedBytes: number; totalBytes: number }) => void,
  ) => Promise<Uint8Array>;
  writeFileFully: (
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: { modifiedMs?: number },
  ) => Promise<void>;
}

export interface ConnectionOverview {
  folders: FolderInfo[];
  device: { id: string; deviceName: string; clientName: string; clientVersion: string } | null;
  folderSyncStates: FolderSyncState[];
  connectedVia: string;
  transportKind: "direct-tcp" | "relay";
}

export interface SyncpeerBrowserClient {
  connectAndSync: (options: ConnectOptions) => Promise<RemoteFsLike>;
  connectAndGetOverview: (options: ConnectOptions) => Promise<ConnectionOverview>;
  connectAndGetFolderVersions: (options: ConnectOptions) => Promise<FolderSyncState[]>;
  disconnect: () => Promise<void>;
}

export interface UiLogEntry {
  timestampMs: number;
  level: "info" | "error";
  event: string;
  details?: unknown;
}

export function createSyncpeerBrowserClient(options: any): SyncpeerBrowserClient;
export function getDefaultDiscoveryServer(): string;
export function normalizeDiscoveryServer(value: string | undefined): string;
export function reportClientError(
  platformAdapter: unknown,
  event: string,
  error: unknown,
  context?: unknown,
): Promise<void>;

export interface SessionTraceEvent {
  atMs: number;
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SessionState {
  phase: "idle" | "connecting" | "connected" | "refreshing" | "error";
  sourceDeviceId: string;
  remoteFs: RemoteFsLike | null;
  remoteDevice: { id: string; deviceName: string; clientName: string; clientVersion: string } | null;
  connectionPath: string;
  connectionTransport: "direct-tcp" | "relay" | "";
  folders: FolderInfo[];
  folderSyncStates: FolderSyncState[];
  currentFolderId: string;
  currentPath: string;
  entries: FileEntry[];
  currentFolderVersionKey: string;
  snapshot: {
    active: boolean;
    sourceDeviceId: string;
    restoredAtMs?: number;
    liveDataSeenInSession: boolean;
  };
  pending: {
    connecting: boolean;
    loadingDirectory: boolean;
    refreshingOverview: boolean;
  };
  connectOptions: ConnectOptions | null;
  requestEpoch: number;
  directoryLoadSeq: number;
  lastError: string | null;
}

export interface SyncpeerSessionStore {
  getState: () => SessionState;
  subscribe: (listener: (state: SessionState) => void) => () => void;
  actions: {
    connect: (options: ConnectOptions) => Promise<void>;
    disconnect: () => Promise<void>;
    refreshOverview: (options?: ConnectOptions) => Promise<void>;
    goToRoot: () => Promise<void>;
    openFolder: (folderId: string, options?: ConnectOptions) => Promise<void>;
    openPath: (path: string, options?: ConnectOptions) => Promise<void>;
    goToPath: (folderId: string, path: string, options?: ConnectOptions) => Promise<void>;
    reloadCurrentDirectory: (options?: ConnectOptions) => Promise<void>;
    setFolderPasswords: (folderPasswords: Record<string, string>) => Promise<void>;
  };
}

export function createSyncpeerSessionStore(args: {
  transport: {
    connectAndSync: (options: ConnectOptions) => Promise<RemoteFsLike>;
    connectAndGetOverview: (options: ConnectOptions) => Promise<ConnectionOverview>;
    connectAndGetFolderVersions: (options: ConnectOptions) => Promise<FolderSyncState[]>;
    disconnect?: () => Promise<void>;
  };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onTrace?: (event: SessionTraceEvent) => void;
}): SyncpeerSessionStore;

export type FolderIndexPollAttempt = Record<string, unknown>;
export type ReadDirAttempt = Record<string, unknown>;
export function makeReadDirWithRetryFlow(args: any): any;
export function makeWaitForFolderIndexToArriveFlow(args: any): any;
export function makeWaitForFoldersToPopulateFlow(args: any): any;

export function buildConnectionDetails(settings: any, folderPasswords: Record<string, string>): ConnectOptions;
export function fromConnectionSettings(value: any): any;
export function toConnectionSettings(value: any): any;
export function normalizeDeviceId(value: string): string;
export function normalizePath(value: string): string;
export function resolveDirectoryPath(basePath: string, childPath: string): string;
export function sleep(ms: number): Promise<void>;
