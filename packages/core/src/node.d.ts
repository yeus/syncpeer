export interface SyncpeerTlsConnectOptions {
  host: string;
  port: number;
  certPem: string;
  keyPem: string;
  caPem?: string;
}

export interface SyncpeerTlsSocket {
  read: (maxBytes?: number) => Promise<Uint8Array>;
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  peerCertificateDer: () => Promise<Uint8Array>;
}

export interface SyncpeerConnectOptions {
  host: string;
  port: number;
  certPem: string;
  keyPem: string;
  expectedDeviceId?: string;
  deviceName: string;
  timeoutMs?: number;
  discoveryMode?: "global" | "direct";
  discoveryServer?: string;
  enableRelayFallback?: boolean;
  folderPasswords?: Record<string, string>;
}

export interface NodeDiscoveryCandidate {
  address: string;
  host?: string;
  port?: number;
  protocol: "tcp" | "relay" | "unknown";
}

export interface NodeDiscoveryResult {
  payload: unknown;
  candidates: NodeDiscoveryCandidate[];
}

export interface NodeRemoteFs {
  listFolders(): Promise<Array<{ id: string; label: string; readOnly: boolean }>>;
  waitForFolderIndex(folderId: string, timeoutMs?: number, pollMs?: number): Promise<boolean>;
  readDir(folderId: string, path: string): Promise<Array<{ name: string; path: string; type: string }>>;
  readFileFully(folderId: string, path: string): Promise<Uint8Array>;
  writeFileFully(
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: {
      modifiedMs?: number;
      onProgress?: (progress: {
        processedBytes: number;
        totalBytes: number;
        elapsedMs: number;
        phase: "preparing" | "publishing";
      }) => void;
    },
  ): Promise<void>;
}

export interface NodeSessionHandle {
  remoteFs: NodeRemoteFs;
  close(): Promise<void>;
}

export interface NodeSyncpeerClient {
  openSession(options: SyncpeerConnectOptions): Promise<NodeSessionHandle>;
}

export interface NodeSessionTransport {
  connectAndSync: (options: {
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
  }) => Promise<any>;
  connectAndGetOverview: (options: {
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
  }) => Promise<any>;
  connectAndGetFolderVersions: (options: {
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
  }) => Promise<any>;
  disconnect: () => Promise<void>;
}

export function createNodeHostAdapter(): unknown;
export function resolveNodeGlobalDiscovery(options: {
  expectedDeviceId: string;
  discoveryServer?: string;
}): Promise<NodeDiscoveryResult>;
export function resolveNodeLocalDiscovery(options?: {
  expectedDeviceId?: string;
  timeoutMs?: number;
  listenPort?: number;
  signal?: AbortSignal;
}): Promise<NodeDiscoveryResult>;
export function createNodeSyncpeerClient(): NodeSyncpeerClient;
export function createNodeSessionTransport(): NodeSessionTransport;
