import type {
  CachedFileRecord,
  CachedFileStatus,
  FavoriteRecord,
  IdentityRecoveryExportResponse,
  SyncpeerDiscoveryFetchInit,
  SyncpeerDiscoveryResponse,
  SyncpeerHostAdapter,
  SyncpeerPlatformAdapter,
  SyncpeerTlsSocket,
} from "@syncpeer/core/browser";

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

interface DiscoveryFetchResponsePayload {
  status: number;
  body: string;
}

interface DiscoveryLocalRequestPayload {
  expectedDeviceId?: string | null;
  timeoutMs?: number | null;
}

interface DiscoveryLocalCandidatePayload {
  address: string;
  protocol: "tcp" | "relay" | "unknown" | string;
  host?: string | null;
  port?: number | null;
}

interface DiscoveryLocalResponsePayload {
  candidates: DiscoveryLocalCandidatePayload[];
}

export interface UiLogEntry {
  timestampMs: number;
  level: "info" | "error";
  event: string;
  details?: unknown;
}

export interface CreateTauriAdaptersOptions {
  onLog?: (entry: UiLogEntry) => void;
}

const emitLog = (
  options: CreateTauriAdaptersOptions | undefined,
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
  options: CreateTauriAdaptersOptions | undefined,
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
  options: CreateTauriAdaptersOptions | undefined,
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
        logUi(options, "tauri.invoke.success", {
          command,
          durationMs: Date.now() - startedAt,
        });
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

const createTlsSocket = (invoke: InvokeFn, sessionId: number, peerCertificateDer: Uint8Array): SyncpeerTlsSocket => ({
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
});

export const createTauriAdapters = (
  options?: CreateTauriAdaptersOptions,
): { hostAdapter: SyncpeerHostAdapter; platformAdapter: SyncpeerPlatformAdapter } => {
  let invoke: InvokeFn | null = null;
  const invokeWithLogging: InvokeFn = <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!invoke) {
      invoke = createLoggedInvoke(resolveInvoke(), options);
    }
    return invoke<T>(command, args);
  };

  const hostAdapter: SyncpeerHostAdapter = {
    connectTls: async ({ host, port, certPem, keyPem, caPem }) => {
      const opened = await invokeWithLogging<TlsOpenResponse>("syncpeer_tls_open", {
        request: { host, port, certPem, keyPem, caPem: caPem ?? null },
      });
      const sessionId = Number(opened.sessionId);
      return createTlsSocket(
        invokeWithLogging,
        sessionId,
        new Uint8Array(opened.peerCertificateDer),
      );
    },
    connectRelay: async ({ relayAddress, expectedDeviceId, certPem, keyPem, caPem }) => {
      const opened = await invokeWithLogging<RelayOpenResponse>("syncpeer_relay_open", {
        request: {
          relayAddress,
          expectedDeviceId,
          certPem,
          keyPem,
          caPem: caPem ?? null,
        },
      });
      const sessionId = Number(opened.sessionId);
      return {
        connectedVia: opened.connectedVia || relayAddress,
        socket: createTlsSocket(
          invokeWithLogging,
          sessionId,
          new Uint8Array(opened.peerCertificateDer),
        ),
      };
    },
    sha256: async (data: Uint8Array) => {
      const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
      return new Uint8Array(digest);
    },
    randomBytes: (length: number) => {
      const output = new Uint8Array(length);
      crypto.getRandomValues(output);
      return output;
    },
    discoveryFetch: async (input: string | URL, init?: SyncpeerDiscoveryFetchInit): Promise<SyncpeerDiscoveryResponse> => {
      const payload = await invokeWithLogging<DiscoveryFetchResponsePayload>("syncpeer_discovery_fetch", {
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
    discoverLocalCandidates: async ({ expectedDeviceId, timeoutMs }) => {
      const payload = await invokeWithLogging<DiscoveryLocalResponsePayload>("syncpeer_discovery_local", {
        request: {
          expectedDeviceId: expectedDeviceId || null,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
        } as DiscoveryLocalRequestPayload,
      });
      return (payload.candidates ?? [])
        .filter((candidate) => typeof candidate?.address === "string" && candidate.address.trim() !== "")
        .map((candidate) => ({
          address: candidate.address.trim(),
          protocol:
            candidate.protocol === "tcp" || candidate.protocol === "relay"
              ? candidate.protocol
              : "unknown",
          host: candidate.host ?? undefined,
          port: Number.isFinite(candidate.port) ? Number(candidate.port) : undefined,
        }));
    },
    log: (event, details) => logUi(options, event, details),
  };

  const platformAdapter: SyncpeerPlatformAdapter = {
    readTextFile: async (path: string): Promise<string> =>
      invokeWithLogging<string>("syncpeer_read_text_file", { request: { path } }),
    readBinaryFile: async (path: string): Promise<Uint8Array> => {
      const bytes = await invokeWithLogging<number[]>("syncpeer_read_binary_file", {
        request: { path },
      });
      return new Uint8Array(bytes);
    },
    readDefaultIdentity: async (): Promise<CliNodeIdentityResponse> =>
      invokeWithLogging<CliNodeIdentityResponse>("syncpeer_read_default_cli_identity"),
    listFavorites: async (): Promise<FavoriteRecord[]> =>
      invokeWithLogging<FavoriteRecord[]>("syncpeer_list_favorites"),
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
    listCachedFiles: async (): Promise<CachedFileRecord[]> =>
      invokeWithLogging<CachedFileRecord[]>("syncpeer_list_cached_files"),
    openCachedFile: async (folderId: string, path: string): Promise<void> =>
      invokeWithLogging("syncpeer_open_cached_file", { request: { folderId, path } }),
    openCachedFileDirectory: async (folderId: string, path: string): Promise<void> =>
      invokeWithLogging("syncpeer_open_cached_file_directory", { request: { folderId, path } }),
    openCachedDirectory: async (folderId: string, path: string): Promise<void> =>
      invokeWithLogging("syncpeer_open_cached_directory", { request: { folderId, path } }),
    removeCachedFile: async (folderId: string, path: string): Promise<boolean> =>
      invokeWithLogging<boolean>("syncpeer_remove_cached_file", { request: { folderId, path } }),
    clearCache: async (): Promise<void> => invokeWithLogging("syncpeer_clear_cache"),
    getAndroidSafTreeUri: async (): Promise<string | null> =>
      invokeWithLogging<string | null>("syncpeer_get_android_saf_tree_uri"),
    pickAndroidSafDirectory: async (): Promise<string> =>
      invokeWithLogging<string>("syncpeer_android_pick_saf_directory"),
    setAndroidSafTreeUri: async (treeUri?: string | null): Promise<string | null> =>
      invokeWithLogging<string | null>("syncpeer_set_android_saf_tree_uri", {
        request: { treeUri: treeUri ?? null },
      }),
    listAndroidPersistedSafUris: async (): Promise<string[]> =>
      invokeWithLogging<string[]>("syncpeer_android_list_persisted_saf_uris"),
    exportIdentityRecovery: async (): Promise<IdentityRecoveryExportResponse> =>
      invokeWithLogging<IdentityRecoveryExportResponse>("syncpeer_export_identity_recovery"),
    restoreIdentityRecovery: async (recoverySecret: string): Promise<void> => {
      await invokeWithLogging<CliNodeIdentityResponse>("syncpeer_restore_identity_recovery", {
        request: { recoverySecret },
      });
    },
    getDefaultDeviceId: async (): Promise<string> =>
      invokeWithLogging<string>("syncpeer_get_default_device_id"),
    regenerateDefaultIdentity: async (): Promise<string> =>
      invokeWithLogging<string>("syncpeer_regenerate_default_cli_identity"),
    logError: async (event: string, details: Record<string, unknown>): Promise<void> => {
      await tryForwardUiErrorToCli(invokeWithLogging, event, details);
    },
  };

  return { hostAdapter, platformAdapter };
};

export const reportUiError = (
  event: string,
  error: unknown,
  context?: unknown,
) => {
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
