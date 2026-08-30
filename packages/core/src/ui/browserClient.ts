import {
  createSyncpeerCoreClient,
  withSessionTransportProgress,
  type SyncpeerHostAdapter,
  type SyncpeerSessionHandle,
  withRecoveringSession,
} from "../client.js";
import type { ConnectionScope } from "../client.js";
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
  discoveryMode?: "global" | "lan" | "direct";
  discoveryServer?: string;
  cert?: string;
  key?: string;
  remoteId?: string;
  deviceName: string;
  timeoutMs?: number;
  enableRelayFallback?: boolean;
  relayOnly?: boolean;
  folderPasswords?: Record<string, string>;
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
  ) => Promise<Uint8Array>;
  readFileToSink?: (
    folderId: string,
    path: string,
    sink: FileDownloadSink,
    onProgress?: (progress: FileDownloadProgress) => void,
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
  transportKind: "direct-tcp" | "relay";
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
  discoveryMode: options.discoveryMode ?? "global",
  discoveryServer: normalizeDiscoveryServer(options.discoveryServer),
  cert: options.cert && options.cert.trim() !== "" ? options.cert.trim() : undefined,
  key: options.key && options.key.trim() !== "" ? options.key.trim() : undefined,
  remoteId: options.remoteId && options.remoteId.trim() !== "" ? options.remoteId.trim() : undefined,
  deviceName: options.deviceName,
  timeoutMs: options.timeoutMs,
  enableRelayFallback: options.enableRelayFallback ?? true,
  relayOnly: options.relayOnly === true,
  folderPasswords: Object.fromEntries(
    Object.entries(options.folderPasswords ?? {})
      .map(([folderId, password]) => [folderId.trim(), password.trim()])
      .filter(([folderId, password]) => folderId !== "" && password !== ""),
  ),
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
    discoveryMode: options.discoveryMode ?? "global",
    discoveryServer: normalizeDiscoveryServer(options.discoveryServer),
    remoteId: options.remoteId ?? "",
    deviceName: options.deviceName,
    certPem,
    keyPem,
    relayOnly: options.relayOnly === true,
    folderPasswords: options.folderPasswords ?? {},
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
  let activeSession: SyncpeerSessionHandle | null = null;
  let activeConnectionKey: string | null = null;
  let openingSession: Promise<SyncpeerSessionHandle> | null = null;
  let openingConnectionKey: string | null = null;
  let activeConnectOptions: ConnectOptions | null = null;
  let focusedFolderId: string | null = null;
  let sessionGeneration = 0;

  const closeActiveSession = async (): Promise<void> => {
    const previous = activeSession;
    activeSession = null;
    activeConnectionKey = null;
    if (previous) {
      await previous.close();
    }
  };

  const resolveDefaultIdentity = async (): Promise<SyncpeerIdentityRecord> => {
    if (cachedDefaultIdentity) return cachedDefaultIdentity;
    if (!platformAdapter.readDefaultIdentity) {
      throw new Error("No readDefaultIdentity adapter is configured.");
    }
    cachedDefaultIdentity = await platformAdapter.readDefaultIdentity();
    return cachedDefaultIdentity;
  };

  const ensureSession = async (
    connectOptions: ConnectOptions,
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

    const key = serializeConnectionKey(normalized, certPem, keyPem);
    if (activeSession && activeConnectionKey === key) {
      if (!activeSession.isClosed()) {
        logClient(options.onLog, "client.session.ensure.reuse", {
          connectedVia: activeSession.connectedVia,
          transportKind: activeSession.transportKind,
        });
        return activeSession;
      }
      logClient(options.onLog, "client.session.reopen.closed", {
        connectedVia: activeSession.connectedVia,
        transportKind: activeSession.transportKind,
      });
    }

    if (openingSession) {
      if (openingConnectionKey === key) {
        logClient(options.onLog, "client.session.ensure.wait_existing_open", {
          reason: "same_connection_key",
        });
        return openingSession;
      }
      logClient(options.onLog, "client.session.ensure.wait_existing_open", {
        reason: "different_connection_key",
      });
      try {
        await openingSession;
      } catch {
        // Ignore prior open failure; we are about to attempt another open.
      }
      if (activeSession && activeConnectionKey === key && !activeSession.isClosed()) {
        return activeSession;
      }
    }

    const openingGeneration = sessionGeneration;
    openingConnectionKey = key;
    openingSession = (async () => {
      await closeActiveSession();
      logClient(options.onLog, "client.session.open.start", {
        discoveryMode: normalized.discoveryMode ?? "global",
        host: normalized.host,
        port: normalized.port,
        hasRemoteId: !!normalized.remoteId,
      });
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
        folderPasswords: normalized.folderPasswords,
      });
      if (sessionGeneration !== openingGeneration) {
        await session.close().catch(() => undefined);
        throw new Error("Connection attempt was cancelled by disconnect");
      }
      activeSession = session;
      activeConnectionKey = key;
      logClient(options.onLog, "client.session.open.ready", {
        connectedVia: session.connectedVia,
        transportKind: session.transportKind,
      });
      return session;
    })();

    try {
      return await openingSession;
    } finally {
      if (openingSession && openingConnectionKey === key) {
        openingSession = null;
        openingConnectionKey = null;
      }
    }
  };

  const withSessionOperation = async <TResult>(
    connectOptions: ConnectOptions | null,
    operation: (session: SyncpeerSessionHandle) => Promise<TResult>,
  ): Promise<TResult> => {
    const operationGeneration = sessionGeneration;
    const result = await withRecoveringSession(
      connectOptions,
      ensureSession,
      focusedFolderId,
      operation,
      () => sessionGeneration === operationGeneration,
    );
    if (sessionGeneration !== operationGeneration) {
      throw new Error("Session operation was cancelled by disconnect");
    }
    return result;
  };

  const remoteFsLike: RemoteFsLike = {
    listFolders: () =>
      withSessionOperation(
        activeConnectOptions,
        (session) => session.remoteFs.listFolders(),
      ),
    requestFolderIndex: (folderId: string) =>
      withSessionOperation(
        activeConnectOptions,
        (session) => session.remoteFs.requestFolderIndex(folderId),
      ),
    setFocusedFolder: (folderId: string | null) => {
      focusedFolderId = folderId;
      if (activeSession && !activeSession.isClosed()) {
        activeSession.remoteFs.setFocusedFolder(folderId);
      }
    },
    waitForFolderIndex: (folderId: string, timeoutMs?: number, pollMs?: number) =>
      withSessionOperation(
        activeConnectOptions,
        (session) => session.remoteFs.waitForFolderIndex(folderId, timeoutMs, pollMs),
      ),
    readDir: (folderId: string, path: string) =>
      withSessionOperation(
        activeConnectOptions,
        (session) => session.remoteFs.readDir(folderId, path),
      ),
    readFileFully: (
      folderId: string,
      path: string,
      onProgress?: (progress: FileDownloadProgress) => void,
    ) =>
      withSessionOperation(
        activeConnectOptions,
        (session) => session.remoteFs.readFileFully(
          folderId,
          path,
          withSessionTransportProgress(session, onProgress),
        ),
      ),
    readFileToSink: (
      folderId: string,
      path: string,
      sink: FileDownloadSink,
      onProgress?: (progress: FileDownloadProgress) => void,
    ) =>
      withSessionOperation(
        activeConnectOptions,
        (session) => session.remoteFs.readFileToSink(
          folderId,
          path,
          sink,
          withSessionTransportProgress(session, onProgress),
        ),
      ),
    writeFileFully: (
      folderId: string,
      path: string,
      bytes: Uint8Array,
      options?: { modifiedMs?: number },
    ) =>
      withSessionOperation(
        activeConnectOptions,
        (session) => session.remoteFs.writeFileFully(folderId, path, bytes, options),
      ),
  };

  return {
    connectAndSync: async (connectOptions: ConnectOptions): Promise<RemoteFsLike> => {
      await ensureSession(connectOptions);
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
      sessionGeneration += 1;
      activeConnectOptions = null;
      focusedFolderId = null;
      await closeActiveSession();
    },
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
    startTransfer: platformAdapter.startTransfer
      ? (label) => platformAdapter.startTransfer!(label)
      : undefined,
    stopTransfer: platformAdapter.stopTransfer
      ? () => platformAdapter.stopTransfer!()
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
