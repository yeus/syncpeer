// JavaScriptEngine has no browser text codecs; install the standard UTF-8 shim
// before loading core. Encryption and authenticated file layout stay in core.
import "./document-runtime-polyfills.js";
import { createDocumentFilesystem } from "../../core/src/sync/documentFilesystem.js";
import { dispatchDocumentCommand } from "../../core/src/sync/documentCommands.js";
import { createNativeFilesystem } from "../../core/src/sync/nativeFilesystem.js";
import { deriveUntrustedFolderCrypto } from "../../core/src/core/model/untrusted.js";
import { createEncryptedDownloadSink, loadEncryptedDiskMetadata, readEncryptedDiskRange } from "../../core/src/sync/encryptedFilesystem.js";
import { createSyncpeerCoreClient, type SyncpeerConnectOptions, type SyncpeerHostAdapter, type SyncpeerTlsSocket } from "../../core/src/client.js";
import type { ConnectOptions } from "../../core/src/ui/browserClient.js";
import { createConnectionLifecycle } from "../../core/src/ui/connectionLifecycle.js";

type AndroidRuntime = { getNamedPort: (name: string) => Promise<MessagePort> };

const createPortRequest = async (port: MessagePort) => {
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  port.onmessage = event => {
    const reply = JSON.parse(event.data);
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(new Error(reply.error)); else task.resolve(reply.result);
  };
  return (input: object): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    port.postMessage(JSON.stringify({ id, ...input }));
  });
};

const createAndroidSessionAdapter = async (android: AndroidRuntime): Promise<SyncpeerHostAdapter> => {
  const request = await createPortRequest(await android.getNamedPort("network"));
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
    connectTls: async ({ host, port, certPem, keyPem, caPem, timeoutMs, signal }) => {
      const value = await request({ operation: "tlsOpen", host, port, certPem, keyPem, caPem: caPem ?? null, timeoutMs: timeoutMs ?? null }) as { sessionId: number; peerCertificateDer: number[] };
      const result = socket(Number(value.sessionId), new Uint8Array(value.peerCertificateDer));
      if (signal?.aborted) { await result.close(); throw new Error("Connection attempt was cancelled."); }
      return result;
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
  const port = await android.getNamedPort("storage");
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  port.onmessage = event => {
    const reply = JSON.parse(event.data);
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(new Error(reply.error)); else task.resolve(reply.result);
  };
  const request = (input: object): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    port.postMessage(JSON.stringify({ id, ...input }));
  });
  const native = (input: object) => request({ method: "storage", input });
  const openStorage = async (id: string) => createNativeFilesystem(native, String(await request({ method: "root", idValue: id })));
  const secret = (operation: string, value?: string) => request({ method: "secret", operation, secret: value });
  const documents = createDocumentFilesystem({ profileId: "documents", profile: await openStorage("profile"), openStorage,
    deviceCounterId: String(await request({ method: "counter" })),
    randomBytes: async size => new Uint8Array(await request({ method: "random", size }) as number[]),
    availableBytes: async () => Number(await request({ method: "availableBytes" })),
    rememberedSecret: { load: async () => await secret("load") as string | null, save: async value => { await secret("save", value); },
      remove: async () => { await secret("remove"); }, isDeviceUnlocked: async () => await secret("isDeviceUnlocked") === true } });
  await documents.initialize(true);
  return {
    command: (input: unknown) => dispatchDocumentCommand(documents, input),
    close: documents.close,
    connectionPasswords: documents.connectionPasswords,
    rememberFolder: documents.rememberFolder,
  };
}

async function startSession(android: AndroidRuntime, documents: Awaited<ReturnType<typeof startDocuments>>) {
  const adapter = await createAndroidSessionAdapter(android);
  const core = createSyncpeerCoreClient(adapter);
  let activeOptions: ConnectOptions | null = null;
  const lifecycle = createConnectionLifecycle<ConnectOptions>({
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
        folderPasswords: { ...passwords, ...options.folderPasswords },
      };
      return core.openSession(coreOptions, signal);
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
        // Keep the directory-service roots visible without subscribing the
        // cache to a whole remote folder.  Actual bytes still arrive only via
        // an explicit favorite download or a future explicit folder-sync mode.
        for (const folder of await session.remoteFs.listFolders()) {
          await documents.rememberFolder({ id: folder.id, label: folder.label || folder.id });
        }
        return { phase: lifecycle.getState().phase };
      }
      if (request.operation === "disconnect") { activeOptions = null; await lifecycle.disconnect(); return { phase: "idle" }; }
      if (request.operation === "status") return { ...lifecycle.getState(), active: !!lifecycle.getSession(), hasOptions: !!activeOptions };
      throw new Error(`Unknown session operation: ${String(request.operation)}`);
    },
    close: async () => { activeOptions = null; await lifecycle.disconnect(); },
  };
}

Object.defineProperty(globalThis, "syncpeerDocumentsCore", {
  value: { deriveUntrustedFolderCrypto, createEncryptedDownloadSink, loadEncryptedDiskMetadata, readEncryptedDiskRange, startDocuments, startSession },
  writable: false,
  configurable: false,
});
