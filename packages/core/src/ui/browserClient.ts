import { createSyncpeerCoreClient, type SyncpeerHostAdapter, type SyncpeerSessionHandle } from "../client.ts";
import type { FileDownloadProgress, FileEntry, FolderInfo, FolderSyncState, RemoteDeviceInfo } from "../core/model/remoteFs.ts";

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

export interface RemoteFsLike {
  listFolders: () => Promise<FolderInfo[]>;
  readDir: (folderId: string, path: string) => Promise<FileEntry[]>;
  readFileFully: (
    folderId: string,
    path: string,
    onProgress?: (progress: FileDownloadProgress) => void,
  ) => Promise<Uint8Array>;
}

export interface ConnectionOverview {
  folders: FolderInfo[];
  device: RemoteDeviceInfo | null;
  folderSyncStates: FolderSyncState[];
  connectedVia: string;
  transportKind: "direct-tcp" | "relay";
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

export interface SyncpeerPlatformAdapter {
  readTextFile?: (path: string) => Promise<string>;
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
  exportIdentityRecovery: () => Promise<IdentityRecoveryExportResponse>;
  restoreIdentityRecovery: (recoverySecret: string) => Promise<void>;
  getDefaultDeviceId: () => Promise<string>;
  regenerateDefaultIdentity: () => Promise<string>;
}

const SYNCTHING_DISCOVERY_ORIGIN = "https://discovery.syncthing.net";
const SYNCTHING_DISCOVERY_SERVER_PIN =
  "LYXKCHX-VI3NYZR-ALCJBHF-WMZYSPK-QG6QJA3-MPFYMSO-U56GTUK-NA2MIAW";
const DEFAULT_DISCOVERY_SERVER =
  `${SYNCTHING_DISCOVERY_ORIGIN}/v2/?id=${SYNCTHING_DISCOVERY_SERVER_PIN}`;

export const getDefaultDiscoveryServer = (): string => DEFAULT_DISCOVERY_SERVER;

export const normalizeDiscoveryServer = (value: string | undefined): string => {
  const raw = (value ?? "").trim();
  if (raw === "") return DEFAULT_DISCOVERY_SERVER;

  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return DEFAULT_DISCOVERY_SERVER;
  }

  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = "/v2/";
  }
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }

  const isOfficialSyncthingDiscovery =
    parsed.protocol === "https:" &&
    parsed.hostname === "discovery.syncthing.net" &&
    parsed.pathname === "/v2/";

  if (isOfficialSyncthingDiscovery && !parsed.searchParams.get("id")) {
    parsed.searchParams.set("id", SYNCTHING_DISCOVERY_SERVER_PIN);
  }

  return parsed.toString();
};

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
      options.hostAdapter.log?.(event, details);
      logClient(options.onLog, event, details);
    },
  };
  const coreClient = createSyncpeerCoreClient(coreAdapter);

  let cachedDefaultIdentity: SyncpeerIdentityRecord | null = null;
  let activeSession: SyncpeerSessionHandle | null = null;
  let activeConnectionKey: string | null = null;
  let openingSession: Promise<SyncpeerSessionHandle> | null = null;
  let openingConnectionKey: string | null = null;

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
        folderPasswords: normalized.folderPasswords,
      });
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

  const requireActiveSession = async (): Promise<SyncpeerSessionHandle> => {
    if (!activeSession) throw new Error("No active connection. Connect first.");
    return activeSession;
  };

  const getSessionForPolling = async (
    connectOptions: ConnectOptions,
  ): Promise<SyncpeerSessionHandle> => {
    if (activeSession && !activeSession.isClosed()) {
      return activeSession;
    }
    return ensureSession(connectOptions);
  };

  const remoteFsLike: RemoteFsLike = {
    listFolders: async () => (await requireActiveSession()).remoteFs.listFolders(),
    readDir: async (folderId: string, path: string) =>
      (await requireActiveSession()).remoteFs.readDir(folderId, path),
    readFileFully: async (
      folderId: string,
      path: string,
      onProgress?: (progress: FileDownloadProgress) => void,
    ) => (await requireActiveSession()).remoteFs.readFileFully(folderId, path, onProgress),
  };

  return {
    connectAndSync: async (connectOptions: ConnectOptions): Promise<RemoteFsLike> => {
      await ensureSession(connectOptions);
      return remoteFsLike;
    },
    connectAndGetOverview: async (
      connectOptions: ConnectOptions,
    ): Promise<ConnectionOverview> => {
      const session = await ensureSession(connectOptions);
      return toConnectionOverview(session);
    },
    connectAndGetFolderVersions: async (
      connectOptions: ConnectOptions,
    ): Promise<FolderSyncState[]> => {
      const session = await getSessionForPolling(connectOptions);
      return Promise.resolve(session.remoteFs.listFolderSyncStates?.() ?? []);
    },
    disconnect: async (): Promise<void> => {
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
  };
};
