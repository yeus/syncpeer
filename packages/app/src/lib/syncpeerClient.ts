import { createSyncpeerCoreClient, type SyncpeerDiscoveryFetchInit, type SyncpeerDiscoveryResponse, type SyncpeerHostAdapter, type SyncpeerSessionHandle } from "@syncpeer/core/browser";
import type { FileDownloadProgress, FileEntry, FolderInfo, FolderSyncState, RemoteDeviceInfo } from "@syncpeer/core/browser";

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

export interface CreateSyncpeerUiClientOptions {
  onLog?: (entry: UiLogEntry) => void;
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
  localPath: string;
  sizeBytes: number;
  cachedAtMs: number;
  modifiedMs?: number;
}

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriV2Global {
  core?: {
    invoke?: unknown;
  };
}

interface TauriInternalGlobal {
  invoke?: unknown;
}

interface TlsOpenResponse {
  sessionId: number;
  peerCertificateDer: number[];
}

interface RelayOpenResponse {
  sessionId: number;
  peerCertificateDer: number[];
  connectedVia: string;
}

interface TlsReadResponse {
  bytes: number[];
  eof?: boolean;
}

interface CliNodeIdentityResponse {
  certPath: string;
  keyPath: string;
  certPem: string;
  keyPem: string;
}

interface IdentityRecoveryExportResponse {
  deviceId: string;
  recoverySecret: string;
}

interface DiscoveryFetchResponsePayload {
  status: number;
  body: string;
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
  options: CreateSyncpeerUiClientOptions | undefined,
  level: "info" | "error",
  event: string,
  details?: unknown,
) => {
  options?.onLog?.({
    timestampMs: Date.now(),
    level,
    event,
    details,
  });
};

const logUi = (
  options: CreateSyncpeerUiClientOptions | undefined,
  event: string,
  details?: unknown,
) => {
  emitLog(options, "info", event, details);
  if (details !== undefined) {
    console.log(`[syncpeer-ui] ${event}`, details);
    return;
  }
  console.log(`[syncpeer-ui] ${event}`);
};

const resolveInvoke = (): InvokeFn => {
  const tauri = (globalThis as { __TAURI__?: TauriV2Global }).__TAURI__;
  const v2Invoke = tauri?.core?.invoke;
  if (typeof v2Invoke === "function") {
    return v2Invoke as InvokeFn;
  }

  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternalGlobal }).__TAURI_INTERNALS__;
  const internalInvoke = internals?.invoke;
  if (typeof internalInvoke === "function") {
    return internalInvoke as InvokeFn;
  }

  throw new Error("Tauri runtime is unavailable. Launch this app through Tauri (npm run dev -w @syncpeer/tauri-shell).");
};

const tryForwardUiErrorToCli = async (
  invoke: InvokeFn,
  event: string,
  details: Record<string, unknown>,
): Promise<void> => {
  try {
    await invoke<void>("syncpeer_log_ui_error", { event, details });
  } catch {
    // Ignore forwarding failures to avoid masking the original UI error.
  }
};

const createLoggedInvoke = (
  invoke: InvokeFn,
  options: CreateSyncpeerUiClientOptions | undefined,
): InvokeFn => {
  const noisyCommands = new Set(["syncpeer_tls_read", "syncpeer_tls_write"]);
  return async <T>(command: string, args?: Record<string, unknown>) => {
    const startedAt = Date.now();
    const shouldLogLifecycle = !noisyCommands.has(command);
    if (shouldLogLifecycle) {
      logUi(options, "tauri.invoke.start", { command });
    }
    try {
      const result = await invoke<T>(command, args);
      if (shouldLogLifecycle) {
        logUi(options, "tauri.invoke.success", { command, durationMs: Date.now() - startedAt });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[syncpeer-ui] tauri.invoke.error ${command}`, error);
      emitLog(options, "error", "tauri.invoke.error", { command, message });
      void tryForwardUiErrorToCli(invoke, "tauri.invoke.error", { command, message });
      throw error;
    }
  };
};

export const reportUiError = (event: string, error: unknown, context?: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedContext =
    context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  console.error(`[syncpeer-ui] ${event}`, { message, ...normalizedContext });
  try {
    const invoke = resolveInvoke();
    void tryForwardUiErrorToCli(invoke, event, { message, ...normalizedContext });
  } catch {
    // App might be running outside Tauri.
  }
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
});

const maybeInlinePem = (value: string | undefined): string | null => {
  if (!value) return null;
  if (value.includes("-----BEGIN CERTIFICATE-----") || value.includes("-----BEGIN PRIVATE KEY-----") || value.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    return value;
  }
  return null;
};

const resolvePemValue = async (invoke: InvokeFn, label: "cert" | "key", value: string | undefined): Promise<string> => {
  if (!value) {
    throw new Error(`Missing ${label}. Provide PEM text or a readable file path.`);
  }
  const inline = maybeInlinePem(value);
  if (inline) return inline;
  return invoke<string>("syncpeer_read_text_file", { request: { path: value } });
};

const createDiscoveryResponseFromPayload = (
  payload: DiscoveryFetchResponsePayload,
): SyncpeerDiscoveryResponse => ({
  ok: payload.status >= 200 && payload.status < 300,
  status: payload.status,
  async text(): Promise<string> {
    return payload.body;
  },
  async json(): Promise<unknown> {
    return JSON.parse(payload.body);
  },
});

const createTauriHostAdapter = (
  invoke: InvokeFn,
  options: CreateSyncpeerUiClientOptions | undefined,
): SyncpeerHostAdapter => ({
  connectTls: async ({ host, port, certPem, keyPem, caPem }) => {
    const opened = await invoke<TlsOpenResponse>("syncpeer_tls_open", {
      request: { host, port, certPem, keyPem, caPem: caPem ?? null },
    });
    const sessionId = Number(opened.sessionId);
    const peerCertificateDer = new Uint8Array(opened.peerCertificateDer);
    return {
      peerCertificateDer: async () => peerCertificateDer,
      read: async (maxBytes?: number) => {
        const response = await invoke<TlsReadResponse>("syncpeer_tls_read", {
          request: { sessionId, maxBytes: Number.isFinite(maxBytes) ? maxBytes : null },
        });
        if (response.eof) {
          throw new Error("Connection closed");
        }
        return new Uint8Array(response.bytes);
      },
      write: async (bytes: Uint8Array) => {
        await invoke<void>("syncpeer_tls_write", {
          request: { sessionId, bytes: Array.from(bytes) },
        });
      },
      close: async () => {
        await invoke<void>("syncpeer_tls_close", {
          request: { sessionId },
        });
      },
    };
  },
  connectRelay: async ({ relayAddress, expectedDeviceId, certPem, keyPem, caPem }) => {
    const opened = await invoke<RelayOpenResponse>("syncpeer_relay_open", {
      request: {
        relayAddress,
        expectedDeviceId,
        certPem,
        keyPem,
        caPem: caPem ?? null,
      },
    });
    const sessionId = Number(opened.sessionId);
    const peerCertificateDer = new Uint8Array(opened.peerCertificateDer);
    return {
      connectedVia: opened.connectedVia || relayAddress,
      socket: {
        peerCertificateDer: async () => peerCertificateDer,
        read: async (maxBytes?: number) => {
          const response = await invoke<TlsReadResponse>("syncpeer_tls_read", {
            request: { sessionId, maxBytes: Number.isFinite(maxBytes) ? maxBytes : null },
          });
          if (response.eof) {
            throw new Error("Connection closed");
          }
          return new Uint8Array(response.bytes);
        },
        write: async (bytes: Uint8Array) => {
          await invoke<void>("syncpeer_tls_write", {
            request: { sessionId, bytes: Array.from(bytes) },
          });
        },
        close: async () => {
          await invoke<void>("syncpeer_tls_close", {
            request: { sessionId },
          });
        },
      },
    };
  },
  sha256: async (data: Uint8Array) => {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(digest);
  },
  randomBytes: (length: number) => {
    const output = new Uint8Array(length);
    crypto.getRandomValues(output);
    return output;
  },
  discoveryFetch: async (input: string | URL, init?: SyncpeerDiscoveryFetchInit): Promise<SyncpeerDiscoveryResponse> => {
    const payload = await invoke<DiscoveryFetchResponsePayload>("syncpeer_discovery_fetch", {
      request: {
        url: String(input),
        method: init?.method ?? "GET",
        headers: init?.headers ?? {},
        pinServerDeviceId: init?.pinServerDeviceId ?? null,
        allowInsecureTls: !!init?.allowInsecureTls,
      },
    });
    return createDiscoveryResponseFromPayload(payload);
  },
  log: (event, details) => logUi(options, event, details),
});

const serializeConnectionKey = (options: ConnectOptions, certPem: string, keyPem: string): string =>
  JSON.stringify({
    host: options.host,
    port: options.port,
    discoveryMode: options.discoveryMode ?? "global",
    discoveryServer: normalizeDiscoveryServer(options.discoveryServer),
    remoteId: options.remoteId ?? "",
    deviceName: options.deviceName,
    certPem,
    keyPem,
  });

const toConnectionOverview = async (session: SyncpeerSessionHandle): Promise<ConnectionOverview> => {
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

export const createSyncpeerUiClient = (options?: CreateSyncpeerUiClientOptions) => {
  let invoke: InvokeFn | null = null;
  let cachedDefaultIdentity: CliNodeIdentityResponse | null = null;
  const invokeWithLogging: InvokeFn = <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!invoke) {
      invoke = createLoggedInvoke(resolveInvoke(), options);
    }
    return invoke<T>(command, args);
  };
  const resolveDefaultIdentity = async (): Promise<CliNodeIdentityResponse> => {
    if (cachedDefaultIdentity) return cachedDefaultIdentity;
    const identity = await invokeWithLogging<CliNodeIdentityResponse>("syncpeer_read_default_cli_identity");
    cachedDefaultIdentity = identity;
    return identity;
  };
  const coreClient = createSyncpeerCoreClient(createTauriHostAdapter(invokeWithLogging, options));
  let activeSession: SyncpeerSessionHandle | null = null;
  let activeConnectionKey: string | null = null;

  const closeActiveSession = async (): Promise<void> => {
    const previous = activeSession;
    activeSession = null;
    activeConnectionKey = null;
    if (previous) {
      await previous.close();
    }
  };

  const ensureSession = async (options: ConnectOptions): Promise<SyncpeerSessionHandle> => {
    const normalized = normalizeConnectOptions(options);
    let certPem: string | null = null;
    let keyPem: string | null = null;
    let defaultIdentityError: string | null = null;

    if (normalized.cert) {
      certPem = await resolvePemValue(invokeWithLogging, "cert", normalized.cert);
    }
    if (normalized.key) {
      keyPem = await resolvePemValue(invokeWithLogging, "key", normalized.key);
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
      throw new Error("Missing cert. Provide PEM text or a readable file path. On Android, open Devices > Connection Settings and paste a cert PEM if no persisted identity exists.");
    }
    if (!keyPem) {
      if (defaultIdentityError) {
        throw new Error(`Missing key. Provide PEM text or a readable file path. Default identity lookup failed: ${defaultIdentityError}`);
      }
      throw new Error("Missing key. Provide PEM text or a readable file path. On Android, open Devices > Connection Settings and paste a key PEM if no persisted identity exists.");
    }
    const key = serializeConnectionKey(normalized, certPem, keyPem);
    if (activeSession && activeConnectionKey === key) {
      return activeSession;
    }
    await closeActiveSession();
    activeSession = await coreClient.openSession({
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
    });
    activeConnectionKey = key;
    return activeSession;
  };

  const requireActiveSession = async (): Promise<SyncpeerSessionHandle> => {
    if (!activeSession) throw new Error("No active connection. Connect first.");
    return activeSession;
  };

  const remoteFsLike: RemoteFsLike = {
    listFolders: async () => (await requireActiveSession()).remoteFs.listFolders(),
    readDir: async (folderId: string, path: string) => (await requireActiveSession()).remoteFs.readDir(folderId, path),
    readFileFully: async (folderId: string, path: string, onProgress?: (progress: FileDownloadProgress) => void) =>
      (await requireActiveSession()).remoteFs.readFileFully(folderId, path, onProgress),
  };

  return {
    connectAndSync: async (options: ConnectOptions): Promise<RemoteFsLike> => {
      await ensureSession(options);
      return remoteFsLike;
    },
    connectAndGetOverview: async (options: ConnectOptions): Promise<ConnectionOverview> => {
      const session = await ensureSession(options);
      return toConnectionOverview(session);
    },
    connectAndGetFolderVersions: async (options: ConnectOptions): Promise<FolderSyncState[]> => {
      const session = await ensureSession(options);
      return Promise.resolve(session.remoteFs.listFolderSyncStates?.() ?? []);
    },
    disconnect: async (): Promise<void> => {
      await closeActiveSession();
    },
    listFavorites: async (): Promise<FavoriteRecord[]> => invokeWithLogging<FavoriteRecord[]>("syncpeer_list_favorites"),
    upsertFavorite: async (favorite: FavoriteRecord): Promise<FavoriteRecord[]> =>
      invokeWithLogging<FavoriteRecord[]>("syncpeer_upsert_favorite", { request: { favorite } }),
    removeFavorite: async (key: string): Promise<FavoriteRecord[]> =>
      invokeWithLogging<FavoriteRecord[]>("syncpeer_remove_favorite", { request: { key } }),
    cacheFile: async (
      folderId: string,
      path: string,
      name: string,
      bytes: Uint8Array,
      modifiedMs?: number,
    ): Promise<void> => {
      await invokeWithLogging("syncpeer_cache_file", {
        request: { folderId, path, name, bytes: Array.from(bytes), modifiedMs: modifiedMs ?? null },
      });
    },
    getCachedStatuses: async (folderId: string, paths: string[]): Promise<CachedFileStatus[]> =>
      invokeWithLogging<CachedFileStatus[]>("syncpeer_get_cached_statuses", { request: { folderId, paths } }),
    listCachedFiles: async (): Promise<CachedFileRecord[]> => invokeWithLogging<CachedFileRecord[]>("syncpeer_list_cached_files"),
    openCachedFile: async (folderId: string, path: string): Promise<void> =>
      invokeWithLogging("syncpeer_open_cached_file", { request: { folderId, path } }),
    removeCachedFile: async (folderId: string, path: string): Promise<boolean> =>
      invokeWithLogging<boolean>("syncpeer_remove_cached_file", { request: { folderId, path } }),
    clearCache: async (): Promise<void> => invokeWithLogging("syncpeer_clear_cache"),
    exportIdentityRecovery: async (): Promise<IdentityRecoveryExportResponse> =>
      invokeWithLogging<IdentityRecoveryExportResponse>("syncpeer_export_identity_recovery"),
    restoreIdentityRecovery: async (recoverySecret: string): Promise<void> => {
      await invokeWithLogging<CliNodeIdentityResponse>("syncpeer_restore_identity_recovery", {
        request: { recoverySecret },
      });
      cachedDefaultIdentity = null;
    },
  };
};
