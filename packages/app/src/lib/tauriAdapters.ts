import type {
  CachedFileDigest,
  CachedFileRecord,
  CachedFileStatus,
  FavoriteRecord,
  IdentityRecoveryExportResponse,
  SyncpeerHostAdapter,
  SyncpeerPlatformAdapter,
  SyncpeerTlsSocket,
  ConnectOptions,
  SyncpeerProfileSettings,
  FileDownloadSink,
} from "@syncpeer/core/browser";
import { createNativeDiscoveryFetch } from "@syncpeer/core/browser";
import { createDocumentCache, createDocumentFilesystem, createNativeFilesystem,
  dispatchDocumentCommandWithSessionConfiguration } from "@syncpeer/core/filesystem";
import { detectRuntimeEnvironment, detectRuntimePlatform, type RuntimePlatform } from "./runtimeInfo.ts";
import { createWorkerPasswordKdf } from "./passwordKdf.ts";
import { sanitizeDiagnosticArtifact } from "../../../shared/modules/diagnosticSanitizer.ts";

type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;
type InvokeFn = <T>(command: string, args?: InvokeArgs) => Promise<T>;

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

const ANDROID_LOG_FOLDER_KEY = "syncpeer.logs.safTreeUri.v1";

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
  !/^(?:syncpeer_tls|syncpeer_quic)_(?:read|write)(?:_binary)?$/.test(command) &&
  command !== "syncpeer_replica_storage" &&
  !/^syncpeer_replica_storage_(?:read|write|read_file|write_file|read_files|write_files)_binary$/.test(command);
const createLoggedInvoke = (
  invoke: InvokeFn,
  options: CreateTauriAdaptersOptions | undefined,
): InvokeFn => async <T>(command: string, args?: InvokeArgs) => {
  const startedAt = Date.now();
  const shouldLogLifecycle = shouldLogInvokeLifecycle(command);
  if (shouldLogLifecycle) logUi(options, "tauri.invoke.start", { command });
  try {
    const result = await invoke<T>(command, args);
    if (shouldLogLifecycle) {
      logUi(options, "tauri.invoke.success", { command, durationMs: Date.now() - startedAt });
    }
    return result;
  } catch (error) {
    if (command === "syncpeer_discovery_fetch" &&
      /^(?:Error: )?Discovery request cancelled(?: or unavailable)?\.?$/.test(String(error))) throw error;
    console.error("[syncpeer-ui] tauri.invoke.error", { command });
    emitLog(options, "error", "tauri.invoke.error", { command });
    void tryForwardUiErrorToCli(invoke, "tauri.invoke.error", { command });
    throw error;
  }
};

const setU64 = (view: DataView, offset: number, value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid native storage integer.");
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 0x1_0000_0000), true);
};

const nativeReadRequest = (rootId: number, path: string, offset: number, size: number): Uint8Array => {
  const encodedPath = new TextEncoder().encode(path);
  if (encodedPath.length > 4096) throw new Error("Native storage path is too long.");
  const body = new Uint8Array(24 + encodedPath.length), view = new DataView(body.buffer);
  setU64(view, 0, rootId); setU64(view, 8, offset);
  view.setUint32(16, size, true); view.setUint32(20, encodedPath.length, true);
  body.set(encodedPath, 24);
  return body;
};

const nativeWriteRequest = (writerId: number, offset: number, bytes: Uint8Array): Uint8Array => {
  const body = new Uint8Array(16 + bytes.length), view = new DataView(body.buffer);
  setU64(view, 0, writerId); setU64(view, 8, offset); body.set(bytes, 16);
  return body;
};
const nativeReadFileRequest = (rootId: number, path: string, maxSize: number): Uint8Array => {
  const encodedPath = new TextEncoder().encode(path);
  if (encodedPath.length > 4096) throw new Error("Native storage path is too long.");
  const body = new Uint8Array(16 + encodedPath.length), view = new DataView(body.buffer);
  setU64(view, 0, rootId); view.setUint32(8, maxSize, true); view.setUint32(12, encodedPath.length, true);
  body.set(encodedPath, 16);
  return body;
};

const nativeWriteFileRequest = (rootId: number, path: string, bytes: Uint8Array): Uint8Array => {
  const encodedPath = new TextEncoder().encode(path);
  if (encodedPath.length > 4096) throw new Error("Native storage path is too long.");
  const body = new Uint8Array(12 + encodedPath.length + bytes.length), view = new DataView(body.buffer);
  setU64(view, 0, rootId); view.setUint32(8, encodedPath.length, true);
  body.set(encodedPath, 12); body.set(bytes, 12 + encodedPath.length);
  return body;
};
const nativeReadFilesRequest = (rootId: number, paths: readonly string[], maxTotalSize: number): Uint8Array => {
  const encoded = paths.map(path => new TextEncoder().encode(path));
  if (encoded.some(path => path.length > 4096)) throw new Error("Native storage path is too long.");
  const body = new Uint8Array(16 + encoded.reduce((total, path) => total + 4 + path.length, 0));
  const view = new DataView(body.buffer);
  setU64(view, 0, rootId); view.setUint32(8, maxTotalSize, true); view.setUint32(12, encoded.length, true);
  let cursor = 16;
  for (const path of encoded) {
    view.setUint32(cursor, path.length, true); cursor += 4;
    body.set(path, cursor); cursor += path.length;
  }
  return body;
};

const nativeWriteFilesRequest = (rootId: number, files: readonly { path: string; bytes: Uint8Array }[]): Uint8Array => {
  const encoded = files.map(file => ({ ...file, pathBytes: new TextEncoder().encode(file.path) }));
  if (encoded.some(file => file.pathBytes.length > 4096)) throw new Error("Native storage path is too long.");
  const body = new Uint8Array(12 + encoded.reduce((total, file) => total + 8 + file.pathBytes.length + file.bytes.length, 0));
  const view = new DataView(body.buffer);
  setU64(view, 0, rootId); view.setUint32(8, encoded.length, true);
  let cursor = 12;
  for (const file of encoded) {
    view.setUint32(cursor, file.pathBytes.length, true); view.setUint32(cursor + 4, file.bytes.length, true); cursor += 8;
    body.set(file.pathBytes, cursor); cursor += file.pathBytes.length;
    body.set(file.bytes, cursor); cursor += file.bytes.length;
  }
  return body;
};

const decodeNativeReadFiles = (value: unknown, expectedCount: number, maxTotalSize: number): Uint8Array[] => {
  const body = rawByteView(value);
  if (body.length < 4) throw new Error("Invalid native whole-file read batch response.");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getUint32(0, true);
  if (count !== expectedCount) throw new Error("Invalid native whole-file read batch response.");
  const result: Uint8Array[] = [];
  let cursor = 4, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 4 > body.length) throw new Error("Invalid native whole-file read batch response.");
    const size = view.getUint32(cursor, true); cursor += 4;
    if (cursor + size > body.length) throw new Error("Invalid native whole-file read batch response.");
    total += size;
    if (total > maxTotalSize) throw new Error("Native whole-file read batch exceeded its limit.");
    result.push(body.slice(cursor, cursor + size)); cursor += size;
  }
  if (cursor !== body.length) throw new Error("Invalid native whole-file read batch response.");
  return result;
};

const rawByteView = (value: unknown): Uint8Array => {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : null;
  if (!bytes) throw new Error("Invalid binary IPC response.");
  return bytes;
};

const rawBytes = (value: unknown, size: number): Uint8Array => {
  const bytes = rawByteView(value);
  if (bytes.length !== size) throw new Error("Invalid binary native storage response.");
  return bytes;
};

const socketReadRequest = (sessionId: number, maxBytes?: number): Uint8Array => {
  const requested = Number.isFinite(maxBytes) ? Math.floor(Number(maxBytes)) : 1024 * 1024;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 1024 * 1024) {
    throw new Error("Invalid socket read size.");
  }
  const body = new Uint8Array(12), view = new DataView(body.buffer);
  setU64(view, 0, sessionId); view.setUint32(8, requested, true);
  return body;
};

const createTlsSocket = (
  invoke: InvokeFn,
  sessionId: number,
  peerCertificateDer: Uint8Array,
  commandPrefix = "syncpeer_tls",
  // Tauri's Android IPC cannot carry raw request bodies, so Android uses the
  // JSON read command while desktop keeps the bounded raw fast path.
  useRawBody = true,
): SyncpeerTlsSocket => ({
  peerCertificateDer: async () => peerCertificateDer,
  read: async (maxBytes?: number) => {
    if (useRawBody) {
      return rawByteView(await invoke<ArrayBuffer>(
        `${commandPrefix}_read_binary`, socketReadRequest(sessionId, maxBytes)));
    }
    const response = await invoke<{ bytes: number[]; eof: boolean }>(
      `${commandPrefix}_read`, { request: { sessionId, maxBytes: maxBytes ?? null } });
    if (response.eof) throw new Error("Connection closed");
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
class TauriAdapters {
  private readonly options?: CreateTauriAdaptersOptions;
  private readonly platform: ReturnType<typeof detectRuntimePlatform>;
  private invoke: InvokeFn | null = null;
  private multicastLockPrepared = false;
  private localDiscoveryQueue = Promise.resolve();
  private configurationRevision = 0;
  private readonly sessionConfigurationListeners = new Set<() => void>();
  private documentsOwner: Promise<ReturnType<typeof createDocumentFilesystem>> | undefined;

  constructor(options?: CreateTauriAdaptersOptions) {
    this.options = options;
    this.platform = options?.runtimePlatform ?? detectRuntimePlatform();
  }

  private invokeWithLogging: InvokeFn = <T>(command: string, args?: InvokeArgs): Promise<T> => {
    if (!this.invoke) this.invoke = createLoggedInvoke(resolveInvoke(), this.options);
    return this.invoke<T>(command, args);
  };

  private nativeStorage(rootPath: string) {
    return createNativeFilesystem(
      request => this.invokeWithLogging("syncpeer_replica_storage", { request }), rootPath, {
        read: async ({ rootId, path, offset, size }) => rawBytes(
          await this.invokeWithLogging<ArrayBuffer>("syncpeer_replica_storage_read_binary",
            nativeReadRequest(rootId, path, offset, size)), size),
        write: async ({ writerId, offset, bytes }) => {
          await this.invokeWithLogging("syncpeer_replica_storage_write_binary",
            nativeWriteRequest(writerId, offset, bytes));
        },
        readFile: async ({ rootId, path, maxSize }) => {
          const bytes = rawByteView(await this.invokeWithLogging<ArrayBuffer>("syncpeer_replica_storage_read_file_binary",
            nativeReadFileRequest(rootId, path, maxSize)));
          if (bytes.length > maxSize) throw new Error("Native whole-file read exceeded its limit.");
          return bytes;
        },
        writeFile: async ({ rootId, path, bytes }) => {
          await this.invokeWithLogging("syncpeer_replica_storage_write_file_binary", nativeWriteFileRequest(rootId, path, bytes));
        },
        readFiles: async ({ rootId, paths, maxTotalSize }) => decodeNativeReadFiles(
          await this.invokeWithLogging<ArrayBuffer>("syncpeer_replica_storage_read_files_binary",
            nativeReadFilesRequest(rootId, paths, maxTotalSize)), paths.length, maxTotalSize),
        writeFiles: async ({ rootId, files }) => {
          await this.invokeWithLogging("syncpeer_replica_storage_write_files_binary", nativeWriteFilesRequest(rootId, files));
        },
      });
  }

  private invalidateSessionConfiguration() {
    this.configurationRevision++;
    for (const listener of this.sessionConfigurationListeners) listener();
  }

  private async desktopDocuments() {
    return this.documentsOwner ??= (async () => {
      const root = async (storageId: string) => this.invokeWithLogging<string>("syncpeer_profile_storage_root",
        { request: { profileId: "documents", storageId } });
      const storage = async (storageId: string) => this.nativeStorage(await root(storageId));
      const deviceId = await this.invokeWithLogging<string>("syncpeer_get_default_device_id");
      let counter = 0xcbf29ce484222325n;
      for (const byte of new TextEncoder().encode(deviceId)) {
        counter = BigInt.asUintN(64, (counter ^ BigInt(byte)) * 0x100000001b3n);
      }
      const documents = createDocumentFilesystem({ profileId: "documents", deviceCounterId: counter.toString(),
        profile: await storage("profile"), openStorage: storage,
        availableBytes: () => this.invokeWithLogging<number>("syncpeer_profile_available_bytes"),
        rememberedSecret: {
          load: () => this.invokeWithLogging<string | null>("syncpeer_vault_secret",
            { request: { profileId: "documents", operation: "load", secret: null } }),
          save: secret => this.invokeWithLogging("syncpeer_vault_secret",
            { request: { profileId: "documents", operation: "save", secret } }),
          remove: () => this.invokeWithLogging("syncpeer_vault_secret",
            { request: { profileId: "documents", operation: "remove", secret: null } }),
          isDeviceUnlocked: () => this.invokeWithLogging<boolean>("syncpeer_vault_secret",
            { request: { profileId: "documents", operation: "isDeviceUnlocked", secret: null } }),
        },
        randomBytes: size => crypto.getRandomValues(new Uint8Array(size)),
        kdf: createWorkerPasswordKdf(),
        onDiagnostic: (event, details) => logUi(this.options, event, details),
        onSessionConfigurationChange: () => this.invalidateSessionConfiguration(),
      });
      await documents.initialize();
      return documents;
    })();
  }

  private async documentRequest<T>(request: Record<string, unknown>) {
    if (this.platform === "android") {
      if (request.operation === "writeBatch") {
        const writes = request.writes, handle = request.handle;
        if (!Array.isArray(writes) || writes.length < 1 || writes.length > 8 ||
          typeof handle !== "number" || !Number.isSafeInteger(handle) ||
          writes.some(write => !write || typeof write !== "object" ||
            typeof write.offset !== "number" || !Number.isSafeInteger(write.offset) || write.offset < 0 ||
            !Array.isArray(write.bytes) || write.bytes.length > 131072)) {
          throw new Error("Invalid Android document write batch.");
        }
        let done = 0;
        for (const write of writes) {
          const { offset, bytes } = write;
          if (!Number.isSafeInteger(offset + bytes.length) ||
            bytes.some((byte: unknown) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
            throw new Error("Invalid Android document write batch.");
          }
          const response = await this.invokeWithLogging<{ result: number }>("syncpeer_document_command", {
            request: { operation: "write", handle, offset, bytes },
          });
          if (response.result !== bytes.length) throw new Error("Android document write was incomplete.");
          done += bytes.length;
        }
        return done as T;
      }
      const response = await this.invokeWithLogging<{ result: T }>("syncpeer_document_command", { request });
      return response.result;
    }
    const documents = await this.desktopDocuments();
    return await dispatchDocumentCommandWithSessionConfiguration(
      documents, request, () => this.invalidateSessionConfiguration(),
    ) as T;
  }

  private async connectTls({ host, port, certPem, keyPem, caPem, timeoutMs, signal, alpnProtocols }:
    Parameters<NonNullable<SyncpeerHostAdapter["connectTls"]>>[0]) {
    const opened = await this.invokeWithLogging<TlsOpenResponse>("syncpeer_tls_open", {
      request: { host, port, certPem, keyPem, caPem: caPem ?? null, timeoutMs: timeoutMs ?? null,
        alpnProtocols: [...alpnProtocols ?? ["bep/1.0"]] },
    });
    const sessionId = Number(opened.sessionId);
    if (signal?.aborted) {
      await this.invokeWithLogging("syncpeer_tls_close", { request: { sessionId } });
      throw new DOMException("Connection attempt was cancelled.", "AbortError");
    }
    return createTlsSocket(this.invokeWithLogging, sessionId,
      new Uint8Array(opened.peerCertificateDer), "syncpeer_tls", this.platform !== "android");
  }

  private async listenTls({ host, port, certPem, keyPem, alpnProtocols, handshakeTimeoutMs }:
    Parameters<NonNullable<SyncpeerHostAdapter["listenTls"]>>[0]) {
    const opened = await this.invokeWithLogging<TlsListenResponse>("syncpeer_tls_listen", {
      request: { host, port, certPem, keyPem, alpnProtocols: [...alpnProtocols],
        handshakeTimeoutMs: handshakeTimeoutMs ?? null },
    });
    return createNativeTlsListener(this.invokeWithLogging, opened, undefined, this.platform !== "android");
  }

  private async listenRelay({ relayAddress, certPem, keyPem, alpnProtocols, handshakeTimeoutMs }:
    Parameters<NonNullable<SyncpeerHostAdapter["listenRelay"]>>[0]) {
    const opened = await this.invokeWithLogging<TlsListenResponse>("syncpeer_relay_listen", {
      request: { relayAddress, certPem, keyPem, alpnProtocols: [...alpnProtocols],
        handshakeTimeoutMs: handshakeTimeoutMs ?? null },
    });
    return createNativeTlsListener(this.invokeWithLogging, opened, relayAddress, this.platform !== "android");
  }

  private async connectQuic({ host, port, certPem, keyPem, caPem, timeoutMs, keepaliveMs, idleTimeoutMs, signal }:
    Parameters<NonNullable<SyncpeerHostAdapter["connectQuic"]>>[0]) {
    const opened = await this.invokeWithLogging<TlsOpenResponse>("syncpeer_quic_open", {
      request: { host, port, certPem, keyPem, caPem: caPem ?? null, timeoutMs: timeoutMs ?? null,
        keepaliveMs, idleTimeoutMs },
    });
    if (signal?.aborted) {
      await this.invokeWithLogging("syncpeer_quic_close", { request: { sessionId: Number(opened.sessionId) } });
      throw new DOMException("Connection attempt was cancelled.", "AbortError");
    }
    return createTlsSocket(this.invokeWithLogging, Number(opened.sessionId),
      new Uint8Array(opened.peerCertificateDer), "syncpeer_quic", this.platform !== "android");
  }

  private async connectRelay({ relayAddress, expectedDeviceId, certPem, keyPem, caPem, timeoutMs, signal,
    alpnProtocols }: Parameters<NonNullable<SyncpeerHostAdapter["connectRelay"]>>[0]) {
    const opened = await this.invokeWithLogging<RelayOpenResponse>("syncpeer_relay_open", {
      request: { relayAddress, expectedDeviceId, certPem, keyPem, caPem: caPem ?? null,
        timeoutMs: timeoutMs ?? null, alpnProtocols: [...alpnProtocols ?? ["bep/1.0"]] },
    });
    const sessionId = Number(opened.sessionId);
    if (signal?.aborted) {
      await this.invokeWithLogging("syncpeer_tls_close", { request: { sessionId } });
      throw new DOMException("Connection attempt was cancelled.", "AbortError");
    }
    return { connectedVia: opened.connectedVia || relayAddress,
      socket: createTlsSocket(this.invokeWithLogging, sessionId,
        new Uint8Array(opened.peerCertificateDer), "syncpeer_tls", this.platform !== "android") };
  }

  private async sha256(data: Uint8Array) {
    const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
    return new Uint8Array(digest);
  }

  private randomBytes(length: number) {
    const output = new Uint8Array(length);
    crypto.getRandomValues(output);
    return output;
  }

  private async discoverLocalCandidates({ expectedDeviceId, timeoutMs }:
    Parameters<NonNullable<SyncpeerHostAdapter["discoverLocalCandidates"]>>[0]) {
    const previousDiscovery = this.localDiscoveryQueue;
    let releaseDiscovery = () => {};
    this.localDiscoveryQueue = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    await previousDiscovery;
    try {
      if (!this.multicastLockPrepared) {
        this.multicastLockPrepared = true;
        try {
          await this.invokeWithLogging<boolean>("syncpeer_android_enable_multicast_lock");
        } catch {
          // Best-effort on Android; command returns false on non-Android.
        }
      }
      const payload = await this.invokeWithLogging<DiscoveryLocalResponsePayload>("syncpeer_discovery_local", {
        request: {
          expectedDeviceId: expectedDeviceId || null,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
        } as DiscoveryLocalRequestPayload,
      });
      logUi(this.options, "tauri.discovery.local.result", {
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
      if (payload.diagnostics?.socketsBound === 0 && payload.diagnostics.syncpeerLanActive !== true) {
        const bindErrors = payload.diagnostics.bindErrors ?? [];
        throw new Error(`Local discovery sockets unavailable (${bindErrors.join(" | ")}).`);
      }
      return (payload.candidates ?? [])
        .filter((candidate) => typeof candidate?.address === "string" && candidate.address.trim() !== "")
        .map((candidate) => ({
          address: candidate.address.trim(),
          protocol: (candidate.protocol === "tcp" || candidate.protocol === "quic" || candidate.protocol === "relay"
            ? candidate.protocol : "unknown") as "tcp" | "quic" | "relay" | "unknown",
          host: candidate.host ?? undefined,
          port: Number.isFinite(candidate.port) ? Number(candidate.port) : undefined,
          deviceId: typeof candidate.deviceId === "string" && candidate.deviceId.trim() !== ""
            ? candidate.deviceId.trim() : undefined,
        }));
    } finally {
      releaseDiscovery();
    }
  }

  private async androidBackgroundSessionRequest(options: Omit<ConnectOptions, "sharedFolders">) {
    let allowMetered = false;
    try {
      const settings = await this.documentRequest<SyncpeerProfileSettings>({ operation: "profileSettings" });
      allowMetered = settings.profile.allowMetered;
    } catch {
      // A locked vault keeps the safer default: background sessions wait for Wi-Fi.
    }
    return { operation: "connect", options: { ...options, allowMetered } };
  }

  private async releaseLocalCopy(folderId: string, mode: "safe" | "dangerous", confirmedText: string,
    sessions: Parameters<NonNullable<SyncpeerPlatformAdapter["releaseLocalCopy"]>>[3]) {
    if (this.platform === "android") {
      await this.invokeWithLogging("syncpeer_android_release_local_copy", {
        request: { folderId, mode, confirmedText },
      });
      return;
    }
    const documents = await this.desktopDocuments();
    await documents.releaseLocalCopy(folderId, mode === "safe" ? { mode, sessions } : { mode, confirmedText });
    this.invalidateSessionConfiguration();
  }

  private async prepareBackgroundSession(options: Omit<ConnectOptions, "sharedFolders">) {
    await this.invokeWithLogging("syncpeer_android_prepare_background_session", {
      request: await this.androidBackgroundSessionRequest(options),
    });
  }

  private async startBackgroundSession(options: Omit<ConnectOptions, "sharedFolders">) {
    await this.invokeWithLogging("syncpeer_android_start_background_session", {
      request: await this.androidBackgroundSessionRequest(options),
    });
  }

  private async stopBackgroundSession() {
    await this.invokeWithLogging("syncpeer_android_stop_background_session");
  }

  private async cacheFile(folderId: string, path: string, name: string, bytes: Uint8Array,
    modifiedMs?: number): Promise<void> {
    await this.invokeWithLogging("syncpeer_cache_file", {
      request: { folderId, path, name, bytes: Array.from(bytes), modifiedMs: modifiedMs ?? null },
    });
  }

  private async createFileDownloadSink({ folderId, path, name, modifiedMs }:
    Parameters<NonNullable<SyncpeerPlatformAdapter["createFileDownloadSink"]>>[0]): Promise<FileDownloadSink> {
    let transferId: string | null = null;
    let committed = false;
    let sizeBytes = 0;
    const digestRanges = async (source: "cached" | "partial", ranges: readonly { offset: number; size: number }[]) => {
      if (!transferId || committed) throw new Error("Download sink is not readable.");
      const result = await this.invokeWithLogging<Array<{ offset: number; size: number; hash: number[] }>>(
        "syncpeer_cache_digest_ranges", { request: { transferId, source, ranges } },
      );
      return result.map((range) => ({ ...range, hash: new Uint8Array(range.hash) }));
    };
    return {
      begin: async (metadata) => {
        if (transferId) return;
        const response = await this.invokeWithLogging<{ transferId: string }>("syncpeer_cache_begin_file", {
          request: { folderId, path, name, sizeBytes: metadata.sizeBytes,
            modifiedMs: modifiedMs ?? null, contentId: metadata.contentId ?? null,
            sourceDeviceId: metadata.sourceDeviceId ?? null, encrypted: metadata.encrypted },
        });
        transferId = response.transferId;
        sizeBytes = metadata.sizeBytes;
      },
      digestCachedRanges: (ranges) => digestRanges("cached", ranges),
      digestPartialRanges: (ranges) => digestRanges("partial", ranges),
      resumeStorage: { digestCachedRanges: (ranges) => digestRanges("partial", ranges), copyCachedRanges: async () => {} },
      copyCachedRanges: async (ranges) => {
        if (!transferId || committed) throw new Error("Download sink is not writable.");
        await this.invokeWithLogging("syncpeer_cache_copy_ranges", { request: { transferId, source: "cached", ranges } });
      },
      digestFile: async () => {
        const [digest] = await digestRanges("partial", [{ offset: 0, size: sizeBytes }]);
        if (!digest) throw new Error("Complete download digest is unavailable.");
        return Array.from(digest.hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
      },
      write: async (offset, bytes) => {
        if (!transferId || committed) throw new Error("Download sink is not writable.");
        await this.invokeWithLogging("syncpeer_cache_write_chunk", {
          request: { transferId, offset, bytes: Array.from(bytes) },
        });
      },
      commit: async () => {
        if (!transferId || committed) return;
        await this.invokeWithLogging("syncpeer_cache_commit", { request: { transferId } });
        committed = true;
      },
      suspend: async () => {
        if (!transferId || committed) return;
        await this.invokeWithLogging("syncpeer_cache_suspend", { request: { transferId } });
        transferId = null;
      },
      abort: async () => {
        if (!transferId || committed) return;
        await this.invokeWithLogging("syncpeer_cache_abort", { request: { transferId } });
        transferId = null;
      },
    };
  }

  private async startTransfer(label: string) {
    await this.invokeWithLogging("syncpeer_android_start_transfer_service", { request: { label } });
  }

  private async stopTransfer() {
    await this.invokeWithLogging("syncpeer_android_stop_transfer_service");
  }

  private async updateTransferNotification({ title, body, progress, ongoing, cancellable }:
    Parameters<NonNullable<SyncpeerPlatformAdapter["updateTransferNotification"]>>[0]) {
    await this.invokeWithLogging("syncpeer_android_update_transfer_notification", {
      request: { title, body, progress: progress ?? null, ongoing, cancellable },
    });
  }

  private async getCachedStatuses(folderId: string, paths: string[]): Promise<CachedFileStatus[]> {
    return this.invokeWithLogging<CachedFileStatus[]>("syncpeer_get_cached_statuses", { request: { folderId, paths } });
  }

  private async digestCachedFiles(files: readonly { folderId: string; path: string }[]): Promise<CachedFileDigest[]> {
    const response = await this.invokeWithLogging<Array<{ folderId: string; path: string; hash: number[] | null }>>(
      "syncpeer_digest_cached_files", { requests: files });
    return response.map(({ folderId, path, hash }) => ({ folderId, path,
      hash: hash === null ? undefined : Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("") }));
  }

  private async listCachedFiles(): Promise<CachedFileRecord[]> {
    return this.invokeWithLogging<CachedFileRecord[]>("syncpeer_list_cached_files");
  }

  private openCachedFile(folderId: string, path: string): Promise<void> {
    return this.invokeWithLogging("syncpeer_open_cached_file", { request: { folderId, path } });
  }

  private openCachedFileDirectory(folderId: string, path: string): Promise<void> {
    return this.invokeWithLogging("syncpeer_open_cached_file_directory", { request: { folderId, path } });
  }

  private openCachedDirectory(folderId: string, path: string): Promise<void> {
    return this.invokeWithLogging("syncpeer_open_cached_directory", { request: { folderId, path } });
  }

  private removeCachedFile(folderId: string, path: string): Promise<boolean> {
    return this.invokeWithLogging<boolean>("syncpeer_remove_cached_file", { request: { folderId, path } });
  }

  private clearCache(): Promise<void> {
    return this.invokeWithLogging("syncpeer_clear_cache");
  }

  private getAndroidSafTreeUri(): Promise<string | null> {
    return this.invokeWithLogging<string | null>("syncpeer_get_android_saf_tree_uri");
  }

  private pickAndroidSafDirectory(): Promise<string> {
    return this.invokeWithLogging<string>("syncpeer_android_pick_saf_directory");
  }

  private setAndroidSafTreeUri(treeUri?: string | null): Promise<string | null> {
    return this.invokeWithLogging<string | null>("syncpeer_set_android_saf_tree_uri", { request: { treeUri: treeUri ?? null } });
  }

  private listAndroidPersistedSafUris(): Promise<string[]> {
    return this.invokeWithLogging<string[]>("syncpeer_android_list_persisted_saf_uris");
  }

  /** Android clipboard/share handoff for large exports such as session logs. */
  private async saveAndroidTextFile(fileName: string, text: string): Promise<string> {
    const remembered = window.localStorage.getItem(ANDROID_LOG_FOLDER_KEY);
    const treeUri = remembered ?? await this.rememberAndroidLogFolder();
    try {
      await this.invokeWithLogging("syncpeer_android_save_text_file", {
        request: { fileName, text, mimeType: "text/plain", treeUri },
      });
      return fileName;
    } catch (error) {
      // A revoked SAF grant must not keep failing forever; the next attempt re-picks.
      if (remembered) window.localStorage.removeItem(ANDROID_LOG_FOLDER_KEY);
      throw error;
    }
  }

  private async rememberAndroidLogFolder(): Promise<string> {
    const picked = await this.pickAndroidSafDirectory();
    window.localStorage.setItem(ANDROID_LOG_FOLDER_KEY, picked);
    return picked;
  }

  private async shareAndroidTextFile(fileName: string, text: string): Promise<void> {
    await this.invokeWithLogging("syncpeer_android_share_text_file", {
      request: { fileName, text, mimeType: "text/plain", chooserTitle: "Share Syncpeer logs" },
    });
  }

  private listAndroidContacts() {
    return this.invokeWithLogging<Awaited<ReturnType<NonNullable<SyncpeerPlatformAdapter["listAndroidContacts"]>>>>(
      "syncpeer_android_list_contacts",
    );
  }
  private upsertAndroidContact(input: Parameters<NonNullable<SyncpeerPlatformAdapter["upsertAndroidContact"]>>[0]) {
    return this.invokeWithLogging<Awaited<ReturnType<NonNullable<SyncpeerPlatformAdapter["upsertAndroidContact"]>>>>(
      "syncpeer_android_upsert_contact", { request: input },
    );
  }
  private deleteAndroidContact(contactId: string) {
    return this.invokeWithLogging<Awaited<ReturnType<NonNullable<SyncpeerPlatformAdapter["deleteAndroidContact"]>>>>(
      "syncpeer_android_delete_contact", { request: { contactId } },
    );
  }
  private listAndroidCalendarEvents(args?: Parameters<NonNullable<SyncpeerPlatformAdapter["listAndroidCalendarEvents"]>>[0]) {
    return this.invokeWithLogging<Awaited<ReturnType<NonNullable<SyncpeerPlatformAdapter["listAndroidCalendarEvents"]>>>>(
      "syncpeer_android_list_calendar_events", { request: args ?? {} },
    );
  }
  private upsertAndroidCalendarEvent(input: Parameters<NonNullable<SyncpeerPlatformAdapter["upsertAndroidCalendarEvent"]>>[0]) {
    return this.invokeWithLogging<Awaited<ReturnType<NonNullable<SyncpeerPlatformAdapter["upsertAndroidCalendarEvent"]>>>>(
      "syncpeer_android_upsert_calendar_event", { request: input },
    );
  }
  private deleteAndroidCalendarEvent(eventId: string) {
    return this.invokeWithLogging<Awaited<ReturnType<NonNullable<SyncpeerPlatformAdapter["deleteAndroidCalendarEvent"]>>>>(
      "syncpeer_android_delete_calendar_event", { request: { eventId } },
    );
  }
  private exportIdentityRecovery(): Promise<IdentityRecoveryExportResponse> {
    return this.invokeWithLogging<IdentityRecoveryExportResponse>("syncpeer_export_identity_recovery");
  }
  private async restoreIdentityRecovery(recoverySecret: string): Promise<void> {
    await this.invokeWithLogging<CliNodeIdentityResponse>("syncpeer_restore_identity_recovery", { request: { recoverySecret } });
  }
  private getDefaultDeviceId(): Promise<string> {
    return this.invokeWithLogging<string>("syncpeer_get_default_device_id");
  }
  private regenerateDefaultIdentity(): Promise<string> {
    return this.invokeWithLogging<string>("syncpeer_regenerate_default_cli_identity");
  }
  private async logError(event: string, details: Record<string, unknown>): Promise<void> {
    await tryForwardUiErrorToCli(this.invokeWithLogging, event, details);
  }

  private hostAdapter(): SyncpeerHostAdapter {
    return {
      kdf: createWorkerPasswordKdf(),
      connectTls: (args) => this.connectTls(args),
      listenTls: (args) => this.listenTls(args),
      listenRelay: (args) => this.listenRelay(args),
      connectQuic: (args) => this.connectQuic(args),
      connectRelay: (args) => this.connectRelay(args),
      sha256: (data) => this.sha256(data),
      randomBytes: (length) => this.randomBytes(length),
      discoveryFetch: createNativeDiscoveryFetch(({ operation, ...request }) => this.invokeWithLogging({
        discoveryPrepare: "syncpeer_discovery_prepare", discoveryFetch: "syncpeer_discovery_fetch",
        discoveryCancel: "syncpeer_discovery_cancel",
      }[operation], { request })),
      discoverLocalCandidates: (args) => this.discoverLocalCandidates(args),
      log: (event, details) => logUi(this.options, event, details),
    };
  }

  private platformSharing(): Pick<SyncpeerPlatformAdapter,
    "sessionConfigurationRevision" | "onSessionConfigurationChange" | "releaseLocalCopy" |
    "prepareBackgroundSession" | "startBackgroundSession" | "stopBackgroundSession"> {
    return {
      sessionConfigurationRevision: () => this.configurationRevision,
      onSessionConfigurationChange: listener => { this.sessionConfigurationListeners.add(listener); },
      releaseLocalCopy: (folderId, mode, confirmedText, sessions) =>
        this.releaseLocalCopy(folderId, mode, confirmedText, sessions),
      prepareBackgroundSession: this.platform === "android"
        ? options => this.prepareBackgroundSession(options) : undefined,
      startBackgroundSession: this.platform === "android"
        ? options => this.startBackgroundSession(options) : undefined,
      stopBackgroundSession: this.platform === "android"
        ? () => this.stopBackgroundSession() : undefined,
    };
  }

  private platformFiles(): Pick<SyncpeerPlatformAdapter,
    "readTextFile" | "readBinaryFile" | "readCachedFile" | "readDefaultIdentity" |
    "listFavorites" | "upsertFavorite" | "removeFavorite" | "cacheFile" |
    "createFileDownloadSink" | "listCachedFiles" | "digestCachedFiles" | "getCachedStatuses" |
    "openCachedFile" | "openCachedFileDirectory" | "openCachedDirectory" | "removeCachedFile" | "clearCache"> {
    return {
      readTextFile: async path => this.invokeWithLogging<string>("syncpeer_read_text_file", { request: { path } }),
      readBinaryFile: async path => new Uint8Array(await this.invokeWithLogging<number[]>("syncpeer_read_binary_file", { request: { path } })),
      readCachedFile: async (folderId, path) => new Uint8Array(await this.invokeWithLogging<number[]>("syncpeer_read_cached_file", { request: { folderId, path } })),
      readDefaultIdentity: async () => this.invokeWithLogging<CliNodeIdentityResponse>("syncpeer_read_default_cli_identity"),
      listFavorites: async () => this.invokeWithLogging<FavoriteRecord[]>("syncpeer_list_favorites"),
      upsertFavorite: async favorite => this.invokeWithLogging<FavoriteRecord[]>("syncpeer_upsert_favorite", { request: { favorite } }),
      removeFavorite: async key => this.invokeWithLogging<FavoriteRecord[]>("syncpeer_remove_favorite", { request: { key } }),
      cacheFile: (folderId, path, name, bytes, modifiedMs) => this.cacheFile(folderId, path, name, bytes, modifiedMs),
      createFileDownloadSink: args => this.createFileDownloadSink(args),
      listCachedFiles: () => this.listCachedFiles(),
      digestCachedFiles: files => this.digestCachedFiles(files),
      getCachedStatuses: (folderId, paths) => this.getCachedStatuses(folderId, paths),
      openCachedFile: (folderId, path) => this.openCachedFile(folderId, path),
      openCachedFileDirectory: (folderId, path) => this.openCachedFileDirectory(folderId, path),
      openCachedDirectory: (folderId, path) => this.openCachedDirectory(folderId, path),
      removeCachedFile: (folderId, path) => this.removeCachedFile(folderId, path),
      clearCache: () => this.clearCache(),
    };
  }

  private platformTransfer(): Pick<SyncpeerPlatformAdapter,
    "startTransfer" | "stopTransfer" | "updateTransferNotification"> {
    return {
      startTransfer: label => this.startTransfer(label),
      stopTransfer: () => this.stopTransfer(),
      updateTransferNotification: args => this.updateTransferNotification(args),
    };
  }

  private platformAndroid(): Pick<SyncpeerPlatformAdapter,
    "getAndroidSafTreeUri" | "pickAndroidSafDirectory" | "setAndroidSafTreeUri" |
    "listAndroidPersistedSafUris" | "listAndroidContacts" | "upsertAndroidContact" |
    "deleteAndroidContact" | "listAndroidCalendarEvents" | "upsertAndroidCalendarEvent" |
    "deleteAndroidCalendarEvent"> {
    return {
      getAndroidSafTreeUri: () => this.getAndroidSafTreeUri(),
      pickAndroidSafDirectory: () => this.pickAndroidSafDirectory(),
      setAndroidSafTreeUri: treeUri => this.setAndroidSafTreeUri(treeUri),
      listAndroidPersistedSafUris: () => this.listAndroidPersistedSafUris(),
      listAndroidContacts: () => this.listAndroidContacts(),
      upsertAndroidContact: input => this.upsertAndroidContact(input),
      deleteAndroidContact: contactId => this.deleteAndroidContact(contactId),
      listAndroidCalendarEvents: args => this.listAndroidCalendarEvents(args),
      upsertAndroidCalendarEvent: input => this.upsertAndroidCalendarEvent(input),
      deleteAndroidCalendarEvent: eventId => this.deleteAndroidCalendarEvent(eventId),
    };
  }

  private platformIdentity(): Pick<SyncpeerPlatformAdapter,
    "exportIdentityRecovery" | "restoreIdentityRecovery" | "getDefaultDeviceId" |
    "regenerateDefaultIdentity" | "logError"> {
    return {
      exportIdentityRecovery: () => this.exportIdentityRecovery(),
      restoreIdentityRecovery: recoverySecret => this.restoreIdentityRecovery(recoverySecret),
      getDefaultDeviceId: () => this.getDefaultDeviceId(),
      regenerateDefaultIdentity: () => this.regenerateDefaultIdentity(),
      logError: (event, details) => this.logError(event, details),
    };
  }

  private platformAdapter(): SyncpeerPlatformAdapter {
    return {
      ...this.platformSharing(),
      ...this.platformFiles(),
      ...this.platformTransfer(),
      ...this.platformAndroid(),
      ...this.platformIdentity(),
    };
  }

  private documents() {
    return createDocumentCache({ legacy: this.platformAdapter(),
      enabled: () => detectRuntimeEnvironment() === "tauri",
      request: (request) => this.documentRequest(request),
      openLegacySource: async file => {
        if (!file.localPath?.startsWith("/") || file.safRelativePath) {
          throw new Error("This folder uses external storage. Its existing plaintext files were left unchanged; import them through the file picker explicitly.");
        }
        const separator = file.localPath.lastIndexOf("/"), name = file.localPath.slice(separator + 1);
        const bytes = await this.nativeStorage(file.localPath.slice(0, separator));
        try {
          const original = await bytes.stat(name);
          if (!original || original.type !== "file") throw new Error("Cached file is unavailable.");
          return { size: original.size, readRange: (offset, size) => bytes.readRange(name, offset, size),
            verify: async () => {
              const current = await bytes.stat(name);
              if (!current || current.revision !== original.revision) throw new Error("Cached file changed during migration.");
            }, close: bytes.close };
        } catch (error) {
          await bytes.close();
          throw error;
        }
      },
      show: async id => { await this.invokeWithLogging("syncpeer_document_command", { request: { operation: "show", id } }); },
    });
  }

  private folderCredentials() {
    return detectRuntimeEnvironment() === "tauri" ? {
      load: () => this.documentRequest<Record<string, string>>({ operation: "connectionPasswords" }),
      save: async (passwords: Record<string, string>) => { await this.documentRequest({ operation: "saveConnectionPasswords", passwords }); },
      merge: async (passwords: Record<string, string>) => { await this.documentRequest({ operation: "mergeConnectionPasswords", passwords }); },
    } : undefined;
  }

  private biometric() {
    return this.platform === "android" ? {
      status: async () => this.invokeWithLogging<{ available: boolean; enabled: boolean }>("syncpeer_android_biometric_status", { request: { profileId: "documents" } }),
      setEnabled: async (enabled: boolean) => this.invokeWithLogging<{ available: boolean; enabled: boolean }>("syncpeer_android_biometric_set_enabled", { request: { profileId: "documents", enabled } }),
      authenticate: async () => this.invokeWithLogging<boolean>("syncpeer_android_biometric_authenticate", { request: { profileId: "documents" } }),
    } : undefined;
  }

  api() {
    const documents = this.documents();
    const platformAdapter = this.platform === "android"
      ? { ...documents.platformAdapter, sessionSharedFolders: async () => [], incomingSessionOwnedByService: true }
      : documents.platformAdapter;
    return {
      hostAdapter: this.hostAdapter(),
      platformAdapter,
      documentCommand: <T>(request: Record<string, unknown>) => this.documentRequest<T>(request),
      connectDocumentFolder: documents.connectFolder,
      disconnectDocumentFolder: documents.disconnectFolder,
      syncDocumentFolders: documents.syncFolders,
      folderCredentials: this.folderCredentials(),
      biometric: this.biometric(),
      logFile: this.platform === "android" ? {
        save: (fileName: string, text: string) => this.saveAndroidTextFile(fileName, text),
        share: (fileName: string, text: string) => this.shareAndroidTextFile(fileName, text),
      } : undefined,
    };
  }
}

export const createTauriAdapters = (
  options?: CreateTauriAdaptersOptions,
) => new TauriAdapters(options).api();
const createNativeTlsListener = (invoke: InvokeFn, opened: TlsListenResponse, relayAddress?: string,
  useRawBody = true) => {
  let closed = false;
  return {
    port: opened.port,
    accept: async () => {
      while (!closed) {
        try {
          const accepted = await invoke<TlsAcceptResponse>("syncpeer_tls_accept", {
            request: { listenerId: opened.listenerId, timeoutMs: 60_000 },
          });
          const socket = { socket: createTlsSocket(invoke, Number(accepted.sessionId),
            new Uint8Array(accepted.peerCertificateDer), "syncpeer_tls", useRawBody),
            remoteAddress: accepted.remoteAddress,
          remotePort: accepted.remotePort, alpn: accepted.alpn };
          return relayAddress ? { ...socket,
            connectedVia: `${relayAddress} -> ${accepted.remoteAddress}:${accepted.remotePort}`,
            transportKind: "relay" as const, connectionScope: "wan" as const } : socket;
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
