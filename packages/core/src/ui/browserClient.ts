import { certificateDerFromPem, createSyncpeerCoreClient, deviceIdFromCertificate,
  type SyncpeerConnectOptions, type SyncpeerHostAdapter, type SyncpeerSessionHandle,
  withMetadataSession } from "../client.js";
import { startIncomingPeerService } from "../sync/incomingPeerService.js";
import { preferredPeerDirection } from "../sync/peerSessionManager.js";
import { createConnectionLifecycle, type ConnectionLifecycle,
  type ConnectionLifecycleState } from "./connectionLifecycle.js";
import { createRecoveringRemoteFs } from "./recoveringRemoteFs.js";
import type { ConnectionScope } from "../client.js";
import type { SharedFolder } from "../client.js";
import { normalizeDiscoveryServer } from "./discoveryServer.js";
export { getDefaultDiscoveryServer, normalizeDiscoveryServer } from "./discoveryServer.js";
import type {
  FileDownloadProgress,
  FileEntry,
  FileDeleteOptions,
  FileUploadOptions,
  FolderInfo,
  FolderSyncState,
  RemoteDeviceInfo,
} from "../core/model/remoteFs.js";
import type { FileDownloadResult, FileDownloadSink, FileUploadSource } from "../transfer/stream.js";
import type { SyncpeerProfileSettings } from "../sync/profileSettings.js";
import { acceptPairingTransfer, joinPersonalSpace } from "../sync/personalSpacePairingTransport.js";
import { createPairingInvitation, type PairingInvitation,
  type PersonalSpacePairingTransfer } from "../sync/personalSpacePairing.js";

export interface ConnectOptions {
  host: string;
  port: number;
  discoveryMode?: "automatic" | "global" | "lan" | "direct";
  discoveryServer?: string;
  cert?: string;
  key?: string;
  remoteId?: string;
  deviceName: string;
  timeoutMs?: number;
  enableRelayFallback?: boolean;
  relayOnly?: boolean;
  quicOnly?: boolean;
  folderPasswords?: Record<string, string>;
  sharedFolders?: SharedFolder[];
}

export interface LocalDiscoveredDevice {
  deviceId: string;
  addresses: string[];
  anonymous?: boolean;
}

export interface RemoteFsLike {
  listFolders: () => Promise<FolderInfo[]>;
  requestFolderIndex: (folderId: string) => Promise<void>;
  setFocusedFolder: (folderId: string | null) => void;
  waitForFolderIndex: (folderId: string, timeoutMs?: number, pollMs?: number) => Promise<boolean>;
  readDir: (folderId: string, path: string) => Promise<FileEntry[]>;
  readFileFully: (
    folderId: string,
    path: string,
    onProgress?: (progress: FileDownloadProgress) => void,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  readFileToSink?: (
    folderId: string,
    path: string,
    sink: FileDownloadSink,
    onProgress?: (progress: FileDownloadProgress) => void,
    signal?: AbortSignal,
  ) => Promise<FileDownloadResult>;
  listFiles?: (folderId: string) => Promise<FileEntry[]>;
  writeFileFully: (
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: FileUploadOptions,
  ) => Promise<void>;
  writeFileStream: (
    folderId: string,
    path: string,
    source: FileUploadSource,
    options?: FileUploadOptions,
  ) => Promise<void>;
  deleteFile?: (
    folderId: string,
    path: string,
    options?: FileDeleteOptions,
  ) => Promise<void>;
}

export interface ConnectionOverview {
  folders: FolderInfo[];
  device: RemoteDeviceInfo | null;
  folderSyncStates: FolderSyncState[];
  connectedVia: string;
  transportKind: "direct-tcp" | "direct-quic" | "relay";
  connectionScope?: ConnectionScope;
}

export interface UiLogEntry {
  timestampMs: number;
  level: "info" | "error";
  event: string;
  details?: unknown;
}

export interface SyncpeerIdentityRecord {
  certPath?: string;
  keyPath?: string;
  certPem: string;
  keyPem: string;
}

export interface IdentityRecoveryExportResponse {
  deviceId: string;
  recoverySecret: string;
}

export interface FavoriteRecord {
  key: string;
  folderId: string;
  path: string;
  name: string;
  kind: "folder" | "file";
}

export interface CachedFileStatus {
  path: string;
  available: boolean;
  localPath?: string;
  cachedAtMs?: number;
}

export interface CachedFileDigest {
  folderId: string;
  path: string;
  hash?: string;
}

export interface CachedFileRecord {
  key: string;
  folderId: string;
  path: string;
  name: string;
  localPath?: string;
  safRelativePath?: string;
  sizeBytes: number;
  cachedAtMs: number;
  modifiedMs?: number;
  syncBaseline?: { hash: string; sizeBytes: number; modifiedMs: number };
  /** Writable providers cannot safely infer a remote baseline from local timestamps. */
  syncBaselineRequired?: boolean;
}

export interface DocumentVersionRecord {
  id: string;
  modifiedMs: number;
  sizeBytes: number;
}

/** Service-owned favorite sync state, reported without filenames in logs. */
export interface FavoriteSyncStateRecord {
  path: string;
  phase: "synced" | "downloading" | "uploading" | "deleting-remote" | "deleting-local" | "conflict" | "error";
  message?: string;
  attempts: number;
  updatedAtMs: number;
  nextAttemptMs: number;
}

export interface FavoriteSyncStateSnapshot {
  folderId: string;
  entries: FavoriteSyncStateRecord[];
}

export interface AndroidContactRecord {
  contactId: string;
  displayName: string;
  lookupKey: string;
  phones: string[];
  emails: string[];
}

export interface AndroidCalendarEventRecord {
  eventId: string;
  calendarId: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startMs: number;
  endMs: number;
  allDay: boolean;
}

export interface SyncpeerPlatformAdapter {
  startBackgroundSession?: (options: Omit<ConnectOptions, "sharedFolders">) => Promise<void>;
  stopBackgroundSession?: () => Promise<void>;
  acknowledgeCachedSync?: (folderId: string, path: string, baseline: NonNullable<CachedFileRecord["syncBaseline"]>) => Promise<boolean>;
  readTextFile?: (path: string) => Promise<string>;
  readBinaryFile?: (path: string) => Promise<Uint8Array>;
  readCachedFile?: (folderId: string, path: string) => Promise<Uint8Array>;
  pickUploadFile?: () => Promise<string | null | undefined>;
  readDefaultIdentity?: () => Promise<SyncpeerIdentityRecord>;
  listFavorites?: () => Promise<FavoriteRecord[]>;
  upsertFavorite?: (favorite: FavoriteRecord) => Promise<FavoriteRecord[]>;
  removeFavorite?: (key: string) => Promise<FavoriteRecord[]>;
  loadProfileSettings?: () => Promise<SyncpeerProfileSettings>;
  saveProfileSettings?: (settings: SyncpeerProfileSettings) => Promise<void>;
  exportPairingTransfer?: () => Promise<PersonalSpacePairingTransfer>;
  importPairingTransfer?: (transfer: PersonalSpacePairingTransfer, password: string,
    remember: boolean) => Promise<void>;
  /** Folders currently owned by the encrypted document store and safe to advertise over BEP. */
  sessionSharedFolders?: (folderPasswords: Record<string, string>) => Promise<SharedFolder[]>;
  loadDirectorySnapshot?: (folderId: string, sourceDeviceId: string, path: string) => Promise<{
    entries: FileEntry[]; versionKey: string; loadedAtMs: number;
  } | null>;
  saveDirectorySnapshot?: (folderId: string, sourceDeviceId: string, path: string, snapshot: {
    entries: FileEntry[]; versionKey: string; loadedAtMs: number;
  }) => Promise<void>;
  enforceCacheQuota?: () => Promise<{ quotaBytes: number; cachedBytes: number; protectedBytes: number; evicted: string[] }>;
  listDocumentVersions?: (folderId: string, path: string) => Promise<DocumentVersionRecord[]>;
  restoreDocumentVersion?: (folderId: string, path: string, versionId: string) => Promise<void>;
  listFavoriteSyncStates?: (folderIds: readonly string[]) => Promise<FavoriteSyncStateSnapshot[]>;
  retryFavoriteSync?: (folderId: string, path: string) => Promise<void>;
  resolveFavoriteConflict?: (folderId: string, path: string, resolution: "keep-local" | "keep-remote") => Promise<void>;
  cacheFile?: (
    folderId: string,
    path: string,
    name: string,
    bytes: Uint8Array,
    modifiedMs?: number,
  ) => Promise<void>;
  createFileDownloadSink?: (args: {
    folderId: string;
    path: string;
    name: string;
    modifiedMs?: number;
    /** Optimistic local guard for automatic updates; null requires an absent file. */
    expectedLocalHash?: string | null;
  }) => Promise<FileDownloadSink>;
  startTransfer?: (label: string) => Promise<void>;
  stopTransfer?: () => Promise<void>;
  updateTransferNotification?: (args: {
    title: string;
    body: string;
    progress?: number;
    ongoing: boolean;
    cancellable: boolean;
  }) => Promise<void>;
  getCachedStatuses?: (folderId: string, paths: string[]) => Promise<CachedFileStatus[]>;
  digestCachedFiles?: (files: readonly { folderId: string; path: string }[]) => Promise<CachedFileDigest[]>;
  listCachedFiles?: () => Promise<CachedFileRecord[]>;
  listLocalDirectory?: (folderId: string, path: string) => Promise<FileEntry[] | null>;
  openCachedFile?: (folderId: string, path: string) => Promise<void>;
  openCachedFileDirectory?: (folderId: string, path: string) => Promise<void>;
  openCachedDirectory?: (folderId: string, path: string) => Promise<void>;
  removeCachedFile?: (folderId: string, path: string) => Promise<boolean>;
  clearCache?: () => Promise<void>;
  getAndroidSafTreeUri?: () => Promise<string | null>;
  pickAndroidSafDirectory?: () => Promise<string>;
  setAndroidSafTreeUri?: (treeUri?: string | null) => Promise<string | null>;
  listAndroidPersistedSafUris?: () => Promise<string[]>;
  listAndroidContacts?: () => Promise<AndroidContactRecord[]>;
  upsertAndroidContact?: (input: {
    contactId?: string | null;
    displayName: string;
    note?: string | null;
    phones: string[];
    emails: string[];
  }) => Promise<{ contactId: string }>;
  deleteAndroidContact?: (contactId: string) => Promise<{ deleted: boolean }>;
  listAndroidCalendarEvents?: (args?: {
    startMs?: number | null;
    endMs?: number | null;
  }) => Promise<AndroidCalendarEventRecord[]>;
  upsertAndroidCalendarEvent?: (input: {
    eventId?: string | null;
    calendarId?: string | null;
    title: string;
    description?: string | null;
    location?: string | null;
    startMs: number;
    endMs: number;
    allDay: boolean;
  }) => Promise<{ eventId: string }>;
  deleteAndroidCalendarEvent?: (eventId: string) => Promise<{ deleted: boolean }>;
  exportIdentityRecovery?: () => Promise<IdentityRecoveryExportResponse>;
  restoreIdentityRecovery?: (recoverySecret: string) => Promise<void>;
  getDefaultDeviceId?: () => Promise<string>;
  regenerateDefaultIdentity?: () => Promise<string>;
  logError?: (event: string, details: Record<string, unknown>) => Promise<void>;
}

export interface CreateSyncpeerBrowserClientOptions {
  hostAdapter: SyncpeerHostAdapter;
  platformAdapter?: SyncpeerPlatformAdapter;
  onLog?: (entry: UiLogEntry) => void;
}

export interface SyncpeerBrowserClient {
  acknowledgeCachedSync?: SyncpeerPlatformAdapter["acknowledgeCachedSync"];
  connectAndSync: (options: ConnectOptions) => Promise<RemoteFsLike>;
  connectAndGetOverview: (options: ConnectOptions) => Promise<ConnectionOverview>;
  connectAndGetFolderVersions: (options: ConnectOptions) => Promise<FolderSyncState[]>;
  discoverLocalDevices: (options?: { timeoutMs?: number }) => Promise<LocalDiscoveredDevice[]>;
  disconnect: () => Promise<void>;
  startPairingInvitation: (options: { advertisedHost: string; port?: number; expiresInMs?: number;
    confirm: (code: string) => boolean | Promise<boolean> }) => Promise<{
      invitation: PairingInvitation; completed: Promise<{ remoteDeviceId: string }>; cancel: () => Promise<void> }>;
  joinPairingInvitation: (options: { invitation: PairingInvitation; password: string; remember: boolean;
    confirm: (code: string) => boolean | Promise<boolean> }) => Promise<{ remoteDeviceId: string }>;
  subscribeLifecycle: (listener: (state: ConnectionLifecycleState) => void) => () => void;
  setOnline: (online: boolean) => Promise<void>;
  setForeground: (foreground: boolean) => Promise<void>;
  setTransferActive: (active: boolean) => Promise<void>;
  listFavorites: () => Promise<FavoriteRecord[]>;
  upsertFavorite: (favorite: FavoriteRecord) => Promise<FavoriteRecord[]>;
  removeFavorite: (key: string) => Promise<FavoriteRecord[]>;
  loadProfileSettings: () => Promise<SyncpeerProfileSettings>;
  saveProfileSettings: (settings: SyncpeerProfileSettings) => Promise<void>;
  loadDirectorySnapshot: NonNullable<SyncpeerPlatformAdapter["loadDirectorySnapshot"]>;
  saveDirectorySnapshot: NonNullable<SyncpeerPlatformAdapter["saveDirectorySnapshot"]>;
  enforceCacheQuota: NonNullable<SyncpeerPlatformAdapter["enforceCacheQuota"]>;
  listDocumentVersions: (folderId: string, path: string) => Promise<DocumentVersionRecord[]>;
  restoreDocumentVersion: (folderId: string, path: string, versionId: string) => Promise<void>;
  listFavoriteSyncStates: (folderIds: readonly string[]) => Promise<FavoriteSyncStateSnapshot[]>;
  retryFavoriteSync: (folderId: string, path: string) => Promise<void>;
  resolveFavoriteConflict: (folderId: string, path: string, resolution: "keep-local" | "keep-remote") => Promise<void>;
  cacheFile: (
    folderId: string,
    path: string,
    name: string,
    bytes: Uint8Array,
    modifiedMs?: number,
  ) => Promise<void>;
  createFileDownloadSink?: SyncpeerPlatformAdapter["createFileDownloadSink"];
  startTransfer?: (label: string) => Promise<void>;
  stopTransfer?: () => Promise<void>;
  updateTransferNotification?: SyncpeerPlatformAdapter["updateTransferNotification"];
  getCachedStatuses: (folderId: string, paths: string[]) => Promise<CachedFileStatus[]>;
  digestCachedFiles?: (files: readonly { folderId: string; path: string }[]) => Promise<CachedFileDigest[]>;
  listCachedFiles: () => Promise<CachedFileRecord[]>;
  listLocalDirectory: (folderId: string, path: string) => Promise<FileEntry[] | null>;
  openCachedFile: (folderId: string, path: string) => Promise<void>;
  openCachedFileDirectory: (folderId: string, path: string) => Promise<void>;
  openCachedDirectory: (folderId: string, path: string) => Promise<void>;
  removeCachedFile: (folderId: string, path: string) => Promise<boolean>;
  clearCache: () => Promise<void>;
  getAndroidSafTreeUri: () => Promise<string | null>;
  pickAndroidSafDirectory: () => Promise<string>;
  setAndroidSafTreeUri: (treeUri?: string | null) => Promise<string | null>;
  listAndroidPersistedSafUris: () => Promise<string[]>;
  listAndroidContacts: () => Promise<AndroidContactRecord[]>;
  upsertAndroidContact: (input: {
    contactId?: string | null;
    displayName: string;
    note?: string | null;
    phones: string[];
    emails: string[];
  }) => Promise<{ contactId: string }>;
  deleteAndroidContact: (contactId: string) => Promise<{ deleted: boolean }>;
  listAndroidCalendarEvents: (args?: {
    startMs?: number | null;
    endMs?: number | null;
  }) => Promise<AndroidCalendarEventRecord[]>;
  upsertAndroidCalendarEvent: (input: {
    eventId?: string | null;
    calendarId?: string | null;
    title: string;
    description?: string | null;
    location?: string | null;
    startMs: number;
    endMs: number;
    allDay: boolean;
  }) => Promise<{ eventId: string }>;
  deleteAndroidCalendarEvent: (eventId: string) => Promise<{ deleted: boolean }>;
  exportIdentityRecovery: () => Promise<IdentityRecoveryExportResponse>;
  restoreIdentityRecovery: (recoverySecret: string) => Promise<void>;
  getDefaultDeviceId: () => Promise<string>;
  regenerateDefaultIdentity: () => Promise<string>;
  readBinaryFile: (path: string) => Promise<Uint8Array>;
  readCachedFile?: (folderId: string, path: string) => Promise<Uint8Array>;
  pickUploadFile: () => Promise<string | null | undefined>;
}

const emitLog = (
  onLog: CreateSyncpeerBrowserClientOptions["onLog"],
  level: "info" | "error",
  event: string,
  details?: unknown,
) => {
  onLog?.({
    timestampMs: Date.now(),
    level,
    event,
    details,
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
};

const logClient = (
  onLog: CreateSyncpeerBrowserClientOptions["onLog"],
  event: string,
  details?: unknown,
) => {
  emitLog(onLog, "info", event, details);
  console.log(`[syncpeer-core-ui] ${event}`);
};

const normalizeConnectOptions = (options: ConnectOptions): ConnectOptions => ({
  host: options.host,
  port: options.port,
  discoveryMode: options.discoveryMode ?? "automatic",
  discoveryServer: normalizeDiscoveryServer(options.discoveryServer),
  cert: options.cert && options.cert.trim() !== "" ? options.cert.trim() : undefined,
  key: options.key && options.key.trim() !== "" ? options.key.trim() : undefined,
  remoteId: options.remoteId && options.remoteId.trim() !== "" ? options.remoteId.trim() : undefined,
  deviceName: options.deviceName,
  timeoutMs: options.timeoutMs,
  enableRelayFallback: options.enableRelayFallback ?? true,
  relayOnly: options.relayOnly === true,
  quicOnly: options.quicOnly === true,
  folderPasswords: Object.fromEntries(
    Object.entries(options.folderPasswords ?? {})
      .map(([folderId, password]) => [folderId.trim(), password.trim()])
      .filter(([folderId, password]) => folderId !== "" && password !== ""),
  ),
  sharedFolders: options.sharedFolders?.map((folder) => folder.ciphertextReplica ? {
    ...folder,
    encryption: { ...folder.encryption, passwordToken: folder.encryption.passwordToken.slice() },
  } : ({
    ...folder,
    encryption: { ...folder.encryption },
  })),
});

const maybeInlinePem = (value: string | undefined): string | null => {
  if (!value) return null;
  if (
    value.includes("-----BEGIN CERTIFICATE-----") ||
    value.includes("-----BEGIN PRIVATE KEY-----") ||
    value.includes("-----BEGIN RSA PRIVATE KEY-----")
  ) {
    return value;
  }
  return null;
};

const resolvePemValue = async (
  platformAdapter: SyncpeerPlatformAdapter,
  label: "cert" | "key",
  value: string | undefined,
): Promise<string> => {
  if (!value) {
    throw new Error(`Missing ${label}. Provide PEM text or a readable file path.`);
  }
  const inline = maybeInlinePem(value);
  if (inline) return inline;
  if (!platformAdapter.readTextFile) {
    throw new Error(`Missing ${label}. No readTextFile adapter is configured.`);
  }
  return platformAdapter.readTextFile(value);
};

const serializeConnectionKey = (
  options: ConnectOptions,
  certPem: string,
  keyPem: string,
): string =>
  JSON.stringify({
    host: options.host,
    port: options.port,
    discoveryMode: options.discoveryMode ?? "automatic",
    discoveryServer: normalizeDiscoveryServer(options.discoveryServer),
    remoteId: options.remoteId ?? "",
    deviceName: options.deviceName,
    certPem,
    keyPem,
    relayOnly: options.relayOnly === true,
    quicOnly: options.quicOnly === true,
    folderPasswords: options.folderPasswords ?? {},
    sharedFolders: options.sharedFolders ?? [],
  });

const toConnectionOverview = async (
  session: SyncpeerSessionHandle,
): Promise<ConnectionOverview> => {
  const remoteFs = session.remoteFs;
  const [folders, device, folderSyncStates] = await Promise.all([
    remoteFs.listFolders(),
    Promise.resolve(remoteFs.getRemoteDeviceInfo?.() ?? null),
    Promise.resolve(remoteFs.listFolderSyncStates?.() ?? []),
  ]);
  return {
    folders,
    device,
    folderSyncStates,
    connectedVia: session.connectedVia,
    transportKind: session.transportKind,
    connectionScope: session.connectionScope,
  };
};

const throwMissingAdapter = (name: string): never => {
  throw new Error(`Missing platform adapter implementation: ${name}`);
};

export const reportClientError = async (
  platformAdapter: SyncpeerPlatformAdapter | undefined,
  event: string,
  error: unknown,
  context?: unknown,
): Promise<void> => {
  void error;
  void context;
  console.error(`[syncpeer-core-ui] ${event}`);
  if (!platformAdapter?.logError) return;
  try {
    await platformAdapter.logError(event, { category: "operation-failed" });
  } catch {
    // Ignore logging forwarding failures.
  }
};

export const createSyncpeerBrowserClient = (
  options: CreateSyncpeerBrowserClientOptions,
): SyncpeerBrowserClient => {
  const platformAdapter = options.platformAdapter ?? {};
  const coreAdapter: SyncpeerHostAdapter = {
    ...options.hostAdapter,
    log: (event, details) => {
      if (options.hostAdapter.log) {
        options.hostAdapter.log(event, details);
        return;
      }
      logClient(options.onLog, event, details);
    },
  };
  const coreClient = createSyncpeerCoreClient(coreAdapter);

  let cachedDefaultIdentity: SyncpeerIdentityRecord | null = null;
  let activeConnectOptions: ConnectOptions | null = null;
  let activeResolvedConnectOptions: ConnectOptions | null = null;
  let focusedFolderId: string | null = null;
  let incomingService: Awaited<ReturnType<typeof startIncomingPeerService>> | null = null;
  let incomingServiceKey = "";

  const resolveDefaultIdentity = async (): Promise<SyncpeerIdentityRecord> => {
    if (cachedDefaultIdentity) return cachedDefaultIdentity;
    if (!platformAdapter.readDefaultIdentity) {
      throw new Error("No readDefaultIdentity adapter is configured.");
    }
    cachedDefaultIdentity = await platformAdapter.readDefaultIdentity();
    return cachedDefaultIdentity;
  };

  const stopIncomingService = async (): Promise<void> => {
    const service = incomingService;
    incomingService = null;
    incomingServiceKey = "";
    await service?.close();
  };

  const identityForPairing = async () => {
    const identity = await resolveDefaultIdentity();
    return { ...identity, deviceId: await deviceIdFromCertificate(coreAdapter,
      certificateDerFromPem(identity.certPem)) };
  };

  const pairingEndpoint = (value: string) => {
    let endpoint: URL;
    try { endpoint = new URL(value.includes("://") ? value : `tcp://${value}`); }
    catch { throw new Error("Invalid pairing invitation endpoint."); }
    const port = Number(endpoint.port);
    if (endpoint.protocol !== "tcp:" || !endpoint.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Invalid pairing invitation endpoint.");
    }
    return { host: endpoint.hostname, port };
  };

  const advertisedPairingEndpoint = (value: string, fallbackPort: number) => {
    let endpoint: URL;
    try { endpoint = new URL(value.includes("://") ? value : `tcp://${value}`); }
    catch { throw new Error("Invalid advertised pairing address."); }
    if (endpoint.protocol !== "tcp:" || !endpoint.hostname ||
      (endpoint.pathname !== "" && endpoint.pathname !== "/")) {
      throw new Error("Invalid advertised pairing address.");
    }
    const port = endpoint.port ? Number(endpoint.port) : fallbackPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Invalid advertised pairing address.");
    }
    const host = endpoint.hostname.includes(":") ? `[${endpoint.hostname}]` : endpoint.hostname;
    return `${host}:${port}`;
  };

  const ensureIncomingService = async (connectOptions: ConnectOptions,
    coreOptions: SyncpeerConnectOptions): Promise<typeof incomingService> => {
    if (!coreAdapter.listenTls || !coreOptions.expectedDeviceId) return null;
    const localDeviceId = await deviceIdFromCertificate(coreAdapter,
      certificateDerFromPem(coreOptions.certPem));
    const key = JSON.stringify([localDeviceId, coreOptions.expectedDeviceId,
      coreOptions.certPem, coreOptions.keyPem]);
    if (incomingService && incomingServiceKey === key) return incomingService;
    await stopIncomingService();
    const remoteDeviceId = coreOptions.expectedDeviceId;
    incomingService = await startIncomingPeerService(coreAdapter, {
      host: "0.0.0.0",
      port: 22000,
      certPem: coreOptions.certPem,
      keyPem: coreOptions.keyPem,
      localDeviceId,
      approvedDeviceIds: [remoteDeviceId],
      connectionOptions: (_remote, endpoint) => ({ ...coreOptions, ...endpoint }),
      onSession: (session) => {
        if (preferredPeerDirection(localDeviceId, remoteDeviceId) !== "incoming") return;
        void lifecycle.adopt(connectOptions, session).then(adopted => {
          if (!adopted) return;
          activeResolvedConnectOptions = {
            ...connectOptions,
            host: coreOptions.host,
            port: coreOptions.port,
            cert: coreOptions.certPem,
            key: coreOptions.keyPem,
            remoteId: remoteDeviceId,
          };
          logClient(options.onLog, "client.session.incoming.ready", {
            transportKind: session.transportKind, connectionScope: session.connectionScope,
          });
        });
      },
      onError: error => coreAdapter.log?.("core.incoming.failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    });
    incomingServiceKey = key;
    return incomingService;
  };

  const openSession = async (
    connectOptions: ConnectOptions,
    signal: AbortSignal,
  ): Promise<SyncpeerSessionHandle> => {
    const normalized = normalizeConnectOptions(connectOptions);
    let certPem: string | null = null;
    let keyPem: string | null = null;
    let defaultIdentityError: string | null = null;

    if (normalized.cert) {
      certPem = await resolvePemValue(platformAdapter, "cert", normalized.cert);
    }
    if (normalized.key) {
      keyPem = await resolvePemValue(platformAdapter, "key", normalized.key);
    }

    if (!certPem || !keyPem) {
      try {
        const identity = await resolveDefaultIdentity();
        if (!certPem) certPem = identity.certPem;
        if (!keyPem) keyPem = identity.keyPem;
      } catch (error) {
        defaultIdentityError = error instanceof Error ? error.message : String(error);
      }
    }

    if (!certPem) {
      if (defaultIdentityError) {
        throw new Error(`Missing cert. Provide PEM text or a readable file path. Default identity lookup failed: ${defaultIdentityError}`);
      }
      throw new Error("Missing cert. Provide PEM text or a readable file path.");
    }
    if (!keyPem) {
      if (defaultIdentityError) {
        throw new Error(`Missing key. Provide PEM text or a readable file path. Default identity lookup failed: ${defaultIdentityError}`);
      }
      throw new Error("Missing key. Provide PEM text or a readable file path.");
    }

    const sharedFolders = normalized.sharedFolders ??
      await platformAdapter.sessionSharedFolders?.(normalized.folderPasswords ?? {});
    const coreOptions: SyncpeerConnectOptions = {
      host: normalized.host,
      port: normalized.port,
      discoveryMode: normalized.discoveryMode,
      discoveryServer: normalized.discoveryServer,
      certPem,
      keyPem,
      expectedDeviceId: normalized.remoteId,
      deviceName: normalized.deviceName,
      timeoutMs: normalized.timeoutMs,
      enableRelayFallback: normalized.enableRelayFallback,
      relayOnly: normalized.relayOnly,
      quicOnly: normalized.quicOnly,
      folderPasswords: normalized.folderPasswords,
      sharedFolders,
    };
    let listenerFailure: unknown;
    let service: Awaited<ReturnType<typeof startIncomingPeerService>> | null = null;
    try {
      service = await ensureIncomingService(connectOptions, coreOptions);
    } catch (error) {
      listenerFailure = error;
      coreAdapter.log?.("core.incoming.listen.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    let session: SyncpeerSessionHandle;
    try {
      session = await coreClient.openSession(coreOptions, signal);
    } catch (error) {
      if (listenerFailure) {
        throw new AggregateError([error, listenerFailure],
          "Could not connect to the peer or start the incoming LAN listener on TCP port 22000.",
          { cause: error });
      }
      throw error;
    }
    if (service && normalized.remoteId) {
      const admitted = await service.admitOutgoing(normalized.remoteId, session.connectedVia, session);
      if (!admitted) {
        const selected = service.activeSessions().find(candidate =>
          candidate.remoteDeviceId.replace(/[^A-Z2-7]/gi, "").toUpperCase() ===
          normalized.remoteId!.replace(/[^A-Z2-7]/gi, "").toUpperCase());
        if (!selected) throw new Error("The authenticated peer session was replaced before it became active.");
        session = selected.session;
      }
    }
    activeResolvedConnectOptions = {
      ...normalized,
      cert: certPem,
      key: keyPem,
    };
    logClient(options.onLog, "client.session.open.ready", {
      transportKind: session.transportKind,
      connectionScope: session.connectionScope,
    });
    return session;
  };

  const lifecycle: ConnectionLifecycle<ConnectOptions> = createConnectionLifecycle<ConnectOptions>({
    open: openSession,
    keyFor: (connectOptions) => serializeConnectionKey(
      normalizeConnectOptions(connectOptions),
      connectOptions.cert ?? "default-cert",
      connectOptions.key ?? "default-key",
    ),
  });

  const ensureSession = (connectOptions: ConnectOptions): Promise<SyncpeerSessionHandle> =>
    lifecycle.ensureSession(connectOptions);

  const withSessionOperation = async <TResult>(
    connectOptions: ConnectOptions | null,
    operation: (session: SyncpeerSessionHandle) => Promise<TResult>,
  ): Promise<TResult> => {
    return withMetadataSession(
      connectOptions,
      ensureSession,
      focusedFolderId,
      operation,
    );
  };

  const remoteFsLike = createRecoveringRemoteFs({
    getOptions: () => activeConnectOptions,
    ensureSession,
    getFocusedFolderId: () => focusedFolderId,
    setFocusedFolderId: (folderId) => { focusedFolderId = folderId; },
    getActiveSession: lifecycle.getSession,
  });

  return {
    startPairingInvitation: async pairingOptions => {
      if (!coreAdapter.listenTls) throw new Error("This platform cannot accept LAN pairing connections.");
      if (!platformAdapter.exportPairingTransfer) throw new Error("Personal-space pairing storage is unavailable.");
      const identity = await identityForPairing();
      activeConnectOptions = null;
      activeResolvedConnectOptions = null;
      focusedFolderId = null;
      await lifecycle.disconnect();
      await stopIncomingService();
      const completion = deferred<{ remoteDeviceId: string }>();
      const invitationReady = deferred<Awaited<ReturnType<typeof createPairingInvitation>>>();
      let settled = false;
      incomingService = await startIncomingPeerService(coreAdapter, {
        host: "0.0.0.0", port: pairingOptions.port ?? 22000, certPem: identity.certPem,
        keyPem: identity.keyPem, localDeviceId: identity.deviceId, approvedDeviceIds: [],
        connectionOptions: () => { throw new Error("A pairing invitation does not approve BEP access."); },
        onSession: session => { void session.close(); },
        onPairingSocket: async (accepted, remoteDeviceId) => {
          if (settled) throw new Error("Pairing invitation is unavailable or already used.");
          try {
            const invitationRecord = await invitationReady.promise;
            const result = await acceptPairingTransfer({ subtle: crypto.subtle, socket: accepted.socket,
              invitation: invitationRecord, verifiedRemoteId: remoteDeviceId,
              transfer: await platformAdapter.exportPairingTransfer!(), randomBytes: coreAdapter.randomBytes,
              confirm: pairingOptions.confirm });
            settled = true; completion.resolve({ remoteDeviceId: result.remoteDeviceId });
            setTimeout(() => { void stopIncomingService(); }, 0);
          } catch (error) {
            settled = true; completion.reject(error); throw error;
          }
        },
      });
      incomingServiceKey = "pairing";
      const advertisedEndpoint = advertisedPairingEndpoint(pairingOptions.advertisedHost,
        incomingService.port);
      const invitationRecord = await createPairingInvitation(crypto.subtle, coreAdapter.randomBytes,
        identity.deviceId, advertisedEndpoint,
        Date.now() + (pairingOptions.expiresInMs ?? 5 * 60_000));
      invitationReady.resolve(invitationRecord);
      const timer = setTimeout(() => {
        if (!settled) { settled = true; completion.reject(new Error("Pairing invitation expired.")); }
        void stopIncomingService();
      }, Math.max(0, invitationRecord.invitation.expiresAt - Date.now()));
      void completion.promise.finally(() => clearTimeout(timer)).catch(() => undefined);
      return { invitation: invitationRecord.invitation, completed: completion.promise,
        cancel: async () => {
          if (!settled) { settled = true; completion.reject(new Error("Pairing invitation cancelled.")); }
          await stopIncomingService();
        } };
    },
    joinPairingInvitation: async pairingOptions => {
      if (!platformAdapter.importPairingTransfer) throw new Error("Personal-space pairing storage is unavailable.");
      const identity = await identityForPairing();
      const endpoint = pairingEndpoint(pairingOptions.invitation.endpoint);
      const socket = await coreAdapter.connectTls({ ...endpoint, certPem: identity.certPem,
        keyPem: identity.keyPem, alpnProtocols: ["syncpeer-pairing/1"] });
      try {
        const verifiedRemoteId = await deviceIdFromCertificate(coreAdapter, await socket.peerCertificateDer());
        const joined = await joinPersonalSpace({ subtle: crypto.subtle, socket,
          invitation: pairingOptions.invitation, localDeviceId: identity.deviceId,
          verifiedRemoteId, randomBytes: coreAdapter.randomBytes, confirm: pairingOptions.confirm });
        await platformAdapter.importPairingTransfer(joined.transfer, pairingOptions.password,
          pairingOptions.remember);
        return { remoteDeviceId: verifiedRemoteId };
      } finally { await socket.close().catch(() => undefined); }
    },
    connectAndSync: async (connectOptions: ConnectOptions): Promise<RemoteFsLike> => {
      await lifecycle.connect(connectOptions);
      activeConnectOptions = connectOptions;
      return remoteFsLike;
    },
    connectAndGetOverview: async (
      connectOptions: ConnectOptions,
    ): Promise<ConnectionOverview> => {
      const overview = await withSessionOperation(
        connectOptions,
        (session) => toConnectionOverview(session),
      );
      activeConnectOptions = connectOptions;
      return overview;
    },
    connectAndGetFolderVersions: async (
      connectOptions: ConnectOptions,
    ): Promise<FolderSyncState[]> => {
      const states = await withSessionOperation(
        connectOptions,
        (session) => Promise.resolve(session.remoteFs.listFolderSyncStates?.() ?? []),
      );
      activeConnectOptions = connectOptions;
      return states;
    },
    discoverLocalDevices: async (discoverOptions?: { timeoutMs?: number }) => {
      if (!coreAdapter.discoverLocalCandidates) return [];
      const candidates = await coreAdapter.discoverLocalCandidates({
        expectedDeviceId: "",
        timeoutMs: discoverOptions?.timeoutMs,
      });
      const devices = new Map<string, Set<string>>();
      const anonymousAddresses = new Set<string>();
      for (const candidate of candidates) {
        const normalizedId = (candidate.deviceId ?? "")
          .replace(/[^A-Z2-7]/gi, "")
          .toUpperCase();
        const normalizedAddress = candidate.address.trim();
        if (!normalizedId) {
          if (normalizedAddress) anonymousAddresses.add(normalizedAddress);
          continue;
        }
        if (!devices.has(normalizedId)) {
          devices.set(normalizedId, new Set<string>());
        }
        if (normalizedAddress) {
          devices.get(normalizedId)?.add(normalizedAddress);
        }
      }
      const known = [...devices.entries()]
        .map(([deviceId, addresses]) => ({
          deviceId,
          addresses: [...addresses].sort(),
          anonymous: false,
        }))
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
      const anonymous = [...anonymousAddresses]
        .sort()
        .map((address, index) => ({
          deviceId: `LAN-UNKNOWN-${index + 1}`,
          addresses: [address],
          anonymous: true,
        }));
      return [...known, ...anonymous];
    },
    disconnect: async (): Promise<void> => {
      activeConnectOptions = null;
      activeResolvedConnectOptions = null;
      focusedFolderId = null;
      await platformAdapter.stopBackgroundSession?.();
      await lifecycle.disconnect();
      await stopIncomingService();
    },
    subscribeLifecycle: lifecycle.subscribe,
    setOnline: lifecycle.setOnline,
    setForeground: async (foreground) => {
      if (foreground) {
        // Stop the service before reopening the Activity-owned session.  The
        // stop call waits for the service's core session to close, so two
        // authenticated sessions never own the same peer at once.
        await platformAdapter.stopBackgroundSession?.();
        await lifecycle.setForeground(true);
        return;
      }

      // Release the Activity-owned session before handing the options to the
      // service.  Starting the service first would create a race in which both
      // runtimes connect to the peer briefly.
      await lifecycle.setForeground(false);
      await stopIncomingService();
      if (activeResolvedConnectOptions && platformAdapter.startBackgroundSession) {
        const backgroundOptions = Object.fromEntries(
          Object.entries(activeResolvedConnectOptions).filter(([key]) => key !== "sharedFolders"),
        ) as Omit<ConnectOptions, "sharedFolders">;
        await platformAdapter.startBackgroundSession(backgroundOptions);
      }
    },
    setTransferActive: lifecycle.setTransferActive,
    acknowledgeCachedSync: platformAdapter.acknowledgeCachedSync,
    listFavorites: async (): Promise<FavoriteRecord[]> =>
      platformAdapter.listFavorites
        ? platformAdapter.listFavorites()
        : throwMissingAdapter("listFavorites"),
    upsertFavorite: async (favorite: FavoriteRecord): Promise<FavoriteRecord[]> =>
      platformAdapter.upsertFavorite
        ? platformAdapter.upsertFavorite(favorite)
        : throwMissingAdapter("upsertFavorite"),
    removeFavorite: async (key: string): Promise<FavoriteRecord[]> =>
      platformAdapter.removeFavorite
        ? platformAdapter.removeFavorite(key)
        : throwMissingAdapter("removeFavorite"),
    loadProfileSettings: async () => platformAdapter.loadProfileSettings
      ? platformAdapter.loadProfileSettings()
      : throwMissingAdapter("loadProfileSettings"),
    saveProfileSettings: async settings => platformAdapter.saveProfileSettings
      ? platformAdapter.saveProfileSettings(settings)
      : throwMissingAdapter("saveProfileSettings"),
    loadDirectorySnapshot: async (folderId, sourceDeviceId, path) => platformAdapter.loadDirectorySnapshot
      ? platformAdapter.loadDirectorySnapshot(folderId, sourceDeviceId, path)
      : null,
    saveDirectorySnapshot: async (folderId, sourceDeviceId, path, snapshot) => {
      await platformAdapter.saveDirectorySnapshot?.(folderId, sourceDeviceId, path, snapshot);
    },
    enforceCacheQuota: async () => platformAdapter.enforceCacheQuota
      ? platformAdapter.enforceCacheQuota()
      : ({ quotaBytes: 0, cachedBytes: 0, protectedBytes: 0, evicted: [] }),
    listDocumentVersions: async (folderId, path) => platformAdapter.listDocumentVersions
      ? platformAdapter.listDocumentVersions(folderId, path)
      : throwMissingAdapter("listDocumentVersions"),
    restoreDocumentVersion: async (folderId, path, versionId) => platformAdapter.restoreDocumentVersion
      ? platformAdapter.restoreDocumentVersion(folderId, path, versionId)
      : throwMissingAdapter("restoreDocumentVersion"),
    listFavoriteSyncStates: async folderIds => platformAdapter.listFavoriteSyncStates
      ? platformAdapter.listFavoriteSyncStates(folderIds)
      : [],
    retryFavoriteSync: async (folderId, path) => platformAdapter.retryFavoriteSync
      ? platformAdapter.retryFavoriteSync(folderId, path)
      : throwMissingAdapter("retryFavoriteSync"),
    resolveFavoriteConflict: async (folderId, path, resolution) => platformAdapter.resolveFavoriteConflict
      ? platformAdapter.resolveFavoriteConflict(folderId, path, resolution)
      : throwMissingAdapter("resolveFavoriteConflict"),
    cacheFile: async (
      folderId: string,
      path: string,
      name: string,
      bytes: Uint8Array,
      modifiedMs?: number,
    ): Promise<void> => {
      if (!platformAdapter.cacheFile) return throwMissingAdapter("cacheFile");
      return platformAdapter.cacheFile(folderId, path, name, bytes, modifiedMs);
    },
    createFileDownloadSink: platformAdapter.createFileDownloadSink
      ? (args) => platformAdapter.createFileDownloadSink!(args)
      : undefined,
    startTransfer: async (label) => {
      await lifecycle.setTransferActive(true);
      try {
        await platformAdapter.startTransfer?.(label);
      } catch (error) {
        await lifecycle.setTransferActive(false);
        throw error;
      }
    },
    stopTransfer: async () => {
      try {
        await platformAdapter.stopTransfer?.();
      } finally {
        await lifecycle.setTransferActive(false);
      }
    },
    updateTransferNotification: platformAdapter.updateTransferNotification
      ? (args) => platformAdapter.updateTransferNotification!(args)
      : undefined,
    getCachedStatuses: async (folderId: string, paths: string[]): Promise<CachedFileStatus[]> =>
      platformAdapter.getCachedStatuses
        ? platformAdapter.getCachedStatuses(folderId, paths)
        : throwMissingAdapter("getCachedStatuses"),
    digestCachedFiles: platformAdapter.digestCachedFiles
      ? (files) => platformAdapter.digestCachedFiles!(files)
      : undefined,
    listLocalDirectory: async (folderId, path) => platformAdapter.listLocalDirectory?.(folderId, path) ?? null,
    listCachedFiles: async (): Promise<CachedFileRecord[]> =>
      platformAdapter.listCachedFiles
        ? platformAdapter.listCachedFiles()
        : throwMissingAdapter("listCachedFiles"),
    openCachedFile: async (folderId: string, path: string): Promise<void> =>
      platformAdapter.openCachedFile
        ? platformAdapter.openCachedFile(folderId, path)
        : throwMissingAdapter("openCachedFile"),
    openCachedFileDirectory: async (folderId: string, path: string): Promise<void> =>
      platformAdapter.openCachedFileDirectory
        ? platformAdapter.openCachedFileDirectory(folderId, path)
        : throwMissingAdapter("openCachedFileDirectory"),
    openCachedDirectory: async (folderId: string, path: string): Promise<void> =>
      platformAdapter.openCachedDirectory
        ? platformAdapter.openCachedDirectory(folderId, path)
        : throwMissingAdapter("openCachedDirectory"),
    removeCachedFile: async (folderId: string, path: string): Promise<boolean> =>
      platformAdapter.removeCachedFile
        ? platformAdapter.removeCachedFile(folderId, path)
        : throwMissingAdapter("removeCachedFile"),
    clearCache: async (): Promise<void> =>
      platformAdapter.clearCache
        ? platformAdapter.clearCache()
        : throwMissingAdapter("clearCache"),
    getAndroidSafTreeUri: async (): Promise<string | null> =>
      platformAdapter.getAndroidSafTreeUri
        ? platformAdapter.getAndroidSafTreeUri()
        : throwMissingAdapter("getAndroidSafTreeUri"),
    pickAndroidSafDirectory: async (): Promise<string> =>
      platformAdapter.pickAndroidSafDirectory
        ? platformAdapter.pickAndroidSafDirectory()
        : throwMissingAdapter("pickAndroidSafDirectory"),
    setAndroidSafTreeUri: async (treeUri?: string | null): Promise<string | null> =>
      platformAdapter.setAndroidSafTreeUri
        ? platformAdapter.setAndroidSafTreeUri(treeUri)
        : throwMissingAdapter("setAndroidSafTreeUri"),
    listAndroidPersistedSafUris: async (): Promise<string[]> =>
      platformAdapter.listAndroidPersistedSafUris
        ? platformAdapter.listAndroidPersistedSafUris()
        : throwMissingAdapter("listAndroidPersistedSafUris"),
    listAndroidContacts: async (): Promise<AndroidContactRecord[]> =>
      platformAdapter.listAndroidContacts
        ? platformAdapter.listAndroidContacts()
        : throwMissingAdapter("listAndroidContacts"),
    upsertAndroidContact: async (input): Promise<{ contactId: string }> =>
      platformAdapter.upsertAndroidContact
        ? platformAdapter.upsertAndroidContact(input)
        : throwMissingAdapter("upsertAndroidContact"),
    deleteAndroidContact: async (contactId: string): Promise<{ deleted: boolean }> =>
      platformAdapter.deleteAndroidContact
        ? platformAdapter.deleteAndroidContact(contactId)
        : throwMissingAdapter("deleteAndroidContact"),
    listAndroidCalendarEvents: async (args): Promise<AndroidCalendarEventRecord[]> =>
      platformAdapter.listAndroidCalendarEvents
        ? platformAdapter.listAndroidCalendarEvents(args)
        : throwMissingAdapter("listAndroidCalendarEvents"),
    upsertAndroidCalendarEvent: async (input): Promise<{ eventId: string }> =>
      platformAdapter.upsertAndroidCalendarEvent
        ? platformAdapter.upsertAndroidCalendarEvent(input)
        : throwMissingAdapter("upsertAndroidCalendarEvent"),
    deleteAndroidCalendarEvent: async (eventId: string): Promise<{ deleted: boolean }> =>
      platformAdapter.deleteAndroidCalendarEvent
        ? platformAdapter.deleteAndroidCalendarEvent(eventId)
        : throwMissingAdapter("deleteAndroidCalendarEvent"),
    exportIdentityRecovery: async (): Promise<IdentityRecoveryExportResponse> =>
      platformAdapter.exportIdentityRecovery
        ? platformAdapter.exportIdentityRecovery()
        : throwMissingAdapter("exportIdentityRecovery"),
    restoreIdentityRecovery: async (recoverySecret: string): Promise<void> => {
      if (!platformAdapter.restoreIdentityRecovery) {
        return throwMissingAdapter("restoreIdentityRecovery");
      }
      await platformAdapter.restoreIdentityRecovery(recoverySecret);
      cachedDefaultIdentity = null;
    },
    getDefaultDeviceId: async (): Promise<string> =>
      platformAdapter.getDefaultDeviceId
        ? platformAdapter.getDefaultDeviceId()
        : throwMissingAdapter("getDefaultDeviceId"),
    regenerateDefaultIdentity: async (): Promise<string> => {
      if (!platformAdapter.regenerateDefaultIdentity) {
        return throwMissingAdapter("regenerateDefaultIdentity");
      }
      const deviceId = await platformAdapter.regenerateDefaultIdentity();
      cachedDefaultIdentity = null;
      return deviceId;
    },
    readBinaryFile: async (path: string): Promise<Uint8Array> =>
      platformAdapter.readBinaryFile
        ? platformAdapter.readBinaryFile(path)
        : throwMissingAdapter("readBinaryFile"),
    readCachedFile: platformAdapter.readCachedFile
      ? (folderId, path) => platformAdapter.readCachedFile!(folderId, path)
      : undefined,
    pickUploadFile: async (): Promise<string | null | undefined> =>
      platformAdapter.pickUploadFile
        ? platformAdapter.pickUploadFile()
        : undefined,
  };
};
