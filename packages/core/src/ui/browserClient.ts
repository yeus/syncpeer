import { certificateDerFromPem, createSyncpeerCoreClient, deviceIdFromCertificate, connectRelayWithRetry,
  type SyncpeerConnectOptions, type SyncpeerHostAdapter, type SyncpeerSessionHandle,
  type SyncpeerTlsSocket,
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
import { resolveApprovedPeerDeviceIds, resolveIncomingPeerDeviceIds,
  type OwnedDeviceIdentity, type OwnedSpaceDevice } from "../sync/personalSpaceSharing.js";
import { sameDeviceId } from "./helpers.js";

import { automaticRelayConfiguration } from "../sync/automaticRelayPresence.js";

export interface ConnectOptions {
  host: string;
  port: number;
  /** Local port advertised by the incoming mutual-TLS listener. */
  listenPort?: number;
  discoveryMode?: "automatic" | "global" | "lan" | "direct";
  discoveryServer?: string;
  relayPoolUrl?: string;
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

/** State of the always-on incoming TLS listener. */
export interface BackgroundListenerStatus {
  active: boolean;
  port: number | null;
  /** True when the configured port was busy and an OS-assigned port is in use. */
  ephemeral: boolean;
  error: string | null;
}

/** Emitted when an approved peer opens an incoming session while idle. */
export interface IncomingSessionEvent {
  remoteDeviceId: string;
  options: ConnectOptions;
  session: SyncpeerSessionHandle;
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
  syncBaseline?: { hash: string; sizeBytes: number; modifiedMs: number; versionKey?: string };
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
  releaseLocalCopy?: (folderId: string, mode: "safe" | "dangerous", confirmedText: string,
    sessions: readonly Pick<SyncpeerSessionHandle, "remoteDeviceId" | "remoteFs" | "isClosed">[]) => Promise<void>;
  prepareBackgroundSession?: (options: Omit<ConnectOptions, "sharedFolders">) => Promise<void>;
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
  exportPairingTransfer?: (localDeviceId: string, joiningDevice: OwnedSpaceDevice) => Promise<PersonalSpacePairingTransfer>;
  importPairingTransfer?: (transfer: PersonalSpacePairingTransfer, identity: OwnedDeviceIdentity,
    password: string, remember: boolean) => Promise<void>;
  ownedDevices?: () => Promise<OwnedSpaceDevice[]>;
  revokeOwnedDevice?: (deviceId: string) => Promise<void>;
  /** Folders currently owned by the encrypted document store and safe to advertise over BEP. */
  sessionSharedFolders?: (remoteDeviceId: string) => Promise<SharedFolder[]>;
  /** A separate runtime owns incoming sync sessions; this UI may only dial peers. */
  incomingSessionOwnedByService?: boolean;
  /** Synchronous invalidation guards prepared listener state against vault and sharing changes. */
  sessionConfigurationRevision?: () => number;
  onSessionConfigurationChange?: (listener: () => void) => void;
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
  /** An approved peer connected while no connect attempt was active. */
  onIncomingSession?: (event: IncomingSessionEvent) => void;
}

export interface SyncpeerBrowserClient {
  releaseLocalCopy: (folderId: string, mode: "safe" | "dangerous", confirmedText?: string) => Promise<void>;
  acknowledgeCachedSync?: SyncpeerPlatformAdapter["acknowledgeCachedSync"];
  connectAndSync: (options: ConnectOptions) => Promise<RemoteFsLike>;
  connectAndGetOverview: (options: ConnectOptions) => Promise<ConnectionOverview>;
  connectAndGetFolderVersions: (options: ConnectOptions) => Promise<FolderSyncState[]>;
  discoverLocalDevices: (options?: { timeoutMs?: number }) => Promise<LocalDiscoveredDevice[]>;
  /**
   * Keep the incoming TLS listener open independently of any connect attempt,
   * so approved peers can dial this device while it is idle.
   */
  startBackgroundListener: (options?: { listenPort?: number }) => Promise<BackgroundListenerStatus>;
  stopBackgroundListener: () => Promise<void>;
  backgroundListenerStatus: () => BackgroundListenerStatus;
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const deferred = <T,>(): Deferred<T> => {
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

const sharedFolderCounts = (folders: readonly SharedFolder[]) => ({
  count: folders.length,
  internalCount: folders.filter(folder => folder.internal === true).length,
});

const localListenPort = (value?: number) => {
  const port = value ?? 22000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Incoming TCP port must be between 1 and 65535.");
  }
  return port;
};

const normalizeConnectOptions = (options: ConnectOptions): ConnectOptions => ({
  host: options.host,
  port: options.port,
  listenPort: localListenPort(options.listenPort),
  discoveryMode: options.discoveryMode ?? "automatic",
  discoveryServer: normalizeDiscoveryServer(options.discoveryServer),
  relayPoolUrl: options.relayPoolUrl,
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
  sessionConfigurationRevision = 0,
): string =>
  JSON.stringify({
    host: options.host,
    port: options.port,
    listenPort: options.listenPort ?? 22000,
    discoveryMode: options.discoveryMode ?? "automatic",
    discoveryServer: normalizeDiscoveryServer(options.discoveryServer),
    relayPoolUrl: options.relayPoolUrl,
    enableRelayFallback: options.enableRelayFallback !== false,
    remoteId: options.remoteId ?? "",
    deviceName: options.deviceName,
    certPem,
    keyPem,
    relayOnly: options.relayOnly === true,
    quicOnly: options.quicOnly === true,
    folderPasswords: options.folderPasswords ?? {},
    sharedFolders: options.sharedFolders ?? [],
    // The shared-folder set and credentials are resolved from the document
    // owner at session-open time. Incrementing this revision when the owner
    // changes (folder attach, favorite, credential) makes the live session
    // stale so it reopens with the current selection instead of silently
    // dropping a peer index for a folder it opened without.
    sessionConfigurationRevision,
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

type BrowserClientState = {
  cachedDefaultIdentity: SyncpeerIdentityRecord | null;
  activeConnectOptions: ConnectOptions | null;
  activeResolvedConnectOptions: ConnectOptions | null;
  focusedFolderId: string | null;
  incomingService: IncomingService | null;
  incomingServiceKey: string;
  incomingServiceClosing: Promise<void>;
  incomingServiceUpdate: Promise<unknown>;
  incomingServicePort: number | null;
  incomingListenerEphemeral: boolean;
  incomingListenerError: string | null;
  backgroundListenerActive: boolean;
  backgroundListenerListenPort: number;
  /** Only a service session this client started has to be stopped again. */
  backgroundSessionStarted: boolean;
  sessionConfigurationRefresh: Promise<void>;
};

type IncomingService = Awaited<ReturnType<typeof startIncomingPeerService>>;

type BrowserClientBase = {
  options: CreateSyncpeerBrowserClientOptions;
  platformAdapter: SyncpeerPlatformAdapter;
  coreAdapter: SyncpeerHostAdapter;
  coreClient: ReturnType<typeof createSyncpeerCoreClient>;
  state: BrowserClientState;
};

type IncomingContext = BrowserClientBase & {
  resolveDefaultIdentity: () => Promise<SyncpeerIdentityRecord>;
  getLifecycle: () => ConnectionLifecycle<ConnectOptions>;
};

type IncomingRuntime = {
  ensureIncomingService: (
    connectOptions: ConnectOptions,
    coreOptions: SyncpeerConnectOptions,
    background?: boolean,
  ) => Promise<IncomingService | null>;
  stopIncomingService: () => Promise<void>;
  startBackgroundListener: (options?: { listenPort?: number }) => Promise<BackgroundListenerStatus>;
  stopBackgroundListener: () => Promise<void>;
  backgroundListenerStatus: () => BackgroundListenerStatus;
  api: Pick<SyncpeerBrowserClient,
    "startBackgroundListener" | "stopBackgroundListener" | "backgroundListenerStatus">;
};

type SessionContext = BrowserClientBase & {
  resolveDefaultIdentity: () => Promise<SyncpeerIdentityRecord>;
  incoming: IncomingRuntime;
};

type SessionRuntime = {
  lifecycle: ConnectionLifecycle<ConnectOptions>;
  api: Pick<SyncpeerBrowserClient,
    | "connectAndSync"
    | "connectAndGetOverview"
    | "connectAndGetFolderVersions"
    | "disconnect"
    | "releaseLocalCopy"
    | "setForeground"
    | "subscribeLifecycle"
    | "setOnline"
    | "setTransferActive"
    | "acknowledgeCachedSync">;
};

type PairingContext = BrowserClientBase & {
  identityForPairing: () => Promise<SyncpeerIdentityRecord & { deviceId: string }>;
  lifecycle: ConnectionLifecycle<ConnectOptions>;
  incoming: IncomingRuntime;
};

type InvitationRecord = Awaited<ReturnType<typeof createPairingInvitation>>;
type PairingInvitationOptions = Parameters<SyncpeerBrowserClient["startPairingInvitation"]>[0];
type PairingJoinOptions = Parameters<SyncpeerBrowserClient["joinPairingInvitation"]>[0];
type PairingSocketHandler = NonNullable<
  Parameters<typeof startIncomingPeerService>[1]["onPairingSocket"]
>;

type PairingSession = {
  settled: boolean;
  completion: Deferred<{ remoteDeviceId: string }>;
  invitationReady: Deferred<InvitationRecord>;
  timer?: ReturnType<typeof setTimeout>;
};

const backgroundSessionOptions = (connectOptions: ConnectOptions | null) => connectOptions
  ? Object.fromEntries(Object.entries(connectOptions).filter(([key]) => key !== "sharedFolders")) as Omit<ConnectOptions, "sharedFolders">
  : null;

async function prepareBackgroundHandoff(
  platformAdapter: SyncpeerPlatformAdapter,
  connectOptions: ConnectOptions | null,
) {
  const backgroundOptions = backgroundSessionOptions(connectOptions);
  if (backgroundOptions && platformAdapter.prepareBackgroundSession) {
    await platformAdapter.prepareBackgroundSession(backgroundOptions);
  }
}

function tcpEndpoint(value: string, errorMessage: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value.includes("://") ? value : `tcp://${value}`);
  } catch {
    throw new Error(errorMessage);
  }
  const port = Number(endpoint.port);
  if (
    endpoint.protocol !== "tcp:" || !endpoint.hostname ||
    !Number.isInteger(port) || port < 1 || port > 65535
  ) {
    throw new Error(errorMessage);
  }
  return { host: endpoint.hostname, port };
}

const pairingEndpoint = (value: string) =>
  tcpEndpoint(value, "Invalid pairing invitation endpoint.");

function advertisedPairingEndpoint(value: string, fallbackPort: number) {
  let endpoint: URL;
  try {
    endpoint = new URL(value.includes("://") ? value : `tcp://${value}`);
  } catch {
    throw new Error("Invalid advertised pairing address.");
  }
  if (
    endpoint.protocol !== "tcp:" || !endpoint.hostname ||
    (endpoint.pathname !== "" && endpoint.pathname !== "/")
  ) {
    throw new Error("Invalid advertised pairing address.");
  }
  const port = endpoint.port ? Number(endpoint.port) : fallbackPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid advertised pairing address.");
  }
  const host = endpoint.hostname.includes(":") ? `[${endpoint.hostname}]` : endpoint.hostname;
  return `${host}:${port}`;
}

function relayPairingEndpoint(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Invalid advertised relay pairing address.");
  }
  if (
    endpoint.protocol !== "relay:" || !endpoint.hostname || endpoint.username || endpoint.password ||
    endpoint.hash || (endpoint.pathname !== "" && endpoint.pathname !== "/")
  ) {
    throw new Error("Invalid advertised relay pairing address.");
  }
  return endpoint.toString();
}

type LocalCandidate = Awaited<
  ReturnType<NonNullable<SyncpeerHostAdapter["discoverLocalCandidates"]>>
>[number];

function collectDiscoveredDevices(candidates: readonly LocalCandidate[]): LocalDiscoveredDevice[] {
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
    if (!devices.has(normalizedId)) devices.set(normalizedId, new Set<string>());
    if (normalizedAddress) devices.get(normalizedId)?.add(normalizedAddress);
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
}

function createBrowserClientState(): BrowserClientState {
  return {
    cachedDefaultIdentity: null,
    activeConnectOptions: null,
    activeResolvedConnectOptions: null,
    focusedFolderId: null,
    incomingService: null,
    incomingServiceKey: "",
    incomingServiceClosing: Promise.resolve(),
    incomingServiceUpdate: Promise.resolve(),
    incomingServicePort: null,
    incomingListenerEphemeral: false,
    incomingListenerError: null,
    backgroundListenerActive: false,
    backgroundListenerListenPort: 22000,
    backgroundSessionStarted: false,
    sessionConfigurationRefresh: Promise.resolve(),
  };
}

function createBrowserClientBase(options: CreateSyncpeerBrowserClientOptions): BrowserClientBase {
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
  return {
    options,
    platformAdapter,
    coreAdapter,
    coreClient: createSyncpeerCoreClient(coreAdapter),
    state: createBrowserClientState(),
  };
}

function createIdentityRecoveryApi(
  platformAdapter: SyncpeerPlatformAdapter,
  clearDefaultIdentity: () => void,
) {
  return {
    exportIdentityRecovery: async () => platformAdapter.exportIdentityRecovery
      ? platformAdapter.exportIdentityRecovery()
      : throwMissingAdapter("exportIdentityRecovery"),
    restoreIdentityRecovery: async (recoverySecret: string) => {
      if (!platformAdapter.restoreIdentityRecovery)
        return throwMissingAdapter("restoreIdentityRecovery");
      await platformAdapter.restoreIdentityRecovery(recoverySecret);
      clearDefaultIdentity();
    },
    getDefaultDeviceId: async () => platformAdapter.getDefaultDeviceId
      ? platformAdapter.getDefaultDeviceId()
      : throwMissingAdapter("getDefaultDeviceId"),
    regenerateDefaultIdentity: async () => {
      if (!platformAdapter.regenerateDefaultIdentity)
        return throwMissingAdapter("regenerateDefaultIdentity");
      const deviceId = await platformAdapter.regenerateDefaultIdentity();
      clearDefaultIdentity();
      return deviceId;
    },
  };
}

function createIdentityFileApi(platformAdapter: SyncpeerPlatformAdapter) {
  return {
    readBinaryFile: async (path: string) => platformAdapter.readBinaryFile
      ? platformAdapter.readBinaryFile(path)
      : throwMissingAdapter("readBinaryFile"),
    readCachedFile: platformAdapter.readCachedFile
      ? (folderId: string, path: string) => platformAdapter.readCachedFile!(folderId, path)
      : undefined,
    pickUploadFile: async () => platformAdapter.pickUploadFile
      ? platformAdapter.pickUploadFile()
      : undefined,
  };
}

function createIdentityApi(
  platformAdapter: SyncpeerPlatformAdapter,
  clearDefaultIdentity: () => void,
) {
  return {
    ...createIdentityRecoveryApi(platformAdapter, clearDefaultIdentity),
    ...createIdentityFileApi(platformAdapter),
  };
}

function createIdentityController({ platformAdapter, coreAdapter, state }: BrowserClientBase) {
  const resolveDefaultIdentity = async (): Promise<SyncpeerIdentityRecord> => {
    if (state.cachedDefaultIdentity) return state.cachedDefaultIdentity;
    if (!platformAdapter.readDefaultIdentity)
      throw new Error("No readDefaultIdentity adapter is configured.");
    state.cachedDefaultIdentity = await platformAdapter.readDefaultIdentity();
    return state.cachedDefaultIdentity;
  };
  const identityForPairing = async () => {
    const identity = await resolveDefaultIdentity();
    return {
      ...identity,
      deviceId: await deviceIdFromCertificate(
        coreAdapter,
        certificateDerFromPem(identity.certPem),
      ),
    };
  };
  const clearDefaultIdentity = () => {
    state.cachedDefaultIdentity = null;
  };
  return {
    resolveDefaultIdentity,
    identityForPairing,
    api: createIdentityApi(platformAdapter, clearDefaultIdentity),
  };
}

function stopIncomingService(state: BrowserClientState): Promise<void> {
  const service = state.incomingService;
  state.incomingService = null;
  state.incomingServiceKey = "";
  state.incomingServicePort = null;
  state.incomingListenerEphemeral = false;
  const closing = state.incomingServiceClosing.then(async () => service?.close());
  state.incomingServiceClosing = closing.catch(() => undefined);
  return closing;
}

function backgroundListenerStatus(state: BrowserClientState): BackgroundListenerStatus {
  return {
    active: state.backgroundListenerActive && state.incomingService !== null,
    port: state.incomingServicePort,
    ephemeral: state.incomingListenerEphemeral,
    error: state.incomingListenerError,
  };
}

const backgroundListenerConnectOptions = (port: number): ConnectOptions => ({
  host: "",
  port: 0,
  listenPort: port,
  deviceName: "",
  discoveryMode: "automatic",
  enableRelayFallback: false,
});

const backgroundListenerCoreOptions = (
  identity: SyncpeerIdentityRecord,
): SyncpeerConnectOptions => ({
  host: "",
  port: 0,
  certPem: identity.certPem,
  keyPem: identity.keyPem,
  expectedDeviceId: "",
  deviceName: "",
  sharedFolders: [],
});

async function startBackgroundListenerImpl(
  ctx: IncomingContext,
  listenerOptions?: { listenPort?: number },
): Promise<BackgroundListenerStatus> {
  if (ctx.platformAdapter.incomingSessionOwnedByService || !ctx.coreAdapter.listenTls) {
    ctx.state.backgroundListenerActive = true;
    return backgroundListenerStatus(ctx.state);
  }
  const identity = await ctx.resolveDefaultIdentity();
  ctx.state.backgroundListenerListenPort = localListenPort(
    listenerOptions?.listenPort ?? ctx.state.backgroundListenerListenPort,
  );
  ctx.state.backgroundListenerActive = true;
  try {
    await ensureIncomingServiceImpl(
      ctx,
      backgroundListenerConnectOptions(ctx.state.backgroundListenerListenPort),
      backgroundListenerCoreOptions(identity),
      true,
    );
  } catch (error) {
    ctx.state.backgroundListenerActive = false;
    ctx.state.incomingListenerError = error instanceof Error ? error.message : String(error);
    throw error;
  }
  return backgroundListenerStatus(ctx.state);
}

async function stopBackgroundListenerImpl(ctx: IncomingContext): Promise<void> {
  ctx.state.backgroundListenerActive = false;
  if (!ctx.state.activeConnectOptions) await stopIncomingService(ctx.state);
}

async function selectIncomingDevices(
  ctx: IncomingContext,
  coreOptions: SyncpeerConnectOptions,
  background: boolean,
) {
  const expectedDeviceId = coreOptions.expectedDeviceId ?? "";
  if (!background && !expectedDeviceId) return null;
  ctx.coreAdapter.log?.("core.incoming.prepare.identity_start", {});
  const localDeviceId = await deviceIdFromCertificate(
    ctx.coreAdapter,
    certificateDerFromPem(coreOptions.certPem),
  );
  ctx.coreAdapter.log?.("core.incoming.prepare.trust_start", {});
  const trustedDevices = (await ctx.platformAdapter.ownedDevices?.().catch(() => [])) ?? [];
  ctx.coreAdapter.log?.("core.incoming.prepare.trust_done", {
    deviceCount: trustedDevices.length,
  });
  const approvedDeviceIds = background && !expectedDeviceId
    ? trustedDevices
        .filter((device) => device.state === "active")
        .map((device) => device.syncthingId)
        .filter((id) => id && !sameDeviceId(id, localDeviceId))
    : resolveIncomingPeerDeviceIds(expectedDeviceId, localDeviceId, trustedDevices);
  return { expectedDeviceId, localDeviceId, approvedDeviceIds };
}

async function prepareIncomingOptions(
  ctx: IncomingContext,
  connectOptions: ConnectOptions,
  coreOptions: SyncpeerConnectOptions,
  devices: { expectedDeviceId: string; localDeviceId: string; approvedDeviceIds: string[] },
) {
  const listenPort = localListenPort(connectOptions.listenPort);
  const automaticRelay = automaticRelayConfiguration(connectOptions);
  const key = JSON.stringify([
    devices.localDeviceId,
    devices.approvedDeviceIds,
    coreOptions.certPem,
    coreOptions.keyPem,
    listenPort,
    automaticRelay,
  ]);
  const revision = ctx.platformAdapter.sessionConfigurationRevision?.();
  const prepared = new Map<string, SyncpeerConnectOptions>();
  for (const remote of devices.approvedDeviceIds) {
    try {
      const folders = sameDeviceId(remote, devices.expectedDeviceId) && coreOptions.sharedFolders
        ? coreOptions.sharedFolders
        : (await ctx.platformAdapter.sessionSharedFolders?.(remote)) ?? [];
      logClient(ctx.options.onLog, "client.shared_folders.selected", sharedFolderCounts(folders));
      prepared.set(remote.replace(/[^A-Z2-7]/gi, "").toUpperCase(), {
        ...coreOptions,
        expectedDeviceId: remote,
        sharedFolders: folders,
        folderPasswords: sameDeviceId(remote, devices.expectedDeviceId)
          ? coreOptions.folderPasswords
          : {},
      });
    } catch (error) {
      ctx.coreAdapter.log?.("core.incoming.prepare.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { listenPort, automaticRelay, key, revision, prepared };
}

function incomingConnectionOptions(
  prepared: Map<string, SyncpeerConnectOptions>,
  revision: number | undefined,
  platformAdapter: SyncpeerPlatformAdapter,
) {
  return (remote: string, endpoint: { host: string; port: number }) => {
    if (revision !== platformAdapter.sessionConfigurationRevision?.()) {
      throw new Error("Incoming peer folder preparation changed; reconnect to refresh it.");
    }
    const ready = prepared.get(remote.replace(/[^A-Z2-7]/gi, "").toUpperCase());
    if (!ready) throw new Error("Incoming peer folder preparation is unavailable.");
    return { ...ready, ...endpoint };
  };
}

function handlePreferredIncoming(
  ctx: IncomingContext,
  params: {
    connectOptions: ConnectOptions;
    coreOptions: SyncpeerConnectOptions;
    session: SyncpeerSessionHandle;
    connectedRemoteDeviceId: string;
  },
) {
  const resolvedOptions: ConnectOptions = {
    ...params.connectOptions,
    host: params.coreOptions.host,
    port: params.coreOptions.port,
    cert: params.coreOptions.certPem,
    key: params.coreOptions.keyPem,
    remoteId: params.connectedRemoteDeviceId,
  };
  void prepareBackgroundHandoff(ctx.platformAdapter, resolvedOptions)
    .then(() => ctx.getLifecycle().adopt(params.connectOptions, params.session))
    .then((adopted) => {
      if (!adopted) return;
      ctx.state.activeResolvedConnectOptions = resolvedOptions;
      logClient(ctx.options.onLog, "client.session.incoming.ready", {
        transportKind: params.session.transportKind,
        connectionScope: params.session.connectionScope,
      });
    })
    .catch((error) => {
      void params.session.close().catch(() => undefined);
      ctx.coreAdapter.log?.("core.background.prepare.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

function handleBackgroundIncoming(
  ctx: IncomingContext,
  params: {
    session: SyncpeerSessionHandle;
    connectedRemoteDeviceId: string;
    prepared: Map<string, SyncpeerConnectOptions>;
  },
) {
  const preparedOptions = params.prepared.get(
    params.connectedRemoteDeviceId.replace(/[^A-Z2-7]/gi, "").toUpperCase(),
  );
  if (!preparedOptions) {
    void params.session.close().catch(() => undefined);
    return;
  }
  void ctx.getLifecycle().adoptIncoming(preparedOptions, params.session)
    .then((adopted) => {
      if (!adopted) return;
      ctx.state.activeResolvedConnectOptions = preparedOptions;
      logClient(ctx.options.onLog, "client.session.incoming.background_ready", {
        transportKind: params.session.transportKind,
        connectionScope: params.session.connectionScope,
      });
      ctx.options.onIncomingSession?.({
        remoteDeviceId: params.connectedRemoteDeviceId,
        options: preparedOptions,
        session: params.session,
      });
    })
    .catch((error) => {
      void params.session.close().catch(() => undefined);
      ctx.coreAdapter.log?.("core.incoming.adopt.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

function createIncomingSessionHandlers(
  ctx: IncomingContext,
  params: {
    connectOptions: ConnectOptions;
    coreOptions: SyncpeerConnectOptions;
    expectedDeviceId: string;
    localDeviceId: string;
    prepared: Map<string, SyncpeerConnectOptions>;
    revision: number | undefined;
    background: boolean;
  },
) {
  return {
    connectionOptions: incomingConnectionOptions(
      params.prepared,
      params.revision,
      ctx.platformAdapter,
    ),
    onSession: (session: SyncpeerSessionHandle, connectedRemoteDeviceId: string) => {
      if (
        sameDeviceId(connectedRemoteDeviceId, params.expectedDeviceId) &&
        preferredPeerDirection(params.localDeviceId, connectedRemoteDeviceId) === "incoming"
      ) {
        handlePreferredIncoming(ctx, { ...params, session, connectedRemoteDeviceId });
        return;
      }
      if (params.background) {
        handleBackgroundIncoming(ctx, {
          session,
          connectedRemoteDeviceId,
          prepared: params.prepared,
        });
      }
    },
  };
}

type IncomingListenerParams = {
  certPem: string;
  keyPem: string;
  localDeviceId: string;
  approvedDeviceIds: string[];
  automaticRelay: ReturnType<typeof automaticRelayConfiguration>;
  listenPort: number;
  sessionHandlers: ReturnType<typeof createIncomingSessionHandlers>;
};

function startIncomingPeer(
  ctx: IncomingContext,
  params: IncomingListenerParams,
  port: number,
): Promise<IncomingService> {
  return startIncomingPeerService(ctx.coreAdapter, {
    host: "0.0.0.0",
    port,
    certPem: params.certPem,
    keyPem: params.keyPem,
    localDeviceId: params.localDeviceId,
    approvedDeviceIds: params.approvedDeviceIds,
    automaticRelay: params.automaticRelay,
    ...params.sessionHandlers,
    onPairingSocket: async (accepted) => {
      await accepted.socket.close().catch(() => undefined);
    },
    onError: (error) => ctx.coreAdapter.log?.("core.incoming.failed", {
      message: error instanceof Error ? error.message : String(error),
    }),
  });
}

async function startIncomingWithFallback(
  ctx: IncomingContext,
  params: IncomingListenerParams,
): Promise<IncomingService> {
  try {
    const started = await startIncomingPeer(ctx, params, params.listenPort);
    ctx.state.incomingListenerEphemeral = false;
    return started;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const bindFailure = /could not listen|eaddrinuse|address already in use/i.test(message);
    if (params.listenPort !== 0 && bindFailure) {
      ctx.coreAdapter.log?.("core.incoming.listen.retry_ephemeral", {
        port: params.listenPort,
      });
      const started = await startIncomingPeer(ctx, params, 0);
      ctx.state.incomingListenerEphemeral = true;
      return started;
    }
    ctx.state.incomingListenerError = message;
    throw error;
  }
}

async function replaceIncomingService(
  ctx: IncomingContext,
  params: IncomingListenerParams & { key: string },
): Promise<IncomingService> {
  const update = ctx.state.incomingServiceUpdate.then(async () => {
    if (ctx.state.incomingService && ctx.state.incomingServiceKey === params.key) {
      ctx.state.incomingService.updateSessionHandlers(params.sessionHandlers);
      return ctx.state.incomingService;
    }
    ctx.coreAdapter.log?.("core.incoming.prepare.previous_close_start", {});
    await stopIncomingService(ctx.state);
    ctx.coreAdapter.log?.("core.incoming.prepare.previous_close_done", {});
    const started = await startIncomingWithFallback(ctx, params);
    ctx.state.incomingService = started;
    ctx.state.incomingServiceKey = params.key;
    ctx.state.incomingServicePort = started.port;
    ctx.state.incomingListenerError = null;
    return ctx.state.incomingService;
  });
  ctx.state.incomingServiceUpdate = update.catch(() => undefined);
  return update;
}

async function ensureIncomingServiceImpl(
  ctx: IncomingContext,
  connectOptions: ConnectOptions,
  coreOptions: SyncpeerConnectOptions,
  background = false,
): Promise<IncomingService | null> {
  if (ctx.platformAdapter.incomingSessionOwnedByService || !ctx.coreAdapter.listenTls) {
    return null;
  }
  const devices = await selectIncomingDevices(ctx, coreOptions, background);
  if (!devices) return null;
  if (!background && !devices.approvedDeviceIds.length) {
    await stopIncomingService(ctx.state);
    return null;
  }
  const prepared = await prepareIncomingOptions(ctx, connectOptions, coreOptions, devices);
  const sessionHandlers = createIncomingSessionHandlers(ctx, {
    ...devices,
    ...prepared,
    connectOptions,
    coreOptions,
    background,
  });
  if (prepared.revision !== ctx.platformAdapter.sessionConfigurationRevision?.()) {
    throw new Error("Incoming peer folder preparation changed before the listener started.");
  }
  return replaceIncomingService(ctx, {
    key: prepared.key,
    listenPort: prepared.listenPort,
    certPem: coreOptions.certPem,
    keyPem: coreOptions.keyPem,
    localDeviceId: devices.localDeviceId,
    approvedDeviceIds: devices.approvedDeviceIds,
    automaticRelay: prepared.automaticRelay,
    sessionHandlers,
  });
}

function createIncomingController(ctx: IncomingContext): IncomingRuntime {
  const stop = () => stopIncomingService(ctx.state);
  const status = () => backgroundListenerStatus(ctx.state);
  const start = (options?: { listenPort?: number }) => startBackgroundListenerImpl(ctx, options);
  const stopListener = () => stopBackgroundListenerImpl(ctx);
  const ensure = (
    connectOptions: ConnectOptions,
    coreOptions: SyncpeerConnectOptions,
    background = false,
  ) => ensureIncomingServiceImpl(ctx, connectOptions, coreOptions, background);
  return {
    ensureIncomingService: ensure,
    stopIncomingService: stop,
    startBackgroundListener: start,
    stopBackgroundListener: stopListener,
    backgroundListenerStatus: status,
    api: {
      startBackgroundListener: start,
      stopBackgroundListener: stopListener,
      backgroundListenerStatus: status,
    },
  };
}

function assertTrustedPeer(normalized: ConnectOptions, trustedDevices: OwnedSpaceDevice[]) {
  if (
    normalized.remoteId &&
    !resolveApprovedPeerDeviceIds(normalized.remoteId, trustedDevices)
      .some((id) => sameDeviceId(id, normalized.remoteId!))
  ) {
    throw new Error("This peer was removed from the trusted device list.");
  }
}

function missingCredential(label: "cert" | "key", defaultIdentityError: string | null) {
  const suffix = defaultIdentityError
    ? ` Default identity lookup failed: ${defaultIdentityError}`
    : "";
  return new Error(`Missing ${label}. Provide PEM text or a readable file path.${suffix}`);
}

async function resolveSessionCredentials(
  ctx: SessionContext,
  normalized: ConnectOptions,
): Promise<{ certPem: string; keyPem: string }> {
  let certPem = normalized.cert
    ? await resolvePemValue(ctx.platformAdapter, "cert", normalized.cert)
    : null;
  let keyPem = normalized.key
    ? await resolvePemValue(ctx.platformAdapter, "key", normalized.key)
    : null;
  let defaultIdentityError: string | null = null;
  if (!certPem || !keyPem) {
    try {
      const identity = await ctx.resolveDefaultIdentity();
      certPem ??= identity.certPem;
      keyPem ??= identity.keyPem;
    } catch (error) {
      defaultIdentityError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!certPem) throw missingCredential("cert", defaultIdentityError);
  if (!keyPem) throw missingCredential("key", defaultIdentityError);
  return { certPem, keyPem };
}

async function resolveSessionFolders(ctx: SessionContext, normalized: ConnectOptions) {
  const sharedFolders = normalized.sharedFolders ??
    await ctx.platformAdapter.sessionSharedFolders?.(normalized.remoteId ?? "");
  logClient(ctx.options.onLog, "client.shared_folders.selected", {
    ...sharedFolderCounts(sharedFolders ?? []),
    folderPasswordCount: Object.keys(normalized.folderPasswords ?? {}).length,
  });
  return sharedFolders;
}

function buildCoreConnectOptions(
  normalized: ConnectOptions,
  credentials: { certPem: string; keyPem: string },
  sharedFolders: ConnectOptions["sharedFolders"],
): SyncpeerConnectOptions {
  return {
    host: normalized.host,
    port: normalized.port,
    discoveryMode: normalized.discoveryMode,
    discoveryServer: normalized.discoveryServer,
    certPem: credentials.certPem,
    keyPem: credentials.keyPem,
    expectedDeviceId: normalized.remoteId,
    deviceName: normalized.deviceName,
    timeoutMs: normalized.timeoutMs,
    enableRelayFallback: normalized.enableRelayFallback,
    relayOnly: normalized.relayOnly,
    quicOnly: normalized.quicOnly,
    folderPasswords: normalized.folderPasswords,
    sharedFolders,
  };
}

async function prepareIncomingListener(
  ctx: SessionContext,
  connectOptions: ConnectOptions,
  coreOptions: SyncpeerConnectOptions,
) {
  try {
    return {
      service: await ctx.incoming.ensureIncomingService(connectOptions, coreOptions),
      failure: undefined as unknown,
    };
  } catch (error) {
    ctx.coreAdapter.log?.("core.incoming.listen.failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { service: null, failure: error };
  }
}

async function waitForPreferredIncoming(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
  normalized: ConnectOptions,
  coreOptions: SyncpeerConnectOptions,
  service: IncomingService | null,
  signal: AbortSignal,
) {
  const remoteId = normalized.remoteId;
  if (!service || !remoteId) return undefined;
  const localDeviceId = await deviceIdFromCertificate(
    ctx.coreAdapter,
    certificateDerFromPem(coreOptions.certPem),
  );
  if (preferredPeerDirection(localDeviceId, remoteId) !== "incoming") return undefined;
  const deadline = Date.now() + (coreOptions.timeoutMs ?? 15000);
  while (!signal.aborted && Date.now() < deadline) {
    const active = lifecycle.getSession();
    if (active && sameDeviceId(active.remoteDeviceId, remoteId) && !active.isClosed()) {
      return active;
    }
    const services = [...new Set([ctx.state.incomingService, service])];
    const candidate = services.flatMap((value) => value?.activeSessions() ?? []).find((value) =>
      sameDeviceId(value.remoteDeviceId, remoteId) && !value.session.isClosed());
    if (candidate) return candidate.session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (signal.aborted) {
    const error = new Error("Connection attempt was cancelled.");
    error.name = "AbortError";
    throw error;
  }
  throw new Error(`Timed out waiting for the preferred incoming connection from ${remoteId}.`);
}

async function openCoreSession(
  ctx: SessionContext,
  coreOptions: SyncpeerConnectOptions,
  signal: AbortSignal,
  listenerFailure: unknown,
  listenPort: number,
) {
  try {
    return await ctx.coreClient.openSession(coreOptions, signal);
  } catch (error) {
    if (listenerFailure) {
      throw new AggregateError(
        [error, listenerFailure],
        `Could not connect to the peer or start the incoming LAN listener on TCP port ${listenPort}.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function admitOutgoingSession(
  session: SyncpeerSessionHandle,
  normalized: ConnectOptions,
  service: IncomingService | null,
) {
  if (!service || !normalized.remoteId) return session;
  const remoteId = normalized.remoteId;
  const admitted = await service.admitOutgoing(remoteId, session.connectedVia, session);
  if (admitted) return session;
  const normalizedRemote = remoteId.replace(/[^A-Z2-7]/gi, "").toUpperCase();
  const selected = service.activeSessions().find((candidate) =>
    candidate.remoteDeviceId.replace(/[^A-Z2-7]/gi, "").toUpperCase() === normalizedRemote);
  if (!selected) {
    throw new Error("The authenticated peer session was replaced before it became active.");
  }
  return selected.session;
}

async function prepareSession(ctx: SessionContext, connectOptions: ConnectOptions) {
  const normalized = normalizeConnectOptions(connectOptions);
  ctx.coreAdapter.log?.("core.session.open.trust_start", {});
  const trustedDevices = (await ctx.platformAdapter.ownedDevices?.().catch(() => [])) ?? [];
  ctx.coreAdapter.log?.("core.session.open.trust_done", {
    deviceCount: trustedDevices.length,
  });
  assertTrustedPeer(normalized, trustedDevices);
  const credentials = await resolveSessionCredentials(ctx, normalized);
  const sharedFolders = await resolveSessionFolders(ctx, normalized);
  const coreOptions = buildCoreConnectOptions(normalized, credentials, sharedFolders);
  return { normalized, credentials, coreOptions };
}

async function openSessionImpl(
  ctx: SessionContext,
  getLifecycle: () => ConnectionLifecycle<ConnectOptions>,
  connectOptions: ConnectOptions,
  signal: AbortSignal,
): Promise<SyncpeerSessionHandle> {
  const { normalized, credentials, coreOptions } = await prepareSession(ctx, connectOptions);
  const listener = await prepareIncomingListener(ctx, connectOptions, coreOptions);
  const preferred = await waitForPreferredIncoming(
    ctx,
    getLifecycle(),
    normalized,
    coreOptions,
    listener.service,
    signal,
  );
  if (preferred) return preferred;
  let session = await openCoreSession(
    ctx,
    coreOptions,
    signal,
    listener.failure,
    connectOptions.listenPort ?? 22000,
  );
  session = await admitOutgoingSession(session, normalized, listener.service);
  ctx.state.activeResolvedConnectOptions = {
    ...normalized,
    cert: credentials.certPem,
    key: credentials.keyPem,
  };
  await prepareBackgroundHandoff(ctx.platformAdapter, ctx.state.activeResolvedConnectOptions);
  logClient(ctx.options.onLog, "client.session.open.ready", {
    transportKind: session.transportKind,
    connectionScope: session.connectionScope,
  });
  return session;
}

async function refreshSessionConfiguration(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
  requestedRevision: number | undefined,
) {
  if (requestedRevision !== ctx.platformAdapter.sessionConfigurationRevision?.()) return;
  const currentOptions = ctx.state.activeConnectOptions ?? ctx.state.activeResolvedConnectOptions;
  if (!currentOptions) return;
  try {
    await lifecycle.ensureSession(currentOptions);
  } catch (error) {
    ctx.coreAdapter.log?.("core.session.refresh.failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function createSessionLifecycle(
  ctx: SessionContext,
  open: (connectOptions: ConnectOptions, signal: AbortSignal) => Promise<SyncpeerSessionHandle>,
) {
  const lifecycle = createConnectionLifecycle<ConnectOptions>({
    open,
    keyFor: (connectOptions) => serializeConnectionKey(
      normalizeConnectOptions(connectOptions),
      connectOptions.cert ?? "default-cert",
      connectOptions.key ?? "default-key",
      ctx.platformAdapter.sessionConfigurationRevision?.() ?? 0,
    ),
  });
  ctx.platformAdapter.onSessionConfigurationChange?.(() => {
    const requestedRevision = ctx.platformAdapter.sessionConfigurationRevision?.();
    ctx.state.sessionConfigurationRefresh = ctx.state.sessionConfigurationRefresh.then(
      () => refreshSessionConfiguration(ctx, lifecycle, requestedRevision),
    );
  });
  return lifecycle;
}

function createRemoteFsLike(ctx: SessionContext, lifecycle: ConnectionLifecycle<ConnectOptions>) {
  return createRecoveringRemoteFs({
    getOptions: () => ctx.state.activeConnectOptions,
    ensureSession: (options) => lifecycle.ensureSession(options),
    getFocusedFolderId: () => ctx.state.focusedFolderId,
    setFocusedFolderId: (folderId) => { ctx.state.focusedFolderId = folderId; },
    getActiveSession: lifecycle.getSession,
  });
}

function withSessionOperation<TResult>(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
  connectOptions: ConnectOptions | null,
  operation: (session: SyncpeerSessionHandle) => Promise<TResult>,
) {
  return withMetadataSession(
    connectOptions,
    (options) => lifecycle.ensureSession(options),
    ctx.state.focusedFolderId,
    operation,
  );
}

/**
 * Stop the service-owned background session before the foreground session resumes.
 * A rejected or stalled native stop must not gate the lifecycle: every later connect
 * would fail immediately with "Connection is suspended or offline."
 */
async function stopBackgroundHandoff(ctx: SessionContext): Promise<void> {
  const stopping = ctx.platformAdapter.stopBackgroundSession?.();
  if (!stopping) return;
  const timeoutMs = 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(
      `Background session stop did not finish within ${timeoutMs} ms.`,
    ), timeoutMs);
  });
  const failure = stopping.then(
    () => null,
    (error: unknown) => error instanceof Error ? error.message : String(error),
  );
  const reason = await Promise.race([failure, stalled]);
  if (timer !== undefined) clearTimeout(timer);
  if (reason === null) return;
  ctx.coreAdapter.log?.("core.background.stop.failed", {
    message: reason || "Background session stop failed.",
  });
}

async function setSessionForegroundImpl(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
  foreground: boolean,
) {
  if (foreground) {
    // Resuming must not wait for the native stop: the service worker also runs
    // document I/O, so a busy or stalled stop delayed the lifecycle for seconds
    // and every connect in between failed with "Connection is suspended or offline."
    if (ctx.state.backgroundSessionStarted) {
      ctx.state.backgroundSessionStarted = false;
      void stopBackgroundHandoff(ctx);
    }
    await lifecycle.setForeground(true);
    await prepareBackgroundHandoff(ctx.platformAdapter, ctx.state.activeResolvedConnectOptions);
    return;
  }
  const backgroundOptions = backgroundSessionOptions(ctx.state.activeResolvedConnectOptions);
  const backgroundSession = backgroundOptions && ctx.platformAdapter.startBackgroundSession
    ? ctx.platformAdapter.startBackgroundSession(backgroundOptions)
    : null;
  if (backgroundSession) {
    ctx.state.backgroundSessionStarted = true;
    void backgroundSession.catch(() => {
      ctx.state.backgroundSessionStarted = false;
    });
  }
  if (ctx.platformAdapter.startBackgroundSession) {
    await lifecycle.setTransferActive(false);
  }
  await lifecycle.setForeground(false);
  await ctx.incoming.stopIncomingService();
  if (backgroundSession) await backgroundSession;
}

async function releaseLocalCopyImpl(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
  folderId: string,
  mode: "safe" | "dangerous",
  confirmedText = "",
) {
  if (!ctx.platformAdapter.releaseLocalCopy) {
    throw new Error("Local copy release is unavailable on this platform.");
  }
  const handoff = mode === "safe" && !!ctx.platformAdapter.startBackgroundSession;
  if (handoff && !ctx.state.activeResolvedConnectOptions) {
    throw new Error("Connect to a peer before verifying online copies.");
  }
  try {
    if (handoff) await setSessionForegroundImpl(ctx, lifecycle, false);
    const sessions = [
      ...(ctx.state.incomingService?.activeSessions().map((value) => value.session) ?? []),
      ...(lifecycle.getSession() ? [lifecycle.getSession()!] : []),
    ].filter((session) => !session.isClosed());
    await ctx.platformAdapter.releaseLocalCopy(folderId, mode, confirmedText, sessions);
    if (!handoff) {
      await lifecycle.disconnect();
      await ctx.incoming.stopIncomingService();
    }
  } finally {
    if (handoff) await setSessionForegroundImpl(ctx, lifecycle, true);
  }
}

async function connectAndSyncImpl(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
  remoteFsLike: ReturnType<typeof createRemoteFsLike>,
  connectOptions: ConnectOptions,
) {
  ctx.state.activeConnectOptions = connectOptions;
  await lifecycle.connect(connectOptions);
  return remoteFsLike;
}

async function connectAndGetOverviewImpl(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
  connectOptions: ConnectOptions,
) {
  const overview = await withSessionOperation(
    ctx,
    lifecycle,
    connectOptions,
    (session) => toConnectionOverview(session),
  );
  ctx.state.activeConnectOptions = connectOptions;
  return overview;
}

async function connectAndGetFolderVersionsImpl(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
  connectOptions: ConnectOptions,
) {
  const versions = await withSessionOperation(
    ctx,
    lifecycle,
    connectOptions,
    (session) => Promise.resolve(session.remoteFs.listFolderSyncStates?.() ?? []),
  );
  ctx.state.activeConnectOptions = connectOptions;
  return versions;
}

async function disconnectSessionImpl(
  ctx: SessionContext,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
) {
  ctx.state.activeConnectOptions = null;
  ctx.state.activeResolvedConnectOptions = null;
  ctx.state.focusedFolderId = null;
  if (!ctx.state.backgroundListenerActive) {
    ctx.state.backgroundSessionStarted = false;
    await stopBackgroundHandoff(ctx);
  }
  await lifecycle.disconnect();
  if (ctx.state.backgroundListenerActive) {
    await ctx.incoming.startBackgroundListener({
      listenPort: ctx.state.backgroundListenerListenPort,
    });
  } else {
    await ctx.incoming.stopIncomingService();
  }
}

function createSessionController(ctx: SessionContext): SessionRuntime {
  const lifecycle = createSessionLifecycle(ctx, (connectOptions, signal) =>
    openSessionImpl(ctx, () => lifecycle, connectOptions, signal));
  const remoteFsLike = createRemoteFsLike(ctx, lifecycle);
  return {
    lifecycle,
    api: {
      connectAndSync: (connectOptions) =>
        connectAndSyncImpl(ctx, lifecycle, remoteFsLike, connectOptions),
      connectAndGetOverview: (connectOptions) =>
        connectAndGetOverviewImpl(ctx, lifecycle, connectOptions),
      connectAndGetFolderVersions: (connectOptions) =>
        connectAndGetFolderVersionsImpl(ctx, lifecycle, connectOptions),
      disconnect: () => disconnectSessionImpl(ctx, lifecycle),
      releaseLocalCopy: (folderId, mode, confirmedText) =>
        releaseLocalCopyImpl(ctx, lifecycle, folderId, mode, confirmedText),
      setForeground: (foreground) => setSessionForegroundImpl(ctx, lifecycle, foreground),
      subscribeLifecycle: lifecycle.subscribe,
      setOnline: lifecycle.setOnline,
      setTransferActive: lifecycle.setTransferActive,
      acknowledgeCachedSync: ctx.platformAdapter.acknowledgeCachedSync,
    },
  };
}

function pairingRelayAddress(ctx: PairingContext, pairingOptions: PairingInvitationOptions) {
  const relayAddress = pairingOptions.advertisedHost.startsWith("relay://")
    ? relayPairingEndpoint(pairingOptions.advertisedHost)
    : null;
  if (relayAddress ? !ctx.coreAdapter.listenRelay : !ctx.coreAdapter.listenTls) {
    throw new Error(relayAddress
      ? "This platform cannot accept relay pairing connections."
      : "This platform cannot accept LAN pairing connections.");
  }
  if (!relayAddress) {
    advertisedPairingEndpoint(pairingOptions.advertisedHost, pairingOptions.port || 22000);
  }
  return relayAddress;
}

async function resetForPairing(ctx: PairingContext) {
  await ctx.platformAdapter.stopBackgroundSession?.();
  ctx.state.activeConnectOptions = null;
  ctx.state.activeResolvedConnectOptions = null;
  ctx.state.focusedFolderId = null;
  await ctx.lifecycle.disconnect();
  await ctx.incoming.stopIncomingService();
}

function createPairingAcceptHandler(
  ctx: PairingContext,
  identity: SyncpeerIdentityRecord & { deviceId: string },
  pairingOptions: PairingInvitationOptions,
  session: PairingSession,
): PairingSocketHandler {
  return async (accepted, remoteDeviceId) => {
    if (session.settled) {
      throw new Error("Pairing invitation is unavailable or already used.");
    }
    logClient(ctx.options.onLog, "client.pairing.accept.socket", {});
    try {
      const invitationRecord = await session.invitationReady.promise;
      logClient(ctx.options.onLog, "client.pairing.accept.transfer_start", {});
      const result = await acceptPairingTransfer({
        subtle: crypto.subtle,
        socket: accepted.socket,
        invitation: invitationRecord,
        verifiedRemoteId: remoteDeviceId,
        createTransfer: (joiningDevice) =>
          ctx.platformAdapter.exportPairingTransfer!(identity.deviceId, joiningDevice),
        randomBytes: ctx.coreAdapter.randomBytes,
        confirm: pairingOptions.confirm,
      });
      logClient(ctx.options.onLog, "client.pairing.accept.transfer_done", {});
      session.settled = true;
      session.completion.resolve({ remoteDeviceId: result.remoteDeviceId });
      setTimeout(() => { void ctx.incoming.stopIncomingService(); }, 0);
    } catch (error) {
      logClient(ctx.options.onLog, "client.pairing.accept.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      session.settled = true;
      session.completion.reject(error);
      throw error;
    }
  };
}

async function startPairingListener(
  ctx: PairingContext,
  relayAddress: string | null,
  pairingOptions: PairingInvitationOptions,
  identity: SyncpeerIdentityRecord & { deviceId: string },
  onPairingSocket: PairingSocketHandler,
) {
  ctx.state.incomingService = await startIncomingPeerService(ctx.coreAdapter, {
    mode: relayAddress ? "relay" : "direct",
    ...(relayAddress ? { relayAddress } : {}),
    host: "0.0.0.0",
    port: pairingOptions.port ?? 22000,
    certPem: identity.certPem,
    keyPem: identity.keyPem,
    localDeviceId: identity.deviceId,
    approvedDeviceIds: [],
    connectionOptions: () => {
      throw new Error("A pairing invitation does not approve BEP access.");
    },
    onSession: (session) => { void session.close(); },
    onPairingSocket,
  });
  ctx.state.incomingServiceKey = "pairing";
}

async function publishPairingInvitation(
  ctx: PairingContext,
  identity: SyncpeerIdentityRecord & { deviceId: string },
  relayAddress: string | null,
  pairingOptions: PairingInvitationOptions,
  session: PairingSession,
) {
  try {
    const advertisedEndpoint = relayAddress ?? advertisedPairingEndpoint(
      pairingOptions.advertisedHost,
      ctx.state.incomingService!.port,
    );
    const invitation = await createPairingInvitation(
      crypto.subtle,
      ctx.coreAdapter.randomBytes,
      identity.deviceId,
      advertisedEndpoint,
      Date.now() + (pairingOptions.expiresInMs ?? 5 * 60_000),
    );
    session.invitationReady.resolve(invitation);
    return invitation;
  } catch (error) {
    session.settled = true;
    session.invitationReady.reject(error);
    void session.completion.promise.catch(() => undefined);
    await ctx.incoming.stopIncomingService();
    throw error;
  }
}

async function startPairingInvitationImpl(
  ctx: PairingContext,
  pairingOptions: PairingInvitationOptions,
) {
  const relayAddress = pairingRelayAddress(ctx, pairingOptions);
  if (!ctx.platformAdapter.exportPairingTransfer) {
    throw new Error("Personal-space pairing storage is unavailable.");
  }
  const identity = await ctx.identityForPairing();
  await resetForPairing(ctx);
  const completion = deferred<{ remoteDeviceId: string }>();
  const invitationReady = deferred<InvitationRecord>();
  void invitationReady.promise.catch(() => undefined);
  const session: PairingSession = { settled: false, completion, invitationReady };
  await startPairingListener(
    ctx,
    relayAddress,
    pairingOptions,
    identity,
    createPairingAcceptHandler(ctx, identity, pairingOptions, session),
  );
  const invitation = await publishPairingInvitation(
    ctx,
    identity,
    relayAddress,
    pairingOptions,
    session,
  );
  return finishPairingInvitation(ctx, session, invitation);
}

function finishPairingInvitation(
  ctx: PairingContext,
  session: PairingSession,
  invitation: InvitationRecord,
) {
  session.timer = setTimeout(() => {
    if (!session.settled) {
      session.settled = true;
      session.completion.reject(new Error("Pairing invitation expired."));
    }
    void ctx.incoming.stopIncomingService();
  }, Math.max(0, invitation.invitation.expiresAt - Date.now()));
  void session.completion.promise
    .finally(() => { if (session.timer) clearTimeout(session.timer); })
    .catch(() => undefined);
  return {
    invitation: invitation.invitation,
    completed: session.completion.promise,
    cancel: async () => {
      if (!session.settled) {
        session.settled = true;
        session.completion.reject(new Error("Pairing invitation cancelled."));
      }
      await ctx.incoming.stopIncomingService();
    },
  };
}

async function connectPairingSocket(
  ctx: PairingContext,
  pairingOptions: PairingJoinOptions,
  identity: SyncpeerIdentityRecord & { deviceId: string },
  relayAddress: string | null,
) {
  if (relayAddress) {
    if (!ctx.coreAdapter.connectRelay) {
      throw new Error("This platform cannot join relay pairing connections.");
    }
    return (await connectRelayWithRetry(ctx.coreAdapter, {
      relayAddress,
      expectedDeviceId: pairingOptions.invitation.deviceId,
      certPem: identity.certPem,
      keyPem: identity.keyPem,
      alpnProtocols: ["syncpeer-pairing/1"],
    })).socket;
  }
  return ctx.coreAdapter.connectTls({
    ...pairingEndpoint(pairingOptions.invitation.endpoint),
    certPem: identity.certPem,
    keyPem: identity.keyPem,
    alpnProtocols: ["syncpeer-pairing/1"],
  });
}

async function completePairingJoin(
  ctx: PairingContext,
  socket: SyncpeerTlsSocket,
  pairingOptions: PairingJoinOptions,
  identity: SyncpeerIdentityRecord & { deviceId: string },
) {
  try {
    const verifiedRemoteId = await deviceIdFromCertificate(
      ctx.coreAdapter,
      await socket.peerCertificateDer(),
    );
    logClient(ctx.options.onLog, "client.pairing.join.transfer_start", {});
    const joined = await joinPersonalSpace({
      subtle: crypto.subtle,
      socket,
      invitation: pairingOptions.invitation,
      localDeviceId: identity.deviceId,
      verifiedRemoteId,
      randomBytes: ctx.coreAdapter.randomBytes,
      confirm: pairingOptions.confirm,
    });
    logClient(ctx.options.onLog, "client.pairing.join.transfer_done", {});
    logClient(ctx.options.onLog, "client.pairing.join.import_start", {});
    await ctx.platformAdapter.importPairingTransfer!(
      joined.transfer,
      joined.deviceIdentity,
      pairingOptions.password,
      pairingOptions.remember,
    );
    logClient(ctx.options.onLog, "client.pairing.join.import_done", {});
    return { remoteDeviceId: verifiedRemoteId };
  } catch (error) {
    logClient(ctx.options.onLog, "client.pairing.join.failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await socket.close().catch(() => undefined);
  }
}

async function joinPairingInvitationImpl(
  ctx: PairingContext,
  pairingOptions: PairingJoinOptions,
) {
  if (!ctx.platformAdapter.importPairingTransfer) {
    throw new Error("Personal-space pairing storage is unavailable.");
  }
  logClient(ctx.options.onLog, "client.pairing.join.started", {});
  const identity = await ctx.identityForPairing();
  const relayAddress = pairingOptions.invitation.endpoint.startsWith("relay://")
    ? relayPairingEndpoint(pairingOptions.invitation.endpoint)
    : null;
  const socket = await connectPairingSocket(ctx, pairingOptions, identity, relayAddress);
  logClient(ctx.options.onLog, "client.pairing.join.connected", {});
  return completePairingJoin(ctx, socket, pairingOptions, identity);
}

function createPairingController(ctx: PairingContext) {
  return {
    api: {
      startPairingInvitation: (pairingOptions: PairingInvitationOptions) =>
        startPairingInvitationImpl(ctx, pairingOptions),
      joinPairingInvitation: (pairingOptions: PairingJoinOptions) =>
        joinPairingInvitationImpl(ctx, pairingOptions),
    },
  };
}

function createFavoriteProfileApi(platformAdapter: SyncpeerPlatformAdapter) {
  return {
    listFavorites: async (): Promise<FavoriteRecord[]> => platformAdapter.listFavorites
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
    saveProfileSettings: async (settings: Parameters<NonNullable<SyncpeerPlatformAdapter["saveProfileSettings"]>>[0]) =>
      platformAdapter.saveProfileSettings
        ? platformAdapter.saveProfileSettings(settings)
        : throwMissingAdapter("saveProfileSettings"),
    loadDirectorySnapshot: async (folderId: string, sourceDeviceId: string, path: string) =>
      platformAdapter.loadDirectorySnapshot
        ? platformAdapter.loadDirectorySnapshot(folderId, sourceDeviceId, path)
        : null,
    saveDirectorySnapshot: async (
      folderId: string,
      sourceDeviceId: string,
      path: string,
      snapshot: Parameters<NonNullable<SyncpeerPlatformAdapter["saveDirectorySnapshot"]>>[3],
    ) => {
      await platformAdapter.saveDirectorySnapshot?.(folderId, sourceDeviceId, path, snapshot);
    },
  };
}

function createCacheQueryApi(platformAdapter: SyncpeerPlatformAdapter) {
  return {
    enforceCacheQuota: async () => platformAdapter.enforceCacheQuota
      ? platformAdapter.enforceCacheQuota()
      : ({ quotaBytes: 0, cachedBytes: 0, protectedBytes: 0, evicted: [] }),
    listDocumentVersions: async (folderId: string, path: string) =>
      platformAdapter.listDocumentVersions
        ? platformAdapter.listDocumentVersions(folderId, path)
        : throwMissingAdapter("listDocumentVersions"),
    restoreDocumentVersion: async (folderId: string, path: string, versionId: string) =>
      platformAdapter.restoreDocumentVersion
        ? platformAdapter.restoreDocumentVersion(folderId, path, versionId)
        : throwMissingAdapter("restoreDocumentVersion"),
    listFavoriteSyncStates: async (folderIds: readonly string[]) =>
      platformAdapter.listFavoriteSyncStates
        ? platformAdapter.listFavoriteSyncStates(folderIds)
        : [],
    retryFavoriteSync: async (folderId: string, path: string) =>
      platformAdapter.retryFavoriteSync
        ? platformAdapter.retryFavoriteSync(folderId, path)
        : throwMissingAdapter("retryFavoriteSync"),
    resolveFavoriteConflict: async (
      folderId: string,
      path: string,
      resolution: "keep-local" | "keep-remote",
    ) => platformAdapter.resolveFavoriteConflict
      ? platformAdapter.resolveFavoriteConflict(folderId, path, resolution)
      : throwMissingAdapter("resolveFavoriteConflict"),
  };
}

function createCacheDataApi(platformAdapter: SyncpeerPlatformAdapter) {
  return {
    cacheFile: async (
      folderId: string,
      path: string,
      name: string,
      bytes: Uint8Array,
      modifiedMs?: number,
    ) => {
      if (!platformAdapter.cacheFile) return throwMissingAdapter("cacheFile");
      return platformAdapter.cacheFile(folderId, path, name, bytes, modifiedMs);
    },
    getCachedStatuses: async (folderId: string, paths: string[]) =>
      platformAdapter.getCachedStatuses
        ? platformAdapter.getCachedStatuses(folderId, paths)
        : throwMissingAdapter("getCachedStatuses"),
    digestCachedFiles: platformAdapter.digestCachedFiles
      ? (files: Parameters<NonNullable<SyncpeerPlatformAdapter["digestCachedFiles"]>>[0]) =>
          platformAdapter.digestCachedFiles!(files)
      : undefined,
    listLocalDirectory: async (folderId: string, path: string) =>
      platformAdapter.listLocalDirectory?.(folderId, path) ?? null,
    listCachedFiles: async (): Promise<CachedFileRecord[]> =>
      platformAdapter.listCachedFiles
        ? platformAdapter.listCachedFiles()
        : throwMissingAdapter("listCachedFiles"),
  };
}

function createCachedFileApi(platformAdapter: SyncpeerPlatformAdapter) {
  return {
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
    clearCache: async (): Promise<void> => platformAdapter.clearCache
      ? platformAdapter.clearCache()
      : throwMissingAdapter("clearCache"),
  };
}

function createTransferApi(
  platformAdapter: SyncpeerPlatformAdapter,
  lifecycle: ConnectionLifecycle<ConnectOptions>,
) {
  return {
    createFileDownloadSink: platformAdapter.createFileDownloadSink
      ? (args: Parameters<NonNullable<SyncpeerPlatformAdapter["createFileDownloadSink"]>>[0]) =>
          platformAdapter.createFileDownloadSink!(args)
      : undefined,
    startTransfer: async (label: string) => {
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
      ? (args: Parameters<NonNullable<SyncpeerPlatformAdapter["updateTransferNotification"]>>[0]) =>
          platformAdapter.updateTransferNotification!(args)
      : undefined,
  };
}

function createAndroidSafApi(platformAdapter: SyncpeerPlatformAdapter) {
  return {
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
  };
}

function createAndroidPimApi(platformAdapter: SyncpeerPlatformAdapter) {
  return {
    listAndroidContacts: async (): Promise<AndroidContactRecord[]> =>
      platformAdapter.listAndroidContacts
        ? platformAdapter.listAndroidContacts()
        : throwMissingAdapter("listAndroidContacts"),
    upsertAndroidContact: async (
      input: Parameters<NonNullable<SyncpeerPlatformAdapter["upsertAndroidContact"]>>[0],
    ): Promise<{ contactId: string }> => platformAdapter.upsertAndroidContact
      ? platformAdapter.upsertAndroidContact(input)
      : throwMissingAdapter("upsertAndroidContact"),
    deleteAndroidContact: async (contactId: string): Promise<{ deleted: boolean }> =>
      platformAdapter.deleteAndroidContact
        ? platformAdapter.deleteAndroidContact(contactId)
        : throwMissingAdapter("deleteAndroidContact"),
    listAndroidCalendarEvents: async (
      args?: Parameters<NonNullable<SyncpeerPlatformAdapter["listAndroidCalendarEvents"]>>[0],
    ): Promise<AndroidCalendarEventRecord[]> => platformAdapter.listAndroidCalendarEvents
      ? platformAdapter.listAndroidCalendarEvents(args)
      : throwMissingAdapter("listAndroidCalendarEvents"),
    upsertAndroidCalendarEvent: async (
      input: Parameters<NonNullable<SyncpeerPlatformAdapter["upsertAndroidCalendarEvent"]>>[0],
    ): Promise<{ eventId: string }> => platformAdapter.upsertAndroidCalendarEvent
      ? platformAdapter.upsertAndroidCalendarEvent(input)
      : throwMissingAdapter("upsertAndroidCalendarEvent"),
    deleteAndroidCalendarEvent: async (eventId: string): Promise<{ deleted: boolean }> =>
      platformAdapter.deleteAndroidCalendarEvent
        ? platformAdapter.deleteAndroidCalendarEvent(eventId)
        : throwMissingAdapter("deleteAndroidCalendarEvent"),
  };
}

function createDiscoveryApi(
  coreAdapter: SyncpeerHostAdapter,
): Pick<SyncpeerBrowserClient, "discoverLocalDevices"> {
  return {
    discoverLocalDevices: async (discoverOptions?: { timeoutMs?: number }) => {
      if (!coreAdapter.discoverLocalCandidates) return [];
      const candidates = await coreAdapter.discoverLocalCandidates({
        expectedDeviceId: "",
        timeoutMs: discoverOptions?.timeoutMs,
      });
      return collectDiscoveredDevices(candidates);
    },
  };
}

export const createSyncpeerBrowserClient = (
  options: CreateSyncpeerBrowserClientOptions,
): SyncpeerBrowserClient => {
  const base = createBrowserClientBase(options);
  const identity = createIdentityController(base);
  const incoming = createIncomingController({
    ...base,
    resolveDefaultIdentity: identity.resolveDefaultIdentity,
    getLifecycle: () => session.lifecycle,
  });
  const session = createSessionController({
    ...base,
    resolveDefaultIdentity: identity.resolveDefaultIdentity,
    incoming,
  });
  const lifecycle = session.lifecycle;
  const pairing = createPairingController({
    ...base,
    identityForPairing: identity.identityForPairing,
    lifecycle,
    incoming,
  });
  return {
    ...session.api,
    ...incoming.api,
    ...pairing.api,
    ...identity.api,
    ...createFavoriteProfileApi(base.platformAdapter),
    ...createCacheQueryApi(base.platformAdapter),
    ...createCacheDataApi(base.platformAdapter),
    ...createCachedFileApi(base.platformAdapter),
    ...createTransferApi(base.platformAdapter, lifecycle),
    ...createAndroidSafApi(base.platformAdapter),
    ...createAndroidPimApi(base.platformAdapter),
    ...createDiscoveryApi(base.coreAdapter),
  };
};
