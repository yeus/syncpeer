import { acceptSyncpeerSession, deviceIdFromCertificate, type SyncpeerAcceptedTlsSocket, type SyncpeerConnectOptions,
  type SyncpeerHostAdapter, type SyncpeerSessionHandle } from "../client.js";
import { createPeerSessionManager, type PeerSessionCandidate } from "./peerSessionManager.js";

const canonicalId = (value: string) => value.replace(/[^A-Z2-7]/gi, "").toUpperCase();

export interface IncomingPeerServiceOptions {
  host: string;
  port?: number;
  certPem: string;
  keyPem: string;
  localDeviceId: string;
  approvedDeviceIds: readonly string[];
  handshakeTimeoutMs?: number;
  connectionOptions: (remoteDeviceId: string, endpoint: { host: string; port: number }) => SyncpeerConnectOptions;
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
  if (!adapter.listenTls) throw new Error("This platform does not provide a TLS listener.");
  const approved = new Map(options.approvedDeviceIds.map(id => [canonicalId(id), id]));
  if ((!approved.size && !options.onPairingSocket) || approved.has("") ||
    approved.size !== options.approvedDeviceIds.length) {
    throw new Error("Approved peer identities must be present and unique.");
  }
  const manager = createPeerSessionManager<SyncpeerSessionHandle>(options.localDeviceId);
  const pending = new Set<Promise<void>>();
  const pendingSockets = new Set<SyncpeerAcceptedTlsSocket["socket"]>();
  let sessionHandlers: Pick<IncomingPeerServiceOptions, "connectionOptions" | "onSession"> = options;
  const listener = await adapter.listenTls({ host: options.host, port: options.port ?? 22000,
    certPem: options.certPem, keyPem: options.keyPem,
    alpnProtocols: options.onPairingSocket ? ["bep/1.0", "syncpeer-pairing/1"] : ["bep/1.0"],
    handshakeTimeoutMs: options.handshakeTimeoutMs });
  let stopping = false;

  const handle = (accepted: Awaited<ReturnType<typeof listener.accept>>) => {
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
      const sessionOptions = handlers.connectionOptions(approvedDeviceId, endpoint);
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
  const acceptLoop = (async () => {
    while (!stopping) {
      try { handle(await listener.accept()); }
      catch (error) {
        if (!stopping) options.onError?.(error);
        return;
      }
    }
  })();

  return { port: listener.port, activeSessions: manager.active,
    updateSessionHandlers: handlers => { sessionHandlers = handlers; },
    admitOutgoing: (remoteDeviceId, connectionId, session) =>
      manager.admit({ remoteDeviceId, direction: "outgoing", connectionId, session }),
    close: async () => {
      stopping = true;
      await Promise.allSettled([...pendingSockets].map(socket => socket.close()));
      await listener.close();
      await acceptLoop;
      await Promise.allSettled(pending);
      await manager.close();
    } };
}
