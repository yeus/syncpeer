// JavaScriptEngine has no browser text codecs; install the standard UTF-8 shim
// before loading core. Encryption and authenticated file layout stay in core.
import "./document-runtime-polyfills.js";
import { createNativeDiscoveryFetch } from "../../core/src/sync/nativeDiscovery.js";
import { automaticRelayConfiguration } from "../../core/src/sync/automaticRelayPresence.js";
import { installAndroidTimers } from "./document-runtime-polyfills.js";
import { createPortRequest } from "./document-runtime-port.js";
import { createDocumentFilesystem } from "../../core/src/sync/documentFilesystem.js";
import { dispatchDocumentCommandWithSessionConfiguration } from "../../core/src/sync/documentCommands.js";
import { createNativeFilesystem } from "../../core/src/sync/nativeFilesystem.js";
import { deriveUntrustedFolderCrypto } from "../../core/src/core/model/untrusted.js";
import { createEncryptedDownloadSink, loadEncryptedDiskMetadata, readEncryptedDiskRange } from "../../core/src/sync/encryptedFilesystem.js";
import { certificateDerFromPem, createSyncpeerCoreClient, deviceIdFromCertificate,
  type SyncpeerConnectOptions, type SyncpeerHostAdapter, type SyncpeerTlsSocket,
  type SyncpeerSessionHandle } from "../../core/src/client.js";
import type { ConnectOptions } from "../../core/src/ui/browserClient.js";
import { createConnectionLifecycle, waitForLifecyclePhase,
  type ConnectionLifecycle, type ConnectionLifecycleState } from "../../core/src/ui/connectionLifecycle.js";
import { startIncomingPeerService } from "../../core/src/sync/incomingPeerService.js";
import { preferredPeerDirection } from "../../core/src/sync/peerSessionManager.js";
import { resolveFolderPasswordsForDevice } from "../../core/src/ui/sessionPasswords.js";
import { resolveApprovedPeerDeviceIds, resolveIncomingPeerDeviceIds } from "../../core/src/sync/personalSpaceSharing.js";
import { sameDeviceId } from "../../core/src/ui/helpers.js";
import { syncServiceFileFavorites } from "../../core/src/sync/serviceFavoriteSync.js";
import { executeServiceRemoteCommand } from "../../core/src/sync/serviceRemoteCommands.js";
import { createServiceDownloadBridge } from "../../core/src/sync/serviceDownloadBridge.js";
import { createServiceUploadBridge } from "../../core/src/sync/serviceUploadBridge.js";
import { decodeBase64 } from "../../core/src/transfer/base64.js";
import { parseServiceCommand } from "../../core/src/sync/serviceProtocol.js";

type AndroidRuntime = { getNamedPort: (name: string) => Promise<MessagePort> };
type AndroidRuntimeRequest = (input: object) => Promise<unknown>;

const createAndroidSessionAdapter = async (
  android: AndroidRuntime,
): Promise<{ adapter: SyncpeerHostAdapter; request: AndroidRuntimeRequest }> => {
  const request = createPortRequest(await android.getNamedPort("network"));
  const socket = (sessionId: number, peerCertificateDer: Uint8Array, transport: "tls" | "quic" = "tls"): SyncpeerTlsSocket => ({
    peerCertificateDer: async () => peerCertificateDer,
    read: async (maxBytes?: number) => {
      const value = await request({ operation: transport === "quic" ? "quicRead" : "tlsRead", sessionId, maxBytes: maxBytes ?? null }) as { bytes: number[]; eof: boolean };
      if (value.eof) throw new Error("Connection closed");
      return new Uint8Array(value.bytes);
    },
    write: async (bytes: Uint8Array) => { await request({ operation: transport === "quic" ? "quicWrite" : "tlsWrite", sessionId, bytes: [...bytes] }); },
    close: async () => { await request({ operation: transport === "quic" ? "quicClose" : "tlsClose", sessionId }); },
  });
  const listener = (opened: { listenerId: number; port: number }, relayAddress?: string) => {
    let closed = false;
    return {
      port: Number(opened.port),
      accept: async () => {
        while (!closed) {
          try {
            const accepted = await request({ operation: "tlsAccept", listenerId: opened.listenerId,
              timeoutMs: 60_000 }) as { sessionId: number; peerCertificateDer: number[];
              remoteAddress: string; remotePort: number; alpn: string };
            const result = { socket: socket(Number(accepted.sessionId), new Uint8Array(accepted.peerCertificateDer)),
              remoteAddress: accepted.remoteAddress, remotePort: Number(accepted.remotePort), alpn: accepted.alpn };
            return relayAddress ? { ...result,
              connectedVia: `${relayAddress} -> ${accepted.remoteAddress}:${accepted.remotePort}`,
              transportKind: "relay" as const, connectionScope: "wan" as const } : result;
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
        await request({ operation: "tlsListenerClose", listenerId: opened.listenerId });
      },
    };
  };
  const adapter: SyncpeerHostAdapter = {
    log: (event, details) => {
      if (!event.startsWith("core.session.connect.") &&
        !["core.upload.request.failed", "core.replica.receive.failed"].includes(event)) return;
      void request({ operation: "diagnostic", event,
        message: typeof details?.message === "string" ? details.message : "Unknown runtime failure." });
    },
    connectTls: async ({ host, port, certPem, keyPem, caPem, timeoutMs, signal, alpnProtocols }) => {
      const value = await request({ operation: "tlsOpen", host, port, certPem, keyPem, caPem: caPem ?? null,
        timeoutMs: timeoutMs ?? null, alpnProtocols: [...alpnProtocols ?? ["bep/1.0"]] }) as { sessionId: number; peerCertificateDer: number[] };
      const result = socket(Number(value.sessionId), new Uint8Array(value.peerCertificateDer));
      if (signal?.aborted) { await result.close(); throw new Error("Connection attempt was cancelled."); }
      return result;
    },
    listenTls: async ({ host, port, certPem, keyPem, alpnProtocols, handshakeTimeoutMs }) => {
      const opened = await request({ operation: "tlsListen", host, port, certPem, keyPem,
        alpnProtocols: [...alpnProtocols], handshakeTimeoutMs: handshakeTimeoutMs ?? null }) as {
        listenerId: number; port: number;
      };
      return listener(opened);
    },
    listenRelay: async ({ relayAddress, certPem, keyPem, alpnProtocols, handshakeTimeoutMs }) => {
      const opened = await request({ operation: "relayListen", relayAddress, certPem, keyPem,
        alpnProtocols: [...alpnProtocols], handshakeTimeoutMs: handshakeTimeoutMs ?? null }) as {
        listenerId: number; port: number;
      };
      return listener(opened, relayAddress);
    },
    connectQuic: async ({ host, port, certPem, keyPem, caPem, timeoutMs, keepaliveMs, idleTimeoutMs, signal }) => {
      const value = await request({ operation: "quicOpen", host, port, certPem, keyPem, caPem: caPem ?? null,
        timeoutMs: timeoutMs ?? null, keepaliveMs, idleTimeoutMs }) as { sessionId: number; peerCertificateDer: number[] };
      const result = socket(Number(value.sessionId), new Uint8Array(value.peerCertificateDer), "quic");
      if (signal?.aborted) { await result.close(); throw new Error("Connection attempt was cancelled."); }
      return result;
    },
    connectRelay: async ({ relayAddress, expectedDeviceId, certPem, keyPem, caPem, timeoutMs, signal }) => {
      const value = await request({ operation: "relayOpen", relayAddress, expectedDeviceId, certPem, keyPem,
        caPem: caPem ?? null, timeoutMs: timeoutMs ?? null }) as {
        sessionId: number; peerCertificateDer: number[]; connectedVia?: string;
      };
      const result = socket(Number(value.sessionId), new Uint8Array(value.peerCertificateDer));
      if (signal?.aborted) { await result.close(); throw new Error("Connection attempt was cancelled."); }
      return { connectedVia: value.connectedVia ?? relayAddress, socket: result };
    },
    sha256: async bytes => new Uint8Array(await request({ operation: "sha256", bytes: [...bytes] }) as number[]),
    randomBytes: async size => new Uint8Array(await request({ operation: "random", size }) as number[]),
    discoveryFetch: createNativeDiscoveryFetch(request),
    discoverLocalCandidates: async ({ expectedDeviceId, timeoutMs }) => {
      const response = await request({ operation: "discoverLocal", expectedDeviceId: expectedDeviceId || null, timeoutMs: timeoutMs ?? null }) as { candidates: Array<{ address: string; protocol: string; host?: string; port?: number; deviceId?: string }> };
      return response.candidates.map(candidate => ({ ...candidate,
        protocol: candidate.protocol === "tcp" || candidate.protocol === "quic" || candidate.protocol === "relay" ? candidate.protocol : "unknown" as const,
      }));
    },
  };
  return { adapter, request };
};

async function startDocuments(android: AndroidRuntime) {
  await installAndroidTimers(android);
  const port = await android.getNamedPort("storage");
  const request = createPortRequest(port);
  const native = (input: object) => request({ method: "storage", input });
  const openStorage = async (id: string) => createNativeFilesystem(native, String(await request({ method: "root", idValue: id })));
  const secret = (operation: string, value?: string) => request({ method: "secret", operation, secret: value });
  let sessionConfigurationRevision = 0;
  const sessionConfigurationListeners = new Set<() => void>();
  const invalidateSessionConfiguration = () => {
    sessionConfigurationRevision++;
    for (const listener of sessionConfigurationListeners) listener();
  };
  const documents = createDocumentFilesystem({ profileId: "documents", profile: await openStorage("profile"), openStorage,
    deviceCounterId: String(await request({ method: "counter" })),
    randomBytes: async size => new Uint8Array(await request({ method: "random", size }) as number[]),
    availableBytes: async () => Number(await request({ method: "availableBytes" })),
    rememberedSecret: { load: async () => await secret("load") as string | null, save: async value => { await secret("save", value); },
      remove: async () => { await secret("remove"); }, isDeviceUnlocked: async () => await secret("isDeviceUnlocked") === true },
    onSessionConfigurationChange: invalidateSessionConfiguration });
  await documents.initialize();
  return {
    command: (input: unknown) => dispatchDocumentCommandWithSessionConfiguration(
      documents, input, invalidateSessionConfiguration),
    sessionConfigurationRevision: () => sessionConfigurationRevision,
    onSessionConfigurationChange: (listener: () => void) => { sessionConfigurationListeners.add(listener); },
    releaseLocalCopy: documents.releaseLocalCopy,
    close: documents.close,
    connectionPasswords: documents.connectionPasswords,
    status: documents.status,
    ownedDevices: documents.ownedDevices,
    sessionSharedFolders: documents.sessionSharedFolders,
    rememberFolder: documents.rememberFolder,
    syncFavorites: (remoteFs: Parameters<typeof syncServiceFileFavorites>[1], excludeFolderIds: readonly string[]) =>
      syncServiceFileFavorites(documents, remoteFs, { excludeFolderIds }),
  };
}

type Documents = Awaited<ReturnType<typeof startDocuments>>;

type IncomingContext = {
  localDeviceId: string;
  approvedDeviceIds: string[];
  listenPort: number;
  automaticRelay: ReturnType<typeof automaticRelayConfiguration>;
  key: string;
  remoteDeviceId: string;
  revision: number;
  saved: Record<string, string>;
  unlocked: boolean;
};

class AndroidSessionRuntime {
  private activeOptions: ConnectOptions | null = null;
  private sharedFolderIds: string[] = [];
  private incomingService: Awaited<ReturnType<typeof startIncomingPeerService>> | null = null;
  private incomingServiceKey = "";
  private incomingServiceClosing: Promise<unknown> = Promise.resolve();
  private readonly lifecycle: ConnectionLifecycle<ConnectOptions>;
  private readonly downloads = createServiceDownloadBridge(async (folderId, path, sink, signal) => {
    const session = this.lifecycle.getSession();
    if (!session || session.isClosed()) throw new Error("Peer is no longer connected.");
    await session.remoteFs.readFileToSink(folderId, path, sink, undefined, signal);
  });
  private readonly uploads = createServiceUploadBridge(async (folderId, path, source, options) => {
    const session = this.lifecycle.getSession();
    if (!session || session.isClosed()) throw new Error("Peer is no longer connected.");
    await session.remoteFs.writeFileStream(folderId, path, source, options);
  });

  private peerStatusUnsubscribe: (() => void) | null = null;

  private constructor(
    private readonly documents: Documents,
    private readonly adapter: SyncpeerHostAdapter,
    private readonly core: ReturnType<typeof createSyncpeerCoreClient>,
    private readonly nativeRequest: AndroidRuntimeRequest,
  ) {
    this.lifecycle = this.createLifecycle();
  }

  static async create(android: AndroidRuntime, documents: Documents): Promise<AndroidSessionRuntime> {
    const { adapter, request } = await createAndroidSessionAdapter(android);
    return new AndroidSessionRuntime(documents, adapter, createSyncpeerCoreClient(adapter), request);
  }

  private reportPeerStatus = (state: ConnectionLifecycleState) => {
    void this.nativeRequest({
      operation: "sessionPeerStatus",
      phase: state.phase,
      attempt: state.attempt,
      error: state.closureReason ?? undefined,
    }).catch(() => undefined);
  };

  start() {
    // Push the TypeScript lifecycle to the native service so UI status events
    // distinguish waiting/reconnecting from a confirmed connected socket.
    this.peerStatusUnsubscribe = this.lifecycle.subscribe(this.reportPeerStatus);
    this.documents.onSessionConfigurationChange(() => {
      setTimeout(() => {
        void (async () => {
          await this.stopIncomingService();
          if (!this.activeOptions) return;
          await this.lifecycle.ensureSession(this.activeOptions);
        })().catch(() => undefined);
      }, 0);
    });
    return { command: this.command, close: this.close };
  }

  private createLifecycle(): ConnectionLifecycle<ConnectOptions> {
    return createConnectionLifecycle<ConnectOptions>({
      open: (options, signal) => this.openSession(options, signal),
      keyFor: options => JSON.stringify({ host: options.host, port: options.port, remoteId: options.remoteId ?? "", deviceName: options.deviceName,
        // Shared-folder credentials and the replica receiver are resolved from
        // the document owner when the session opens. A later folder attach,
        // favorite or credential change must invalidate the live session so it
        // reopens with the current selection.
        sessionConfigurationRevision: this.documents.sessionConfigurationRevision() }),
    });
  }

  private stopIncomingService = () => {
    const service = this.incomingService;
    this.incomingService = null;
    this.incomingServiceKey = "";
    const closing = this.incomingServiceClosing.then(() => service?.close());
    this.incomingServiceClosing = closing.catch(() => undefined);
    return closing;
  };

  private prepareIncomingContext = async (
    options: ConnectOptions,
    coreOptions: SyncpeerConnectOptions,
  ): Promise<IncomingContext | null> => {
    if (!coreOptions.expectedDeviceId) return null;
    const localDeviceId = await deviceIdFromCertificate(this.adapter,
      certificateDerFromPem(coreOptions.certPem));
    const trustedDevices = (await this.documents.ownedDevices().catch(() => ({ devices: [] }))).devices;
    const approvedDeviceIds = resolveIncomingPeerDeviceIds(coreOptions.expectedDeviceId,
      localDeviceId, trustedDevices);
    if (!approvedDeviceIds.length) { await this.stopIncomingService(); return null; }
    const listenPort = options.listenPort ?? 22000;
    if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
      throw new Error("Incoming TCP port must be between 1 and 65535.");
    }
    const automaticRelay = automaticRelayConfiguration(options);
    const key = JSON.stringify([localDeviceId, approvedDeviceIds,
      coreOptions.certPem, coreOptions.keyPem, listenPort, automaticRelay]);
    return {
      localDeviceId,
      approvedDeviceIds,
      listenPort,
      automaticRelay,
      key,
      remoteDeviceId: coreOptions.expectedDeviceId,
      revision: this.documents.sessionConfigurationRevision(),
      saved: await this.documents.connectionPasswords().catch(() => ({})),
      unlocked: (await this.documents.status()).vault.phase === "unlocked",
    };
  };

  private prepareIncomingSessions = async (
    context: IncomingContext,
    options: ConnectOptions,
    coreOptions: SyncpeerConnectOptions,
  ): Promise<Map<string, SyncpeerConnectOptions>> => {
    const prepared = new Map<string, SyncpeerConnectOptions>();
    for (const remote of context.approvedDeviceIds) {
      try {
        const folderPasswords = {
          ...resolveFolderPasswordsForDevice(context.saved, remote),
          ...(sameDeviceId(remote, options.remoteId ?? "") ? options.folderPasswords : {}),
        };
        const sharedFolders = context.unlocked
          ? sameDeviceId(remote, context.remoteDeviceId) && coreOptions.sharedFolders
            ? coreOptions.sharedFolders : await this.documents.sessionSharedFolders(remote)
          : [];
        prepared.set(remote.replace(/[^A-Z2-7]/gi, "").toUpperCase(),
          { ...coreOptions, expectedDeviceId: remote, folderPasswords, sharedFolders });
      } catch (error) {
        this.adapter.log?.("core.incoming.prepare.failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return prepared;
  };

  private ensureIncomingService = async (
    options: ConnectOptions,
    coreOptions: SyncpeerConnectOptions,
  ) => {
    const context = await this.prepareIncomingContext(options, coreOptions);
    if (!context) return null;
    const prepared = await this.prepareIncomingSessions(context, options, coreOptions);
    const sessionHandlers = {
      connectionOptions: (remote: string, endpoint: { host: string; port: number }) => {
        if (context.revision !== this.documents.sessionConfigurationRevision()) {
          throw new Error("Incoming peer folder preparation changed; reconnect to refresh it.");
        }
        const ready = prepared.get(remote.replace(/[^A-Z2-7]/gi, "").toUpperCase());
        if (!ready) throw new Error("Incoming peer folder preparation is unavailable.");
        return { ...ready, ...endpoint };
      },
      onSession: (session: SyncpeerSessionHandle) => {
        if (preferredPeerDirection(context.localDeviceId, context.remoteDeviceId) !== "incoming") return;
        void this.lifecycle.adopt(options, session);
      },
    };
    if (context.revision !== this.documents.sessionConfigurationRevision()) {
      throw new Error("Incoming peer folder preparation changed before the listener started.");
    }
    if (this.incomingService && this.incomingServiceKey === context.key) {
      this.incomingService.updateSessionHandlers(sessionHandlers);
      return this.incomingService;
    }
    await this.stopIncomingService();
    this.incomingService = await startIncomingPeerService(this.adapter, {
      host: "0.0.0.0", port: context.listenPort, certPem: coreOptions.certPem, keyPem: coreOptions.keyPem,
      localDeviceId: context.localDeviceId, approvedDeviceIds: context.approvedDeviceIds,
      automaticRelay: context.automaticRelay, ...sessionHandlers,
      onError: error => this.adapter.log?.("core.incoming.failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    });
    this.incomingServiceKey = context.key;
    return this.incomingService;
  };

  private resolveCoreOptions = async (options: ConnectOptions): Promise<SyncpeerConnectOptions> => {
    let passwords: Record<string, string> = {};
    try {
      passwords = await this.documents.connectionPasswords();
    } catch {
      // A manually locked document vault must not prevent the authenticated
      // metadata session from reconnecting.  The foreground client can
      // unlock it later before requesting a favorite download.
    }
    if (!options.cert || !options.key) throw new Error("Background session is missing the resolved identity.");
    const trustedDevices = (await this.documents.ownedDevices().catch(() => ({ devices: [] }))).devices;
    if (options.remoteId && !resolveApprovedPeerDeviceIds(options.remoteId, trustedDevices)
      .some(id => sameDeviceId(id, options.remoteId!))) {
      throw new Error("This peer was removed from the trusted device list.");
    }
    const folderPasswords = {
      ...resolveFolderPasswordsForDevice(passwords, options.remoteId ?? ""),
      ...options.folderPasswords,
    };
    const sharedFolders = await this.documents.sessionSharedFolders(options.remoteId ?? "");
    return {
      host: options.host,
      port: options.port,
      certPem: options.cert,
      keyPem: options.key,
      discoveryMode: options.discoveryMode,
      discoveryServer: options.discoveryServer,
      expectedDeviceId: options.remoteId,
      deviceName: options.deviceName,
      timeoutMs: options.timeoutMs,
      enableRelayFallback: options.enableRelayFallback,
      relayOnly: options.relayOnly,
      quicOnly: options.quicOnly,
      folderPasswords,
      sharedFolders,
    };
  };

  private openSession = async (
    options: ConnectOptions,
    signal: AbortSignal,
  ): Promise<SyncpeerSessionHandle> => {
    const coreOptions = await this.resolveCoreOptions(options);
    let listenerFailure: unknown;
    let service: Awaited<ReturnType<typeof startIncomingPeerService>> | null = null;
    try { service = await this.ensureIncomingService(options, coreOptions); }
    catch (error) { listenerFailure = error; }
    let session;
    try { session = await this.core.openSession(coreOptions, signal); }
    catch (error) {
      if (listenerFailure) throw new AggregateError([error, listenerFailure],
        `Could not connect to the peer or start the incoming LAN listener on TCP port ${options.listenPort ?? 22000}.`,
        { cause: error });
      throw error;
    }
    if (service && options.remoteId) {
      const admitted = await service.admitOutgoing(options.remoteId, session.connectedVia, session);
      if (!admitted) {
        const remote = options.remoteId.replace(/[^A-Z2-7]/gi, "").toUpperCase();
        const selected = service.activeSessions().find(candidate => candidate.remoteDeviceId === remote);
        if (!selected) throw new Error("The authenticated peer session was replaced before it became active.");
        session = selected.session;
      }
    }
    this.sharedFolderIds = coreOptions.sharedFolders?.map(folder => folder.id) ?? [];
    return session;
  };

  private connectSession = async (options: ConnectOptions): Promise<SyncpeerSessionHandle> => {
    try {
      return await this.lifecycle.connect(options);
    } catch (error) {
      // The lifecycle keeps retrying after a failed opening, for example when
      // the foreground app's session briefly overlaps the background handoff.
      // The service needs the runtime-bound session rather than the first
      // rejection, so wait for the lifecycle's own retry to connect.
      const phase = this.lifecycle.getState().phase;
      if (phase !== "waiting" && phase !== "reconnecting" && phase !== "connecting") {
        this.adapter.log?.("core.session.connect.failed", { message: phase });
        throw error;
      }
      this.adapter.log?.("core.session.connect.retrying", { message: phase });
      const connected = await waitForLifecyclePhase(this.lifecycle, "connected", 60_000);
      if (!connected) {
        this.adapter.log?.("core.session.connect.failed", { message: this.lifecycle.getState().phase });
        throw error;
      }
      this.adapter.log?.("core.session.connect.recovered", {});
      return await this.lifecycle.ensureSession(options);
    }
  };

  private connectCommand = async (request: Record<string, unknown>) => {
    if (!request.options || typeof request.options !== "object" || Array.isArray(request.options)) {
      throw new Error("Session connect options are missing.");
    }
    const options = request.options as ConnectOptions;
    this.activeOptions = options;
    const session = await this.connectSession(options);
    // Remember newly advertised roots. Folders already attached to the
    // DocumentsProvider are supplied above as explicit full replicas;
    // unattached folders remain metadata-only until selected.
    for (const folder of await session.remoteFs.listFolders()) {
      await this.documents.rememberFolder({ id: folder.id, label: folder.label || folder.id });
    }
    return { phase: this.lifecycle.getState().phase };
  };

  private disconnectCommand = async () => {
    this.downloads.cancelAll();
    this.uploads.cancelAll();
    this.activeOptions = null;
    this.sharedFolderIds = [];
    await this.lifecycle.disconnect();
    await this.stopIncomingService();
    return { phase: "idle" };
  };

  private syncFavoritesCommand = async () => {
    const session = this.lifecycle.getSession();
    if (!session) return { phase: "waiting" };
    return this.documents.syncFavorites(session.remoteFs, this.sharedFolderIds);
  };

  private releaseLocalCopyCommand = async (request: Record<string, unknown>) => {
    if (typeof request.folderId !== "string" || !request.folderId || request.folderId.length > 4096) {
      throw new Error("Invalid release folder identity.");
    }
    let result;
    if (request.mode === "dangerous") {
      if (typeof request.confirmedText !== "string") throw new Error("Release confirmation is missing.");
      result = await this.documents.releaseLocalCopy(request.folderId,
        { mode: "dangerous", confirmedText: request.confirmedText });
    } else {
      if (request.mode !== "safe") throw new Error("Invalid local release mode.");
      const sessions = [...this.incomingService?.activeSessions().map(value => value.session) ?? [],
        ...(this.lifecycle.getSession() ? [this.lifecycle.getSession()!] : [])]
        .filter(session => !session.isClosed());
      if (!sessions.length) throw new Error("No peer connected to the Android background service for safe release.");
      result = await this.documents.releaseLocalCopy(request.folderId, { mode: "safe", sessions });
    }
    this.downloads.cancelAll();
    this.uploads.cancelAll();
    await this.lifecycle.disconnect();
    await this.stopIncomingService();
    this.sharedFolderIds = [];
    return result;
  };

  private command = async (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Session request must be an object.");
    }
    // Versioned schema is authoritative at the service boundary. The switch
    // below still performs operation-specific checks and resource ownership.
    const request = parseServiceCommand(input) as unknown as Record<string, unknown>;
    switch (request.operation) {
      case "connect": return this.connectCommand(request);
      case "disconnect": return this.disconnectCommand();
      case "downloadStart": {
        if (typeof request.folderId !== "string" || !request.folderId || request.folderId.length > 4096 ||
          typeof request.path !== "string" || !request.path || request.path.length > 4096 ||
          request.path.startsWith("/") || request.path.split("/").some(part => part === ".." || part === ".")) {
          throw new Error("Invalid remote download path.");
        }
        const session = this.lifecycle.getSession();
        if (!session || session.isClosed()) throw new Error("No service-owned peer session is connected.");
        return { transferId: this.downloads.start(request.folderId, request.path) };
      }
      case "downloadPull": {
        if (typeof request.transferId !== "string") throw new Error("Missing service download handle.");
        return this.downloads.pull(request.transferId);
      }
      case "downloadCancel": {
        if (typeof request.transferId !== "string") throw new Error("Missing service download handle.");
        this.downloads.cancel(request.transferId);
        return { cancelled: true };
      }
      case "uploadStart": {
        if (typeof request.folderId !== "string" || !request.folderId || request.folderId.length > 4096 ||
          typeof request.path !== "string" || !request.path || request.path.length > 4096 ||
          request.path.startsWith("/") || request.path.split("/").some(part => part === ".." || part === ".") ||
          typeof request.size !== "number" || !Number.isSafeInteger(request.size) || request.size < 0) {
          throw new Error("Invalid remote upload parameters.");
        }
        const session = this.lifecycle.getSession();
        if (!session || session.isClosed()) throw new Error("No service-owned peer session is connected.");
        const opts = (request.options ?? {}) as Record<string, unknown>;
        if (typeof opts !== "object" || Array.isArray(opts) ||
          (opts.waitForRemote !== undefined && typeof opts.waitForRemote !== "boolean") ||
          (opts.expectedHash !== undefined && (typeof opts.expectedHash !== "string" || opts.expectedHash.length > 256)) ||
          (opts.modifiedMs !== undefined && (!Number.isSafeInteger(opts.modifiedMs) || Number(opts.modifiedMs) < 0))) {
          throw new Error("Invalid remote upload options.");
        }
        return { uploadId: this.uploads.start(request.folderId, request.path, request.size, {
          ...(typeof opts.waitForRemote === "boolean" ? { waitForRemote: opts.waitForRemote } : {}),
          ...(typeof opts.expectedHash === "string" ? { expectedHash: opts.expectedHash } : {}),
          ...(typeof opts.modifiedMs === "number" ? { modifiedMs: opts.modifiedMs } : {}),
        }) };
      }
      case "uploadPoll": {
        if (typeof request.uploadId !== "string") throw new Error("Missing service upload handle.");
        return this.uploads.poll(request.uploadId);
      }
      case "uploadProvide": {
        if (typeof request.uploadId !== "string" || typeof request.requestId !== "string" ||
          typeof request.bytes !== "string" || request.bytes.length > 90 * 1024) {
          throw new Error("Invalid service upload chunk.");
        }
        let bytes: Uint8Array;
        try { bytes = decodeBase64(request.bytes, 64 * 1024); }
        catch { throw new Error("Invalid service upload chunk."); }
        this.uploads.provide(request.uploadId, request.requestId, bytes);
        return { accepted: true };
      }
      case "uploadCancel": {
        if (typeof request.uploadId !== "string") throw new Error("Missing service upload handle.");
        this.uploads.cancel(request.uploadId);
        return { cancelled: true };
      }
      case "deleteFile": {
        const session = this.lifecycle.getSession();
        if (!session || session.isClosed()) throw new Error("No service-owned peer session is connected.");
        if (typeof request.folderId !== "string" || !request.folderId || request.folderId.length > 4096 ||
          typeof request.path !== "string" || !request.path || request.path.length > 4096 ||
          request.path.startsWith("/") || request.path.split("/").some(part => part === ".." || part === ".")) {
          throw new Error("Invalid remote deletion path.");
        }
        await session.remoteFs.deleteFile(request.folderId, request.path,
          { waitForRemote: request.waitForRemote === true });
        return { deleted: true };
      }
      case "syncFavorites": return this.syncFavoritesCommand();
      case "releaseLocalCopy": return this.releaseLocalCopyCommand(request);
      case "status": return { ...this.lifecycle.getState(), active: !!this.lifecycle.getSession(), hasOptions: !!this.activeOptions };
      default: {
        const session = this.lifecycle.getSession();
        if (!session || session.isClosed()) {
          throw new Error("No service-owned peer session is connected.");
        }
        return executeServiceRemoteCommand(session, request);
      }
    }
  };

  private close = async () => {
    this.peerStatusUnsubscribe?.();
    this.peerStatusUnsubscribe = null;
    this.downloads.cancelAll();
    this.uploads.cancelAll();
    this.activeOptions = null;
    this.sharedFolderIds = [];
    await this.lifecycle.disconnect();
    await this.stopIncomingService();
  };
}

async function startSession(android: AndroidRuntime, documents: Documents) {
  return (await AndroidSessionRuntime.create(android, documents)).start();
}

Object.defineProperty(globalThis, "syncpeerDocumentsCore", {
  value: { deriveUntrustedFolderCrypto, createEncryptedDownloadSink, loadEncryptedDiskMetadata, readEncryptedDiskRange,
    installAndroidTimers, startDocuments, startSession },
  writable: false,
  configurable: false,
});

const installWebViewRuntimeHost = () => {
  if (typeof window === "undefined") return;
  window.addEventListener("message", event => {
    if (event.data !== "syncpeer-runtime" || event.ports.length !== 3) return;
    const [commands, storage, network] = event.ports;
    const ports = new Map([["storage", storage], ["network", network]]);
    const android: AndroidRuntime = {
      getNamedPort: async name => {
        const port = ports.get(name);
        if (!port) throw new Error(`Unknown Android runtime port: ${name}`);
        return port;
      },
    };
    commands.onmessage = async message => {
      const request = JSON.parse(message.data) as { id: number; code: string; input: string };
      try {
        const run = Object.getPrototypeOf(async function () {}).constructor(
          "android", "input", request.code,
        ) as (android: AndroidRuntime, input: unknown) => Promise<unknown>;
        const result = await run(android, JSON.parse(request.input));
        commands.postMessage(JSON.stringify({ id: request.id, result: String(result) }));
      } catch (error) {
        commands.postMessage(JSON.stringify({ id: request.id,
          error: error instanceof Error ? error.message : "Document runtime command failed." }));
      }
    };
    commands.start();
    storage.start();
    network.start();
    commands.postMessage(JSON.stringify({ ready: true }));
  }, { once: true });
};

installWebViewRuntimeHost();
