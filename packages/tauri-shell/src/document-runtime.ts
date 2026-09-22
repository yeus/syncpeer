// JavaScriptEngine has no browser text codecs; install the standard UTF-8 shim
// before loading core. Encryption and authenticated file layout stay in core.
import "./document-runtime-polyfills.js";
import { installAndroidTimers } from "./document-runtime-polyfills.js";
import { createPortRequest } from "./document-runtime-port.js";
import { createDocumentFilesystem } from "../../core/src/sync/documentFilesystem.js";
import { dispatchDocumentCommand } from "../../core/src/sync/documentCommands.js";
import { createNativeFilesystem } from "../../core/src/sync/nativeFilesystem.js";
import { deriveUntrustedFolderCrypto } from "../../core/src/core/model/untrusted.js";
import { createEncryptedDownloadSink, loadEncryptedDiskMetadata, readEncryptedDiskRange } from "../../core/src/sync/encryptedFilesystem.js";
import { certificateDerFromPem, createSyncpeerCoreClient, deviceIdFromCertificate,
  type SyncpeerConnectOptions, type SyncpeerHostAdapter, type SyncpeerTlsSocket } from "../../core/src/client.js";
import type { ConnectOptions } from "../../core/src/ui/browserClient.js";
import { createConnectionLifecycle, type ConnectionLifecycle } from "../../core/src/ui/connectionLifecycle.js";
import { startIncomingPeerService } from "../../core/src/sync/incomingPeerService.js";
import { preferredPeerDirection } from "../../core/src/sync/peerSessionManager.js";
import { resolveFolderPasswordsForDevice } from "../../core/src/ui/sessionPasswords.js";
import { syncServiceFileFavorites } from "../../core/src/sync/serviceFavoriteSync.js";

type AndroidRuntime = { getNamedPort: (name: string) => Promise<MessagePort> };

const createAndroidSessionAdapter = async (android: AndroidRuntime): Promise<SyncpeerHostAdapter> => {
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
  return {
    log: (event, details) => {
      if (!["core.upload.request.failed", "core.replica.receive.failed"].includes(event)) return;
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
      let closed = false;
      return {
        port: Number(opened.port),
        accept: async () => {
          while (!closed) {
            try {
              const accepted = await request({ operation: "tlsAccept", listenerId: opened.listenerId,
                timeoutMs: 60_000 }) as { sessionId: number; peerCertificateDer: number[];
                remoteAddress: string; remotePort: number; alpn: string };
              return { socket: socket(Number(accepted.sessionId), new Uint8Array(accepted.peerCertificateDer)),
                remoteAddress: accepted.remoteAddress, remotePort: Number(accepted.remotePort), alpn: accepted.alpn };
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
    discoveryFetch: async (input, init) => {
      const response = await request({ operation: "discoveryFetch", url: String(input), method: init?.method ?? "GET", headers: init?.headers ?? {}, pinServerDeviceId: init?.pinServerDeviceId ?? null, allowInsecureTls: !!init?.allowInsecureTls }) as { status: number; body: string };
      return { ok: response.status >= 200 && response.status < 300, status: response.status,
        text: async () => response.body, json: async () => JSON.parse(response.body) };
    },
    discoverLocalCandidates: async ({ expectedDeviceId, timeoutMs }) => {
      const response = await request({ operation: "discoverLocal", expectedDeviceId: expectedDeviceId || null, timeoutMs: timeoutMs ?? null }) as { candidates: Array<{ address: string; protocol: string; host?: string; port?: number; deviceId?: string }> };
      return response.candidates.map(candidate => ({ ...candidate,
        protocol: candidate.protocol === "tcp" || candidate.protocol === "quic" || candidate.protocol === "relay" ? candidate.protocol : "unknown" as const,
      }));
    },
  };
};

async function startDocuments(android: AndroidRuntime) {
  await installAndroidTimers(android);
  const port = await android.getNamedPort("storage");
  const request = createPortRequest(port);
  const native = (input: object) => request({ method: "storage", input });
  const openStorage = async (id: string) => createNativeFilesystem(native, String(await request({ method: "root", idValue: id })));
  const secret = (operation: string, value?: string) => request({ method: "secret", operation, secret: value });
  const documents = createDocumentFilesystem({ profileId: "documents", profile: await openStorage("profile"), openStorage,
    deviceCounterId: String(await request({ method: "counter" })),
    randomBytes: async size => new Uint8Array(await request({ method: "random", size }) as number[]),
    availableBytes: async () => Number(await request({ method: "availableBytes" })),
    rememberedSecret: { load: async () => await secret("load") as string | null, save: async value => { await secret("save", value); },
      remove: async () => { await secret("remove"); }, isDeviceUnlocked: async () => await secret("isDeviceUnlocked") === true } });
  await documents.initialize();
  return {
    command: (input: unknown) => dispatchDocumentCommand(documents, input),
    close: documents.close,
    connectionPasswords: documents.connectionPasswords,
    sessionSharedFolders: documents.sessionSharedFolders,
    rememberFolder: documents.rememberFolder,
    syncFavorites: (remoteFs: Parameters<typeof syncServiceFileFavorites>[1], excludeFolderIds: readonly string[]) =>
      syncServiceFileFavorites(documents, remoteFs, { excludeFolderIds }),
  };
}

async function startSession(android: AndroidRuntime, documents: Awaited<ReturnType<typeof startDocuments>>) {
  const adapter = await createAndroidSessionAdapter(android);
  const core = createSyncpeerCoreClient(adapter);
  let activeOptions: ConnectOptions | null = null;
  let sharedFolderIds: string[] = [];
  let incomingService: Awaited<ReturnType<typeof startIncomingPeerService>> | null = null;
  let incomingServiceKey = "";
  const stopIncomingService = async () => {
    const service = incomingService;
    incomingService = null;
    incomingServiceKey = "";
    await service?.close();
  };
  const ensureIncomingService = async (options: ConnectOptions, coreOptions: SyncpeerConnectOptions) => {
    if (!coreOptions.expectedDeviceId) return null;
    const localDeviceId = await deviceIdFromCertificate(adapter, certificateDerFromPem(coreOptions.certPem));
    const key = JSON.stringify([localDeviceId, coreOptions.expectedDeviceId,
      coreOptions.certPem, coreOptions.keyPem]);
    if (incomingService && incomingServiceKey === key) return incomingService;
    await stopIncomingService();
    const remoteDeviceId = coreOptions.expectedDeviceId;
    incomingService = await startIncomingPeerService(adapter, {
      host: "0.0.0.0", port: 22000, certPem: coreOptions.certPem, keyPem: coreOptions.keyPem,
      localDeviceId, approvedDeviceIds: [remoteDeviceId],
      connectionOptions: (_remote, endpoint) => ({ ...coreOptions, ...endpoint }),
      onSession: session => {
        if (preferredPeerDirection(localDeviceId, remoteDeviceId) !== "incoming") return;
        void lifecycle.adopt(options, session);
      },
      onError: error => adapter.log?.("core.incoming.failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    });
    incomingServiceKey = key;
    return incomingService;
  };
  const lifecycle: ConnectionLifecycle<ConnectOptions> = createConnectionLifecycle<ConnectOptions>({
    open: async (options, signal) => {
      let passwords: Record<string, string> = {};
      try {
        passwords = await documents.connectionPasswords();
      } catch {
        // A manually locked document vault must not prevent the authenticated
        // metadata session from reconnecting.  The foreground client can
        // unlock it later before requesting a favorite download.
      }
      if (!options.cert || !options.key) throw new Error("Background session is missing the resolved identity.");
      const folderPasswords = {
        ...resolveFolderPasswordsForDevice(passwords, options.remoteId ?? ""),
        ...options.folderPasswords,
      };
      const sharedFolders = await documents.sessionSharedFolders(folderPasswords);
      const coreOptions: SyncpeerConnectOptions = {
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
      let listenerFailure: unknown;
      let service: Awaited<ReturnType<typeof startIncomingPeerService>> | null = null;
      try { service = await ensureIncomingService(options, coreOptions); }
      catch (error) { listenerFailure = error; }
      let session;
      try { session = await core.openSession(coreOptions, signal); }
      catch (error) {
        if (listenerFailure) throw new AggregateError([error, listenerFailure],
          "Could not connect to the peer or start the incoming LAN listener on TCP port 22000.",
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
      sharedFolderIds = sharedFolders.map(folder => folder.id);
      return session;
    },
    keyFor: options => JSON.stringify({ host: options.host, port: options.port, remoteId: options.remoteId ?? "", deviceName: options.deviceName }),
  });
  return {
    command: async (input: unknown) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Session request must be an object.");
      }
      const request = input as Record<string, unknown>;
      if (request.operation === "connect") {
        if (!request.options || typeof request.options !== "object" || Array.isArray(request.options)) {
          throw new Error("Session connect options are missing.");
        }
        const options = request.options as ConnectOptions;
        activeOptions = options;
        const session = await lifecycle.connect(options);
        // Remember newly advertised roots. Folders already attached to the
        // DocumentsProvider are supplied above as explicit full replicas;
        // unattached folders remain metadata-only until selected.
        for (const folder of await session.remoteFs.listFolders()) {
          await documents.rememberFolder({ id: folder.id, label: folder.label || folder.id });
        }
        return { phase: lifecycle.getState().phase };
      }
      if (request.operation === "disconnect") {
        activeOptions = null;
        sharedFolderIds = [];
        await lifecycle.disconnect();
        await stopIncomingService();
        return { phase: "idle" };
      }
      if (request.operation === "syncFavorites") {
        const session = lifecycle.getSession();
        if (!session) return { phase: "waiting" };
        return documents.syncFavorites(session.remoteFs, sharedFolderIds);
      }
      if (request.operation === "status") return { ...lifecycle.getState(), active: !!lifecycle.getSession(), hasOptions: !!activeOptions };
      throw new Error(`Unknown session operation: ${String(request.operation)}`);
    },
    close: async () => {
      activeOptions = null;
      sharedFolderIds = [];
      await lifecycle.disconnect();
      await stopIncomingService();
    },
  };
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
