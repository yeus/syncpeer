import type {
  CachedFileDigest,
  CachedFileRecord,
  CachedFileStatus,
  FavoriteRecord,
  IdentityRecoveryExportResponse,
  SyncpeerDiscoveryFetchInit,
  SyncpeerDiscoveryResponse,
  SyncpeerHostAdapter,
  SyncpeerPlatformAdapter,
  SyncpeerTlsSocket,
  ConnectOptions,
  SyncpeerProfileSettings,
  FileDownloadSink,
} from "@syncpeer/core/browser";
import { createDocumentCache, createDocumentFilesystem, createNativeFilesystem,
  changesSessionConfiguration, dispatchDocumentCommand } from "@syncpeer/core/filesystem";
import { detectRuntimeEnvironment, detectRuntimePlatform, type RuntimePlatform } from "./runtimeInfo.ts";
import { createWorkerPasswordKdf } from "./passwordKdf.ts";
import { sanitizeDiagnosticArtifact } from "../../../shared/modules/diagnosticSanitizer.ts";

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

interface TlsListenResponse {
  listenerId: number;
  port: number;
}

interface TlsAcceptResponse extends TlsOpenResponse {
  remoteAddress: string;
  remotePort: number;
  alpn: string;
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
  deviceId?: string | null;
}

interface DiscoveryLocalResponsePayload {
  candidates: DiscoveryLocalCandidatePayload[];
  diagnostics?: {
    timeoutMs?: number;
    socketsBound?: number;
    bindErrors?: string[];
    packetsReceived?: number;
    packetsBySocketUdp4?: number;
    packetsBySocketUdp6?: number;
    packetsMagicMismatch?: number;
    packetsDecodeFailed?: number;
    packetsMissingId?: number;
    packetsFilteredExpectedId?: number;
    announcementsAccepted?: number;
    discoveredDeviceIds?: string[];
    syncthingLanAvailable?: boolean;
    syncpeerLanActive?: boolean;
    statusMessage?: string;
  };
}

export interface UiLogEntry {
  timestampMs: number;
  level: "info" | "error";
  event: string;
  details?: unknown;
}

export interface CreateTauriAdaptersOptions {
  onLog?: (entry: UiLogEntry) => void;
  runtimePlatform?: RuntimePlatform;
}

const emitLog = (
  options: CreateTauriAdaptersOptions | undefined,
  level: "info" | "error",
  event: string,
  details?: unknown,
) => {
  const safeEvent = /^[a-zA-Z0-9._-]{1,128}$/.test(event) ? event : "invalid";
  options?.onLog?.({
    timestampMs: Date.now(),
    level,
    event: safeEvent,
    details: details === undefined ? undefined : sanitizeDiagnosticArtifact(details),
  });
};

const logUi = (
  options: CreateTauriAdaptersOptions | undefined,
  event: string,
  details?: unknown,
) => {
  emitLog(options, "info", event, details);
  const safeEvent = /^[a-zA-Z0-9._-]{1,128}$/.test(event) ? event : "invalid";
  const safeDetails = details === undefined ? undefined : sanitizeDiagnosticArtifact(details);
  if (safeDetails !== undefined) {
    console.log(`[syncpeer-ui] ${safeEvent}`, safeDetails);
    return;
  }
  console.log(`[syncpeer-ui] ${safeEvent}`);
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
    const safeEvent = /^[a-zA-Z0-9._-]{1,128}$/.test(event) ? event : "invalid";
    await invoke<void>("syncpeer_log_ui_error", {
      event: safeEvent,
      details: sanitizeDiagnosticArtifact(details),
    });
  } catch {
    // Ignore forwarding failures to avoid masking the original UI error.
  }
};

export const shouldLogInvokeLifecycle = (command: string): boolean =>
  command !== "syncpeer_tls_read" && command !== "syncpeer_tls_write" &&
  command !== "syncpeer_replica_storage";

const createLoggedInvoke = (
  invoke: InvokeFn,
  options: CreateTauriAdaptersOptions | undefined,
): InvokeFn => {
  return async <T>(command: string, args?: Record<string, unknown>) => {
    const startedAt = Date.now();
    const shouldLogLifecycle = shouldLogInvokeLifecycle(command);
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
      console.error("[syncpeer-ui] tauri.invoke.error", { command });
      emitLog(options, "error", "tauri.invoke.error", { command });
      void tryForwardUiErrorToCli(invoke, "tauri.invoke.error", { command });
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

const createTlsSocket = (
  invoke: InvokeFn,
  sessionId: number,
  peerCertificateDer: Uint8Array,
  commandPrefix = "syncpeer_tls",
): SyncpeerTlsSocket => ({
  peerCertificateDer: async () => peerCertificateDer,
  read: async (maxBytes?: number) => {
    const response = await invoke<TlsReadResponse>(`${commandPrefix}_read`, {
      request: { sessionId, maxBytes: Number.isFinite(maxBytes) ? maxBytes : null },
    });
    if (response.eof) {
      throw new Error("Connection closed");
    }
    return new Uint8Array(response.bytes);
  },
  write: async (bytes: Uint8Array) => {
    await invoke<void>(`${commandPrefix}_write`, {
      request: { sessionId, bytes: Array.from(bytes) },
    });
  },
  close: async () => {
    await invoke<void>(`${commandPrefix}_close`, {
      request: { sessionId },
    });
  },
});

export const createTauriAdapters = (
  options?: CreateTauriAdaptersOptions,
) => {
  let invoke: InvokeFn | null = null;
  let multicastLockPrepared = false;
  let localDiscoveryQueue = Promise.resolve();
  const invokeWithLogging: InvokeFn = <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!invoke) {
      invoke = createLoggedInvoke(resolveInvoke(), options);
    }
    return invoke<T>(command, args);
  };
  const platform = options?.runtimePlatform ?? detectRuntimePlatform();
  let sessionConfigurationRevision = 0;
  const sessionConfigurationListeners = new Set<() => void>();
  const invalidateSessionConfiguration = () => {
    sessionConfigurationRevision++;
    for (const listener of sessionConfigurationListeners) listener();
  };
  const desktopDocuments = (() => {
    let owner: Promise<ReturnType<typeof createDocumentFilesystem>> | undefined;
    return () => owner ??= (async () => {
      const root = async (storageId: string) => invokeWithLogging<string>("syncpeer_profile_storage_root",
        { request: { profileId: "documents", storageId } });
      const storage = async (storageId: string) => createNativeFilesystem(
        request => invokeWithLogging("syncpeer_replica_storage", { request }), await root(storageId));
      const deviceId = await invokeWithLogging<string>("syncpeer_get_default_device_id");
      let counter = 0xcbf29ce484222325n;
      for (const byte of new TextEncoder().encode(deviceId)) {
        counter = BigInt.asUintN(64, (counter ^ BigInt(byte)) * 0x100000001b3n);
      }
      const documents = createDocumentFilesystem({ profileId: "documents", deviceCounterId: counter.toString(),
        profile: await storage("profile"), openStorage: storage,
        availableBytes: () => invokeWithLogging<number>("syncpeer_profile_available_bytes"),
        rememberedSecret: {
          load: () => invokeWithLogging<string | null>("syncpeer_vault_secret",
            { request: { profileId: "documents", operation: "load", secret: null } }),
          save: secret => invokeWithLogging("syncpeer_vault_secret",
            { request: { profileId: "documents", operation: "save", secret } }),
          remove: () => invokeWithLogging("syncpeer_vault_secret",
            { request: { profileId: "documents", operation: "remove", secret: null } }),
          isDeviceUnlocked: () => invokeWithLogging<boolean>("syncpeer_vault_secret",
            { request: { profileId: "documents", operation: "isDeviceUnlocked", secret: null } }),
        },
        randomBytes: size => crypto.getRandomValues(new Uint8Array(size)),
        kdf: createWorkerPasswordKdf(),
        onDiagnostic: (event, details) => logUi(options, event, details),
      });
      await documents.initialize();
      return documents;
    })();
  })();
  const documentRequest = async <T>(request: Record<string, unknown>) => {
    if (platform === "android") {
      const response = await invokeWithLogging<{ result: T }>("syncpeer_document_command", { request });
      return response.result;
    }
    const documents = await desktopDocuments();
    if (changesSessionConfiguration(request.operation, request.path)) invalidateSessionConfiguration();
    return await dispatchDocumentCommand(documents, request) as T;
  };

  const hostAdapter: SyncpeerHostAdapter = {
    kdf: createWorkerPasswordKdf(),
    connectTls: async ({ host, port, certPem, keyPem, caPem, timeoutMs, signal, alpnProtocols }) => {
      const opened = await invokeWithLogging<TlsOpenResponse>("syncpeer_tls_open", {
        request: {
          host,
          port,
          certPem,
          keyPem,
          caPem: caPem ?? null,
          timeoutMs: timeoutMs ?? null,
          alpnProtocols: [...alpnProtocols ?? ["bep/1.0"]],
        },
      });
      const sessionId = Number(opened.sessionId);
      if (signal?.aborted) {
        await invokeWithLogging("syncpeer_tls_close", { request: { sessionId } });
        throw new DOMException("Connection attempt was cancelled.", "AbortError");
      }
      return createTlsSocket(
        invokeWithLogging,
        sessionId,
        new Uint8Array(opened.peerCertificateDer),
      );
    },
    listenTls: async ({ host, port, certPem, keyPem, alpnProtocols, handshakeTimeoutMs }) => {
      const opened = await invokeWithLogging<TlsListenResponse>("syncpeer_tls_listen", {
        request: { host, port, certPem, keyPem, alpnProtocols: [...alpnProtocols],
          handshakeTimeoutMs: handshakeTimeoutMs ?? null },
      });
      return createNativeTlsListener(invokeWithLogging, opened);
    },
    listenRelay: async ({ relayAddress, certPem, keyPem, alpnProtocols, handshakeTimeoutMs }) => {
      const opened = await invokeWithLogging<TlsListenResponse>("syncpeer_relay_listen", {
        request: { relayAddress, certPem, keyPem, alpnProtocols: [...alpnProtocols],
          handshakeTimeoutMs: handshakeTimeoutMs ?? null },
      });
      return createNativeTlsListener(invokeWithLogging, opened);
    },
    connectQuic: async ({
      host,
      port,
      certPem,
      keyPem,
      caPem,
      timeoutMs,
      keepaliveMs,
      idleTimeoutMs,
      signal,
    }) => {
      const opened = await invokeWithLogging<TlsOpenResponse>("syncpeer_quic_open", {
        request: {
          host,
          port,
          certPem,
          keyPem,
          caPem: caPem ?? null,
          timeoutMs: timeoutMs ?? null,
          keepaliveMs,
          idleTimeoutMs,
        },
      });
      if (signal?.aborted) {
        await invokeWithLogging("syncpeer_quic_close", {
          request: { sessionId: Number(opened.sessionId) },
        });
        throw new DOMException("Connection attempt was cancelled.", "AbortError");
      }
      return createTlsSocket(
        invokeWithLogging,
        Number(opened.sessionId),
        new Uint8Array(opened.peerCertificateDer),
        "syncpeer_quic",
      );
    },
    connectRelay: async ({ relayAddress, expectedDeviceId, certPem, keyPem, caPem, timeoutMs, signal,
      alpnProtocols }) => {
      const opened = await invokeWithLogging<RelayOpenResponse>("syncpeer_relay_open", {
        request: {
          relayAddress,
          expectedDeviceId,
          certPem,
          keyPem,
          caPem: caPem ?? null,
          timeoutMs: timeoutMs ?? null,
          alpnProtocols: [...alpnProtocols ?? ["bep/1.0"]],
        },
      });
      const sessionId = Number(opened.sessionId);
      if (signal?.aborted) {
        await invokeWithLogging("syncpeer_tls_close", { request: { sessionId } });
        throw new DOMException("Connection attempt was cancelled.", "AbortError");
      }
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
      const previousDiscovery = localDiscoveryQueue;
      let releaseDiscovery = () => {};
      localDiscoveryQueue = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      await previousDiscovery;
      try {
        if (!multicastLockPrepared) {
          multicastLockPrepared = true;
          try {
            await invokeWithLogging<boolean>("syncpeer_android_enable_multicast_lock");
          } catch {
            // Best-effort on Android; command returns false on non-Android.
          }
        }
        const payload = await invokeWithLogging<DiscoveryLocalResponsePayload>("syncpeer_discovery_local", {
          request: {
            expectedDeviceId: expectedDeviceId || null,
            timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
          } as DiscoveryLocalRequestPayload,
        });
        logUi(options, "tauri.discovery.local.result", {
          timeoutMs: payload.diagnostics?.timeoutMs ?? timeoutMs ?? null,
          socketsBound: payload.diagnostics?.socketsBound ?? null,
          bindErrors: payload.diagnostics?.bindErrors ?? [],
          packetsReceived: payload.diagnostics?.packetsReceived ?? 0,
          packetsBySocketUdp4: payload.diagnostics?.packetsBySocketUdp4 ?? 0,
          packetsBySocketUdp6: payload.diagnostics?.packetsBySocketUdp6 ?? 0,
          packetsMagicMismatch: payload.diagnostics?.packetsMagicMismatch ?? 0,
          packetsDecodeFailed: payload.diagnostics?.packetsDecodeFailed ?? 0,
          packetsMissingId: payload.diagnostics?.packetsMissingId ?? 0,
          packetsFilteredExpectedId: payload.diagnostics?.packetsFilteredExpectedId ?? 0,
          announcementsAccepted: payload.diagnostics?.announcementsAccepted ?? 0,
          discoveredDeviceIds: payload.diagnostics?.discoveredDeviceIds ?? [],
          syncthingLanAvailable: payload.diagnostics?.syncthingLanAvailable ?? false,
          syncpeerLanActive: payload.diagnostics?.syncpeerLanActive ?? false,
          statusMessage: payload.diagnostics?.statusMessage ?? "LAN discovery status unknown",
          candidateCount: payload.candidates?.length ?? 0,
        });
        if (
          payload.diagnostics?.socketsBound === 0 &&
          payload.diagnostics.syncpeerLanActive !== true
        ) {
          const bindErrors = payload.diagnostics.bindErrors ?? [];
          throw new Error(
            `Local discovery sockets unavailable (${bindErrors.join(" | ")}).`,
          );
        }
        return (payload.candidates ?? [])
          .filter((candidate) => typeof candidate?.address === "string" && candidate.address.trim() !== "")
          .map((candidate) => ({
            address: candidate.address.trim(),
            protocol:
              candidate.protocol === "tcp" || candidate.protocol === "quic" || candidate.protocol === "relay"
                ? candidate.protocol
                : "unknown",
            host: candidate.host ?? undefined,
            port: Number.isFinite(candidate.port) ? Number(candidate.port) : undefined,
            deviceId:
              typeof candidate.deviceId === "string" && candidate.deviceId.trim() !== ""
                ? candidate.deviceId.trim()
                : undefined,
          }));
      } finally {
        releaseDiscovery();
      }
    },
    log: (event, details) => logUi(options, event, details),
  };

  const platformAdapter: SyncpeerPlatformAdapter = {
    sessionConfigurationRevision: () => sessionConfigurationRevision,
    onSessionConfigurationChange: listener => { sessionConfigurationListeners.add(listener); },
    releaseLocalCopy: async (folderId, mode, confirmedText, sessions) => {
      if (platform === "android") {
        await invokeWithLogging("syncpeer_android_release_local_copy", {
          request: { folderId, mode, confirmedText },
        });
        return;
      }
      const documents = await desktopDocuments();
      await documents.releaseLocalCopy(folderId, mode === "safe"
        ? { mode, sessions } : { mode, confirmedText });
      invalidateSessionConfiguration();
    },
    startBackgroundSession: platform === "android" ? async (options: Omit<ConnectOptions, "sharedFolders">) => {
      let allowMetered = false;
      try {
        const settings = await documentRequest<SyncpeerProfileSettings>({ operation: "profileSettings" });
        allowMetered = settings.profile.allowMetered;
      } catch {
        // A locked vault keeps the safer default: background sessions wait for Wi-Fi.
      }
      await invokeWithLogging("syncpeer_android_start_background_session", {
        request: { operation: "connect", options: { ...options, allowMetered } },
      });
    } : undefined,
    stopBackgroundSession: platform === "android" ? async () => {
      await invokeWithLogging("syncpeer_android_stop_background_session");
    } : undefined,
    readTextFile: async (path: string): Promise<string> =>
      invokeWithLogging<string>("syncpeer_read_text_file", { request: { path } }),
    readBinaryFile: async (path: string): Promise<Uint8Array> => {
      const bytes = await invokeWithLogging<number[]>("syncpeer_read_binary_file", {
        request: { path },
      });
      return new Uint8Array(bytes);
    },
    readCachedFile: async (folderId: string, path: string): Promise<Uint8Array> => {
      const bytes = await invokeWithLogging<number[]>("syncpeer_read_cached_file", {
        request: { folderId, path },
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
    createFileDownloadSink: async ({ folderId, path, name, modifiedMs }): Promise<FileDownloadSink> => {
      let transferId: string | null = null;
      let committed = false;
      let sizeBytes = 0;
      const digestRanges = async (source: "cached" | "partial", ranges: readonly { offset: number; size: number }[]) => {
        if (!transferId || committed) throw new Error("Download sink is not readable.");
        const result = await invokeWithLogging<Array<{ offset: number; size: number; hash: number[] }>>(
          "syncpeer_cache_digest_ranges", { request: { transferId, source, ranges } },
        );
        return result.map((range) => ({ ...range, hash: new Uint8Array(range.hash) }));
      };
      return {
        begin: async (metadata) => {
          if (transferId) return;
          const response = await invokeWithLogging<{ transferId: string }>(
            "syncpeer_cache_begin_file",
            {
              request: {
                folderId,
                path,
                name,
                sizeBytes: metadata.sizeBytes,
                modifiedMs: modifiedMs ?? null,
                contentId: metadata.contentId ?? null,
                sourceDeviceId: metadata.sourceDeviceId ?? null,
                encrypted: metadata.encrypted,
              },
            },
          );
          transferId = response.transferId;
          sizeBytes = metadata.sizeBytes;
        },
        digestCachedRanges: (ranges) => digestRanges("cached", ranges),
        digestPartialRanges: (ranges) => digestRanges("partial", ranges),
        resumeStorage: {
          digestCachedRanges: (ranges) => digestRanges("partial", ranges),
          // Recovered bytes already occupy the correct destination offsets.
          // Core verifies their digests before excluding them from downloads.
          copyCachedRanges: async () => {},
        },
        copyCachedRanges: async (ranges) => {
          if (!transferId || committed) throw new Error("Download sink is not writable.");
          await invokeWithLogging("syncpeer_cache_copy_ranges", { request: { transferId, source: "cached", ranges } });
        },
        digestFile: async () => {
          const [digest] = await digestRanges("partial", [{ offset: 0, size: sizeBytes }]);
          if (!digest) throw new Error("Complete download digest is unavailable.");
          return Array.from(digest.hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
        },
        write: async (offset, bytes) => {
          if (!transferId || committed) throw new Error("Download sink is not writable.");
          await invokeWithLogging("syncpeer_cache_write_chunk", {
            request: { transferId, offset, bytes: Array.from(bytes) },
          });
        },
        commit: async () => {
          if (!transferId || committed) return;
          await invokeWithLogging("syncpeer_cache_commit", { request: { transferId } });
          committed = true;
        },
        suspend: async () => {
          if (!transferId || committed) return;
          await invokeWithLogging("syncpeer_cache_suspend", { request: { transferId } });
          transferId = null;
        },
        abort: async () => {
          if (!transferId || committed) return;
          await invokeWithLogging("syncpeer_cache_abort", { request: { transferId } });
          transferId = null;
        },
      };
    },
    startTransfer: async (label: string) => {
      await invokeWithLogging("syncpeer_android_start_transfer_service", {
        request: { label },
      });
    },
    stopTransfer: async () => {
      await invokeWithLogging("syncpeer_android_stop_transfer_service");
    },
    updateTransferNotification: async ({
      title,
      body,
      progress,
      ongoing,
      cancellable,
    }) => {
      await invokeWithLogging("syncpeer_android_update_transfer_notification", {
        request: { title, body, progress: progress ?? null, ongoing, cancellable },
      });
    },
    getCachedStatuses: async (folderId: string, paths: string[]): Promise<CachedFileStatus[]> =>
      invokeWithLogging<CachedFileStatus[]>("syncpeer_get_cached_statuses", { request: { folderId, paths } }),
    digestCachedFiles: async (
      files: readonly { folderId: string; path: string }[],
    ): Promise<CachedFileDigest[]> => {
      const response = await invokeWithLogging<Array<{
        folderId: string;
        path: string;
        hash: number[] | null;
      }>>("syncpeer_digest_cached_files", { requests: files });
      return response.map(({ folderId, path, hash }) => ({
        folderId,
        path,
        hash: hash === null ? undefined : Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join(""),
      }));
    },
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
    listAndroidContacts: async () =>
      invokeWithLogging("syncpeer_android_list_contacts"),
    upsertAndroidContact: async (input) =>
      invokeWithLogging("syncpeer_android_upsert_contact", { request: input }),
    deleteAndroidContact: async (contactId: string) =>
      invokeWithLogging("syncpeer_android_delete_contact", { request: { contactId } }),
    listAndroidCalendarEvents: async (args) =>
      invokeWithLogging("syncpeer_android_list_calendar_events", { request: args ?? {} }),
    upsertAndroidCalendarEvent: async (input) =>
      invokeWithLogging("syncpeer_android_upsert_calendar_event", { request: input }),
    deleteAndroidCalendarEvent: async (eventId: string) =>
      invokeWithLogging("syncpeer_android_delete_calendar_event", { request: { eventId } }),
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

  const documents = createDocumentCache({ legacy: platformAdapter,
    enabled: () => detectRuntimeEnvironment() === "tauri",
    request: documentRequest,
    openLegacySource: async file => {
      if (!file.localPath?.startsWith("/") || file.safRelativePath) {
        throw new Error("This folder uses external storage. Its existing plaintext files were left unchanged; import them through the file picker explicitly.");
      }
      const separator = file.localPath.lastIndexOf("/"), name = file.localPath.slice(separator + 1);
      const bytes = await createNativeFilesystem(request => invokeWithLogging("syncpeer_replica_storage", { request }), file.localPath.slice(0, separator));
      try {
        const original = await bytes.stat(name);
        if (!original || original.type !== "file") throw new Error("Cached file is unavailable.");
        return { size: original.size, readRange: (offset, size) => bytes.readRange(name, offset, size),
          verify: async () => {
            const current = await bytes.stat(name);
            if (!current || current.revision !== original.revision) throw new Error("Cached file changed during migration.");
          }, close: bytes.close };
      } catch (error) { await bytes.close(); throw error; }
    },
    show: async id => { await invokeWithLogging("syncpeer_document_command", { request: { operation: "show", id } }); },
  });
  const appPlatformAdapter = platform === "android"
    ? { ...documents.platformAdapter, sessionSharedFolders: async () => [] }
    : documents.platformAdapter;
  return { hostAdapter, platformAdapter: appPlatformAdapter, documentCommand: documentRequest,
    connectDocumentFolder: documents.connectFolder,
    disconnectDocumentFolder: documents.disconnectFolder,
    syncDocumentFolders: documents.syncFolders,
    folderCredentials: detectRuntimeEnvironment() === "tauri" ? {
      load: () => documentRequest<Record<string, string>>({ operation: "connectionPasswords" }),
      save: async (passwords: Record<string, string>) => { await documentRequest({ operation: "saveConnectionPasswords", passwords }); },
      merge: async (passwords: Record<string, string>) => { await documentRequest({ operation: "mergeConnectionPasswords", passwords }); },
    } : undefined,
    biometric: platform === "android" ? {
      status: async () => invokeWithLogging<{ available: boolean; enabled: boolean }>("syncpeer_android_biometric_status", { request: { profileId: "documents" } }),
      setEnabled: async (enabled: boolean) => invokeWithLogging<{ available: boolean; enabled: boolean }>("syncpeer_android_biometric_set_enabled", { request: { profileId: "documents", enabled } }),
      authenticate: async () => invokeWithLogging<boolean>("syncpeer_android_biometric_authenticate", { request: { profileId: "documents" } }),
    } : undefined };
};

const createNativeTlsListener = (invoke: InvokeFn, opened: TlsListenResponse) => {
  let closed = false;
  return {
    port: opened.port,
    accept: async () => {
      while (!closed) {
        try {
          const accepted = await invoke<TlsAcceptResponse>("syncpeer_tls_accept", {
            request: { listenerId: opened.listenerId, timeoutMs: 60_000 },
          });
          return { socket: createTlsSocket(invoke, Number(accepted.sessionId),
            new Uint8Array(accepted.peerCertificateDer)), remoteAddress: accepted.remoteAddress,
          remotePort: accepted.remotePort, alpn: accepted.alpn };
        } catch (error) {
          if (!closed && /accept timed out/i.test(String(error))) continue;
          throw error;
        }
      }
      throw new Error("TLS listener closed.");
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await invoke("syncpeer_tls_listener_close", { request: { listenerId: opened.listenerId } });
    },
  };
};

export const reportUiError = (
  event: string,
  error: unknown,
  context?: unknown,
) => {
  void error;
  const normalizedContext =
    context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  const safeEvent = /^[a-zA-Z0-9._-]{1,128}$/.test(event) ? event : "invalid";
  const safeContext = sanitizeDiagnosticArtifact(normalizedContext) as Record<string, unknown>;
  console.error(`[syncpeer-ui] ${safeEvent}`, safeContext);
  try {
    const invoke = resolveInvoke();
    void tryForwardUiErrorToCli(invoke, safeEvent, safeContext);
  } catch {
    // App might be running outside Tauri.
  }
};
