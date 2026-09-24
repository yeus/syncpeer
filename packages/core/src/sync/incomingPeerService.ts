import { acceptSyncpeerSession, deviceIdFromCertificate, type SyncpeerAcceptedTlsSocket, type SyncpeerConnectOptions,
  type SyncpeerHostAdapter, type SyncpeerSessionHandle } from "../client.js";
import { createPeerSessionManager, type PeerSessionCandidate } from "./peerSessionManager.js";

const canonicalId = (value: string) => value.replace(/[^A-Z2-7]/gi, "").toUpperCase();

export interface IncomingPeerServiceOptions {
  mode?: "direct" | "relay" | "both";
  relayAddress?: string;
  host: string;
  port?: number;
  certPem: string;
  keyPem: string;
  localDeviceId: string;
  approvedDeviceIds: readonly string[];
  handshakeTimeoutMs?: number;
  connectionOptions: (remoteDeviceId: string, endpoint: { host: string; port: number }) =>
    SyncpeerConnectOptions | Promise<SyncpeerConnectOptions>;
  onSession: (session: SyncpeerSessionHandle, remoteDeviceId: string) => void;
  onPairingSocket?: (socket: SyncpeerAcceptedTlsSocket, remoteDeviceId: string) => Promise<void>;
  onError?: (error: unknown) => void;
}

/** Owns the common accept, identity approval, BEP handshake, and duplicate-session path. */
export async function startIncomingPeerService(adapter: SyncpeerHostAdapter,
  options: IncomingPeerServiceOptions): Promise<{ port: number;
    activeSessions: () => PeerSessionCandidate<SyncpeerSessionHandle>[];
    admitOutgoing: (remoteDeviceId: string, connectionId: string,
      session: SyncpeerSessionHandle) => Promise<boolean>;
    updateSessionHandlers: (handlers: Pick<IncomingPeerServiceOptions, "connectionOptions" | "onSession">) => void;
    close: () => Promise<void> }> {
  const mode = options.mode ?? "direct";
  if (mode !== "relay" && !adapter.listenTls) throw new Error("This platform does not provide a TLS listener.");
  if (mode !== "direct" && (!adapter.listenRelay || !options.relayAddress)) {
    throw new Error("This platform cannot register with the selected Syncthing relay.");
  }
  const approved = new Map(options.approvedDeviceIds.map(id => [canonicalId(id), id]));
  if ((!approved.size && !options.onPairingSocket) || approved.has("") ||
    approved.size !== options.approvedDeviceIds.length) {
    throw new Error("Approved peer identities must be present and unique.");
  }
  const manager = createPeerSessionManager<SyncpeerSessionHandle>(options.localDeviceId);
  const pending = new Set<Promise<void>>();
  const pendingSockets = new Set<SyncpeerAcceptedTlsSocket["socket"]>();
  let sessionHandlers: Pick<IncomingPeerServiceOptions, "connectionOptions" | "onSession"> = options;
  const alpnProtocols = options.onPairingSocket ? ["bep/1.0", "syncpeer-pairing/1"] : ["bep/1.0"];
  type Listener = Awaited<ReturnType<NonNullable<SyncpeerHostAdapter["listenTls"]>>>;
  const listeners: Array<{ kind: "direct" | "relay"; listener: Listener }> = [];
  const relayOptions = { relayAddress: options.relayAddress!, certPem: options.certPem, keyPem: options.keyPem,
    alpnProtocols, handshakeTimeoutMs: options.handshakeTimeoutMs };
  try {
    if (mode !== "relay") listeners.push({ kind: "direct", listener: await adapter.listenTls!({
      host: options.host, port: options.port ?? 22000,
      certPem: options.certPem, keyPem: options.keyPem, alpnProtocols,
      handshakeTimeoutMs: options.handshakeTimeoutMs }) });
    if (mode !== "direct") listeners.push({ kind: "relay", listener: await adapter.listenRelay!(relayOptions) });
  } catch (error) { await Promise.allSettled(listeners.map(value => value.listener.close())); throw error; }
  let stopping = false;
  const retryStop = new AbortController();
  const waitToRetry = async (delayMs: number) => {
    if (retryStop.signal.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); retryStop.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, delayMs);
      retryStop.signal.addEventListener("abort", done, { once: true });
    });
  };

  const handle = (accepted: Awaited<ReturnType<Listener["accept"]>>) => {
    pendingSockets.add(accepted.socket);
    const task = (async () => {
      if (stopping) { await accepted.socket.close(); return; }
      const remoteDeviceId = canonicalId(await deviceIdFromCertificate(adapter,
        await accepted.socket.peerCertificateDer()));
      if (accepted.alpn === "syncpeer-pairing/1" && options.onPairingSocket) {
        try { await options.onPairingSocket(accepted, remoteDeviceId); }
        finally { await accepted.socket.close().catch(() => undefined); }
        return;
      }
      if (accepted.alpn !== "bep/1.0") {
        throw new Error(`Incoming peer negotiated unsupported ALPN '${accepted.alpn || "none"}'.`);
      }
      const approvedDeviceId = approved.get(remoteDeviceId);
      if (!approvedDeviceId) throw new Error(`Incoming peer device ID mismatch: ${remoteDeviceId} is not approved.`);
      const endpoint = { host: accepted.remoteAddress || options.host, port: accepted.remotePort };
      const handlers = sessionHandlers;
      const sessionOptions = await handlers.connectionOptions(approvedDeviceId, endpoint);
      const session = await acceptSyncpeerSession(adapter, accepted.socket,
        { ...sessionOptions, ...endpoint, expectedDeviceId: approvedDeviceId });
      const connectionId = `${endpoint.host}:${endpoint.port}`;
      if (await manager.admit({ remoteDeviceId, direction: "incoming", connectionId, session })) {
        handlers.onSession(session, remoteDeviceId);
      }
    })().catch(error => {
      void accepted.socket.close().catch(() => undefined);
      options.onError?.(error);
    });
    pending.add(task);
    void task.finally(() => { pending.delete(task); pendingSockets.delete(accepted.socket); });
  };
  const acceptLoop = async (entry: typeof listeners[number]) => {
    let retryCount = 0;
    while (!stopping) {
      try { handle(await entry.listener.accept()); retryCount = 0; }
      catch (error) {
        if (!stopping) options.onError?.(error);
        if (stopping || entry.kind !== "relay") return;
        await entry.listener.close().catch(() => undefined);
        while (!stopping) {
          await waitToRetry(Math.min(1000 * 2 ** retryCount, 16000));
          if (stopping) return;
          try {
            const replacement = await adapter.listenRelay!(relayOptions);
            if (stopping) { await replacement.close(); return; }
            entry.listener = replacement;
            retryCount = 0;
            break;
          } catch (reconnectError) {
            retryCount++;
            options.onError?.(reconnectError);
          }
        }
      }
    }
  };
  const acceptLoops = listeners.map(entry => acceptLoop(entry));

  return { port: mode === "relay" ? 0 : listeners[0].listener.port, activeSessions: manager.active,
    updateSessionHandlers: handlers => { sessionHandlers = handlers; },
    admitOutgoing: (remoteDeviceId, connectionId, session) =>
      manager.admit({ remoteDeviceId, direction: "outgoing", connectionId, session }),
    close: async () => {
      stopping = true;
      retryStop.abort();
      await Promise.allSettled([...pendingSockets].map(socket => socket.close()));
      await Promise.allSettled(listeners.map(value => value.listener.close()));
      await Promise.allSettled(acceptLoops);
      await Promise.allSettled(pending);
      await manager.close();
    } };
}
