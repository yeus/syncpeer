import { createSyncpeerCoreClient, type SyncpeerHostAdapter, type SyncpeerSessionHandle, withMetadataSession } from "../client.js";
import { createConnectionLifecycle, type ConnectionLifecycleState } from "./connectionLifecycle.js";
import { createRecoveringRemoteFs } from "./recoveringRemoteFs.js";
import type { ConnectionScope } from "../client.js";
import type { SharedFolder } from "../client.js";
import { normalizeDiscoveryServer } from "./discoveryServer.js";
export { getDefaultDiscoveryServer, normalizeDiscoveryServer } from "./discoveryServer.js";
import type {
  FileDownloadProgress,
  FileEntry,
  FileUploadOptions,
  FolderInfo,
  FolderSyncState,
  RemoteDeviceInfo,
} from "../core/model/remoteFs.js";
import type { FileDownloadResult, FileDownloadSink } from "../transfer/stream.js";

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
  writeFileFully: (
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: FileUploadOptions,
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
  readTextFile?: (path: string) => Promise<string>;
  readBinaryFile?: (path: string) => Promise<Uint8Array>;
  pickUploadFile?: () => Promise<string | null | undefined>;
  readDefaultIdentity?: () => Promise<SyncpeerIdentityRecord>;
  listFavorites?: () => Promise<FavoriteRecord[]>;
  upsertFavorite?: (favorite: FavoriteRecord) => Promise<FavoriteRecord[]>;
  removeFavorite?: (key: string) => Promise<FavoriteRecord[]>;
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
  listCachedFiles?: () => Promise<CachedFileRecord[]>;
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
  connectAndSync: (options: ConnectOptions) => Promise<RemoteFsLike>;
  connectAndGetOverview: (options: ConnectOptions) => Promise<ConnectionOverview>;
  connectAndGetFolderVersions: (options: ConnectOptions) => Promise<FolderSyncState[]>;
  discoverLocalDevices: (options?: { timeoutMs?: number }) => Promise<LocalDiscoveredDevice[]>;
  disconnect: () => Promise<void>;
  subscribeLifecycle: (listener: (state: ConnectionLifecycleState) => void) => () => void;
  setOnline: (online: boolean) => Promise<void>;
  setForeground: (foreground: boolean) => Promise<void>;
  setTransferActive: (active: boolean) => Promise<void>;
  listFavorites: () => Promise<FavoriteRecord[]>;
  upsertFavorite: (favorite: FavoriteRecord) => Promise<FavoriteRecord[]>;
  removeFavorite: (key: string) => Promise<FavoriteRecord[]>;
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
  listCachedFiles: () => Promise<CachedFileRecord[]>;
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

const logClient = (
  onLog: CreateSyncpeerBrowserClientOptions["onLog"],
  event: string,
  details?: unknown,
) => {
  emitLog(onLog, "info", event, details);
  if (details !== undefined) {
    console.log(`[syncpeer-core-ui] ${event}`, details);
    return;
  }
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
  sharedFolders: options.sharedFolders?.map((folder) => ({
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
  const message = error instanceof Error ? error.message : String(error);
  const normalizedContext =
    context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  console.error(`[syncpeer-core-ui] ${event}`, { message, ...normalizedContext });
  if (!platformAdapter?.logError) return;
  try {
    await platformAdapter.logError(event, { message, ...normalizedContext });
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
  let focusedFolderId: string | null = null;

  const resolveDefaultIdentity = async (): Promise<SyncpeerIdentityRecord> => {
    if (cachedDefaultIdentity) return cachedDefaultIdentity;
    if (!platformAdapter.readDefaultIdentity) {
      throw new Error("No readDefaultIdentity adapter is configured.");
    }
    cachedDefaultIdentity = await platformAdapter.readDefaultIdentity();
    return cachedDefaultIdentity;
  };

  const openSession = async (connectOptions: ConnectOptions): Promise<SyncpeerSessionHandle> => {
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

    const session = await coreClient.openSession({
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
      sharedFolders: normalized.sharedFolders,
    });
    logClient(options.onLog, "client.session.open.ready", {
      transportKind: session.transportKind,
      connectionScope: session.connectionScope,
    });
    return session;
  };

  const lifecycle = createConnectionLifecycle<ConnectOptions>({
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
      focusedFolderId = null;
      await lifecycle.disconnect();
    },
    subscribeLifecycle: lifecycle.subscribe,
    setOnline: lifecycle.setOnline,
    setForeground: lifecycle.setForeground,
    setTransferActive: lifecycle.setTransferActive,
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
    pickUploadFile: async (): Promise<string | null | undefined> =>
      platformAdapter.pickUploadFile
        ? platformAdapter.pickUploadFile()
        : undefined,
  };
};
