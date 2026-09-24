import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { readFile } from "node:fs/promises";
import https from "node:https";
import tls from "node:tls";
import protobuf from "protobufjs";
import {
  createSyncpeerCoreClient,
  type SyncpeerConnectOptions,
  type SyncpeerSessionHandle,
  withMetadataSession,
  type DiscoveredCandidate,
  type SyncpeerRelayConnectOptions,
  type SyncpeerRelayConnectResult,
  type SyncpeerRelayListenOptions,
  resolveGlobalDiscovery,
  type SyncpeerDiscoveryFetchInit,
  type SyncpeerDiscoveryResponse,
  type SyncpeerGlobalDiscoveryOptions,
  type SyncpeerHostAdapter,
  type SyncpeerTlsConnectOptions,
  type SyncpeerTlsListenOptions,
  type SyncpeerTlsListener,
  type SyncpeerTlsSocket,
} from "./client.js";
import type { ConnectOptions, ConnectionOverview, RemoteFsLike } from "./ui/browserClient.js";
import type { SessionTransport } from "./ui/sessionTypes.js";
import { createConnectionLifecycle } from "./ui/connectionLifecycle.js";
import { createRecoveringRemoteFs } from "./ui/recoveringRemoteFs.js";
import { connectNodeQuic } from "./core/transport/nodeQuic.js";
import { startIncomingPeerService } from "./sync/incomingPeerService.js";
import type { PeerSessionCandidate } from "./sync/peerSessionManager.js";
export {
  classifyRuntimeArchitecture,
  classifyRuntimePlatform,
  createAppBuildInfo,
  formatAppBuildInfo,
} from "./appInfo.js";
export type {
  AppBuildInfo,
  AppBuildMode,
  AppRuntimeArchitecture,
  AppRuntimeEnvironment,
  AppRuntimePlatform,
  AppRuntimeSurface,
} from "./appInfo.js";
export { downloadRemoteFile } from "./transfer/download.js";
export { createNodeFileDownloadSink } from "./transfer/nodeStorage.js";
export { createNodeFolderSyncStorage } from "./sync/nodeFolderStorage.js";
export { createNodeFolderReplica } from "./sync/nodeReplica.js";
export { versionCounterId } from "./core/protocol/versionVector.js";
export type { NodeFolderSyncStorage, NodeFolderSyncStorageOptions } from "./sync/nodeFolderStorage.js";
export type { FileDownloadSink } from "./transfer/stream.js";
export { DownloadInterruptedError } from "./transfer/stream.js";
export {
  getDefaultDiscoveryServer,
  normalizeDiscoveryServer,
} from "./ui/discoveryServer.js";

type ByteBuffer = Buffer<ArrayBufferLike>;
const LOCAL_DISCOVERY_MAGIC = 0x2ea7d90b;
const LOCAL_DISCOVERY_PORT = 21027;
const RELAY_MAGIC = 0x9e79bc40;
const RELAY_MESSAGE_TYPE_PING = 0;
const RELAY_MESSAGE_TYPE_PONG = 1;
const RELAY_MESSAGE_TYPE_JOIN_RELAY_REQUEST = 2;
const RELAY_MESSAGE_TYPE_JOIN_SESSION_REQUEST = 3;
const RELAY_MESSAGE_TYPE_RESPONSE = 4;
const RELAY_MESSAGE_TYPE_CONNECT_REQUEST = 5;
const RELAY_MESSAGE_TYPE_SESSION_INVITATION = 6;

const LocalDiscoveryAnnounce = new protobuf.Type("Announce")
  .add(new protobuf.Field("id", 1, "bytes"))
  .add(new protobuf.Field("addresses", 2, "string", "repeated"))
  .add(new protobuf.Field("instance_id", 3, "int64"));

export function createNodeLocalDiscoveryAnnouncement(certDer: Uint8Array, port: number,
  instanceId = Date.now()): Uint8Array {
  if (!certDer.length || !Number.isInteger(port) || port < 1 || port > 65535 ||
    !Number.isSafeInteger(instanceId)) throw new Error("Invalid local discovery announcement.");
  const body = LocalDiscoveryAnnounce.encode({
    id: crypto.createHash("sha256").update(certDer).digest(),
    addresses: [`tcp://0.0.0.0:${port}`],
    instance_id: instanceId,
  }).finish();
  const packet = new Uint8Array(4 + body.length);
  new DataView(packet.buffer).setUint32(0, LOCAL_DISCOVERY_MAGIC, false);
  packet.set(body, 4);
  return packet;
}

class NodeTlsSocket implements SyncpeerTlsSocket {
  private queue: Uint8Array[] = [];
  private waiters: Array<{ resolve: (chunk: Uint8Array) => void; reject: (error: Error) => void }> = [];
  private closed = false;
  private closeError: Error | null = null;
  private socket: tls.TLSSocket;

  constructor(socket: tls.TLSSocket) {
    this.socket = socket;
    socket.on("data", (chunk: ByteBuffer) => {
      const data = new Uint8Array(chunk);
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve(data);
      } else {
        this.queue.push(data);
      }
    });
    socket.on("error", (error) => {
      this.closeWithError(error);
    });
    socket.on("close", () => {
      this.closeWithError(new Error("Connection closed"));
    });
    socket.on("end", () => {
      this.closeWithError(new Error("Connection ended"));
    });
  }

  private closeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  read(): Promise<Uint8Array> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("Connection closed"));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  write(data: Uint8Array): Promise<void> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("Connection closed"));
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.from(data), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise<void>((resolve) => {
      this.socket.end(() => resolve());
      this.socket.destroy();
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        waiter?.reject(new Error("Connection closed"));
      }
    });
  }

  peerCertificateDer(): Promise<Uint8Array> {
    const peer = this.socket.getPeerCertificate(true);
    if (!peer?.raw) return Promise.reject(new Error("Peer certificate missing"));
    return Promise.resolve(new Uint8Array(peer.raw));
  }
}

async function connectNodeTls(options: SyncpeerTlsConnectOptions): Promise<SyncpeerTlsSocket> {
  const socket = tls.connect({
    host: options.host,
    port: options.port,
    ALPNProtocols: [...options.alpnProtocols ?? ["bep/1.0"]],
    cert: options.certPem,
    key: options.keyPem,
    ca: options.caPem,
    rejectUnauthorized: false,
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      socket.destroy();
      cleanup();
      const error = new Error("Connection attempt was cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("secureConnect", () => { cleanup(); resolve(); });
    socket.once("error", (error) => { cleanup(); reject(error); });
  });
  return new NodeTlsSocket(socket);
}

async function listenNodeTls(options: SyncpeerTlsListenOptions): Promise<SyncpeerTlsListener> {
  type Accepted = Awaited<ReturnType<SyncpeerTlsListener["accept"]>>;
  const accepted: Accepted[] = [];
  const waiters: Array<{ resolve: (value: Accepted) => void; reject: (error: Error) => void }> = [];
  const sockets = new Set<net.Socket>();
  let closedError: Error | undefined;
  const fail = (error: Error) => {
    closedError ??= error;
    while (waiters.length) waiters.shift()?.reject(error);
  };
  const server = tls.createServer({ cert: options.certPem, key: options.keyPem,
    requestCert: true, rejectUnauthorized: false, ALPNProtocols: [...options.alpnProtocols],
    handshakeTimeout: options.handshakeTimeoutMs ?? 10000,
  }, socket => {
    const value = { socket: new NodeTlsSocket(socket), remoteAddress: socket.remoteAddress ?? "",
      remotePort: socket.remotePort ?? 0, alpn: socket.alpnProtocol || "" };
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else accepted.push(value);
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(new Error(
      `Syncpeer could not listen on ${options.host}:${options.port}: ${error.message}`, { cause: error }));
    server.once("error", onError);
    server.listen(options.port, options.host, () => {
      server.off("error", onError);
      server.on("error", fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listener address unavailable.");
  const announcement = createNodeLocalDiscoveryAnnouncement(
    new Uint8Array(new crypto.X509Certificate(options.certPem).raw), address.port);
  const announcementSockets = [dgram.createSocket("udp4"), dgram.createSocket("udp6")];
  for (const socket of announcementSockets) socket.on("error", () => undefined);
  announcementSockets[0].bind(0, "0.0.0.0", () => announcementSockets[0].setBroadcast(true));
  announcementSockets[1].bind(0, "::");
  const announce = () => {
    announcementSockets[0].send(announcement, LOCAL_DISCOVERY_PORT, "255.255.255.255", () => undefined);
    announcementSockets[1].send(announcement, LOCAL_DISCOVERY_PORT, "ff12::8384", () => undefined);
  };
  const announcementTimer = setInterval(announce, 10000);
  announcementTimer.unref();
  announce();
  return {
    port: address.port,
    accept: () => {
      const value = accepted.shift();
      if (value) return Promise.resolve(value);
      if (closedError) return Promise.reject(closedError);
      return new Promise<Accepted>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close: async () => {
      fail(new Error("TLS listener closed."));
      clearInterval(announcementTimer);
      for (const socket of announcementSockets) socket.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

type NodeSocket = net.Socket | tls.TLSSocket;

class NodeSocketReader {
  private chunks: Buffer[] = [];
  private waiters: Array<{ resolve: (value: Buffer) => void; reject: (error: Error) => void }> = [];
  private error: Error | null = null;

  private readonly onData = (chunk: Buffer): void => {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(chunk);
    else this.chunks.push(chunk);
  };

  private readonly onError = (error: Error): void => {
    this.error = error;
    while (this.waiters.length > 0) this.waiters.shift()?.reject(error);
  };

  private readonly onClose = (): void => {
    this.onError(new Error("Relay socket closed"));
  };

  constructor(private readonly socket: NodeSocket) {
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("close", this.onClose);
  }

  async readExact(length: number): Promise<Buffer> {
    let output = Buffer.alloc(0);
    while (output.length < length) {
      const chunk = this.chunks.shift() ?? await this.readChunk();
      output = Buffer.concat([output, chunk]);
    }
    const result = output.subarray(0, length);
    const leftover = output.subarray(length);
    if (leftover.length > 0) this.chunks.unshift(leftover);
    return result;
  }

  dispose(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.onError(new Error("Relay reader closed"));
  }

  detachForTls(): void {
    this.socket.pause();
    this.dispose();
    for (const chunk of [...this.chunks].reverse()) this.socket.unshift(chunk);
    this.chunks = [];
  }

  private readChunk(): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    return new Promise<Buffer>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function base32DecodeNoPadding(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let current = 0;
  const output: number[] = [];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error(`Invalid base32 character '${char}'`);
    current = (current << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((current >>> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

function xdrOpaque(value: Uint8Array): Buffer {
  const padding = (4 - (value.length % 4)) % 4;
  const output = Buffer.alloc(4 + value.length + padding);
  output.writeUInt32BE(value.length, 0);
  Buffer.from(value).copy(output, 4);
  return output;
}

function relayMessage(type: number, payload: Uint8Array): Buffer {
  const output = Buffer.alloc(12 + payload.length);
  output.writeUInt32BE(RELAY_MAGIC, 0);
  output.writeUInt32BE(type, 4);
  output.writeUInt32BE(payload.length, 8);
  Buffer.from(payload).copy(output, 12);
  return output;
}

async function readRelayMessage(reader: NodeSocketReader): Promise<{ type: number; payload: Buffer }> {
  const header = await reader.readExact(12);
  if (header.readUInt32BE(0) !== RELAY_MAGIC) throw new Error("Unexpected relay magic");
  const type = header.readUInt32BE(4);
  const length = header.readUInt32BE(8);
  if (length > 1024 * 1024) throw new Error("Relay message exceeds the supported limit");
  return { type, payload: await reader.readExact(length) };
}

function readXdrOpaque(payload: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > payload.length) throw new Error("Relay payload ended unexpectedly");
  const length = payload.readUInt32BE(offset);
  const end = offset + 4 + length;
  const paddedEnd = end + ((4 - (length % 4)) % 4);
  if (paddedEnd > payload.length) throw new Error("Relay opaque field exceeded payload size");
  return { value: payload.subarray(offset + 4, end), next: paddedEnd };
}

function relayResponse(payload: Buffer): { code: number; message: string } {
  const message = readXdrOpaque(payload, 4);
  return { code: payload.readUInt32BE(0), message: message.value.toString("utf8") };
}

function relayAddressHost(value: Buffer, fallback: string): string {
  if (value.length === 4) return [...value].join(".");
  if (value.length === 16) {
    return value.toString("hex").match(/.{1,4}/g)?.join(":") ?? fallback;
  }
  const text = value.toString("utf8").trim();
  return text || fallback;
}

function connectNodeTcp(host: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      socket.destroy();
      cleanup();
      const error = new Error("Connection attempt was cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => { cleanup(); resolve(socket); });
    socket.once("error", (error) => { cleanup(); reject(error); });
  });
}

function connectNodeRelayTls(
  socket: net.Socket | undefined,
  options: { host: string; port: number; certPem: string; keyPem: string;
    alpn: string | readonly string[]; signal?: AbortSignal },
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      ...(socket ? { socket } : { host: options.host, port: options.port }),
      servername: options.host,
      ALPNProtocols: typeof options.alpn === "string" ? [options.alpn] : [...options.alpn],
      cert: options.certPem,
      key: options.keyPem,
      rejectUnauthorized: false,
    });
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      secureSocket.destroy();
      cleanup();
      const error = new Error("Connection attempt was cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    secureSocket.once("secureConnect", () => { cleanup(); resolve(secureSocket); });
    secureSocket.once("error", (error) => { cleanup(); reject(error); });
    secureSocket.once("close", () => { cleanup(); reject(new Error("Relay TLS socket closed before handshake.")); });
  });
}

function relayEndpoint(address: string) {
  const relayUrl = new URL(address);
  if (relayUrl.protocol !== "relay:") throw new Error("Relay address must use relay:// scheme");
  const host = relayUrl.hostname.replace(/^\[|\]$/g, "");
  const port = Number(relayUrl.port || 22067);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid relay address");
  return { host, port, expectedId: relayUrl.searchParams.get("id") };
}

async function openRelayControl(address: string, certPem: string, keyPem: string, signal?: AbortSignal) {
  const endpoint = relayEndpoint(address);
  const relaySocket = await connectNodeRelayTls(undefined, {
    host: endpoint.host,
    port: endpoint.port,
    certPem,
    keyPem,
    alpn: "bep-relay",
    signal,
  });
  const relayPeer = relaySocket.getPeerCertificate(true);
  if (endpoint.expectedId && canonicalDeviceId(computeDeviceIdFromDer(relayPeer.raw)) !==
    canonicalDeviceId(endpoint.expectedId)) {
    relaySocket.destroy();
    throw new Error("Relay certificate ID mismatch");
  }
  return { ...endpoint, socket: relaySocket, reader: new NodeSocketReader(relaySocket) };
}

function parseRelayInvitation(payload: Buffer, fallbackHost: string, fallbackPort: number) {
  let offset = 0;
  const from = readXdrOpaque(payload, offset); offset = from.next;
  const key = readXdrOpaque(payload, offset); offset = key.next;
  const address = readXdrOpaque(payload, offset); offset = address.next;
  if (from.value.length !== 32 || key.value.length < 1 || key.value.length > 32 || offset + 8 !== payload.length) {
    throw new Error("Invalid relay session invitation");
  }
  const port = payload.readUInt32BE(offset); offset += 4;
  const serverSocket = payload.readUInt32BE(offset);
  if (port > 65535 || serverSocket !== 0 && serverSocket !== 1) throw new Error("Invalid relay session endpoint");
  return { from: from.value, key: key.value, host: relayAddressHost(address.value, fallbackHost),
    port: port || fallbackPort, serverSocket: serverSocket === 1 };
}

async function joinRelaySession(invitation: ReturnType<typeof parseRelayInvitation>, signal?: AbortSignal) {
  const sessionTcp = await connectNodeTcp(invitation.host, invitation.port, signal);
  const reader = new NodeSocketReader(sessionTcp);
  try {
    await new Promise<void>((resolve, reject) => sessionTcp.write(
      relayMessage(RELAY_MESSAGE_TYPE_JOIN_SESSION_REQUEST, xdrOpaque(invitation.key)),
      error => error ? reject(error) : resolve(),
    ));
    const joined = await readRelayMessage(reader);
    if (joined.type !== RELAY_MESSAGE_TYPE_RESPONSE) throw new Error("Unexpected relay join response type");
    const response = relayResponse(joined.payload);
    if (response.code !== 0) throw new Error(`Relay join failed (${response.code}): ${response.message || "no message"}`);
    reader.detachForTls();
    return sessionTcp;
  } catch (error) { reader.dispose(); sessionTcp.destroy(); throw error; }
}

async function wrapRelaySessionTls(sessionTcp: net.Socket, invitation: ReturnType<typeof parseRelayInvitation>,
  certPem: string, keyPem: string, alpnProtocols: readonly string[], signal?: AbortSignal) {
  if (!invitation.serverSocket) return connectNodeRelayTls(sessionTcp, {
    host: invitation.host, port: invitation.port, certPem, keyPem, alpn: alpnProtocols, signal,
  });
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const server = tls.createServer({ cert: certPem, key: keyPem,
      ALPNProtocols: [...alpnProtocols], requestCert: true, rejectUnauthorized: false,
      handshakeTimeout: 10000 });
    const fail = (error: Error) => { sessionTcp.destroy(); reject(error); };
    server.once("tlsClientError", fail);
    server.once("secureConnection", socket => { server.off("tlsClientError", fail); resolve(socket); });
    server.emit("connection", sessionTcp);
  });
}

async function connectNodeRelay(options: SyncpeerRelayConnectOptions): Promise<SyncpeerRelayConnectResult> {
  const relay = await openRelayControl(options.relayAddress, options.certPem, options.keyPem, options.signal);
  const { socket: relaySocket, reader: relayReader } = relay;
  try {
    await new Promise<void>((resolve, reject) => relaySocket.write(
      relayMessage(RELAY_MESSAGE_TYPE_CONNECT_REQUEST,
        xdrOpaque(base32DecodeNoPadding(canonicalDeviceId(options.expectedDeviceId)))),
      error => error ? reject(error) : resolve(),
    ));
    const invitation = await readRelayMessage(relayReader);
    if (invitation.type === RELAY_MESSAGE_TYPE_RESPONSE) {
      const response = relayResponse(invitation.payload);
      throw new Error(`Relay connect request failed (${response.code}): ${response.message || "no message"}`);
    }
    if (invitation.type !== RELAY_MESSAGE_TYPE_SESSION_INVITATION) throw new Error("Unexpected relay response type");
    const session = parseRelayInvitation(invitation.payload, relay.host, relay.port);
    if (!session.from.equals(base32DecodeNoPadding(canonicalDeviceId(options.expectedDeviceId)))) {
      throw new Error("Relay invitation came from an unexpected device");
    }
    relayReader.dispose();
    relaySocket.destroy();
    const sessionTcp = await joinRelaySession(session, options.signal);
    const bepSocket = await wrapRelaySessionTls(sessionTcp, session, options.certPem, options.keyPem,
      options.alpnProtocols ?? ["bep/1.0"], options.signal);
    return { socket: new NodeTlsSocket(bepSocket),
      connectedVia: `relay://${relay.host}:${relay.port} -> ${session.host}:${session.port}` };
  } finally { relayReader.dispose(); relaySocket.destroy(); }
}

async function listenNodeRelay(options: SyncpeerRelayListenOptions): Promise<SyncpeerTlsListener> {
  type Accepted = Awaited<ReturnType<SyncpeerTlsListener["accept"]>>;
  const relay = await openRelayControl(options.relayAddress, options.certPem, options.keyPem);
  const accepted: Accepted[] = [];
  const waiters: Array<{ resolve: (value: Accepted) => void; reject: (error: Error) => void }> = [];
  const sockets = new Set<net.Socket>();
  const pending = new Set<Promise<void>>();
  let closed = false, closedError: Error | undefined;
  const fail = (error: Error) => {
    closedError ??= error;
    while (waiters.length) waiters.shift()?.reject(error);
  };
  try {
    await new Promise<void>((resolve, reject) => relay.socket.write(
      relayMessage(RELAY_MESSAGE_TYPE_JOIN_RELAY_REQUEST, new Uint8Array()),
      error => error ? reject(error) : resolve(),
    ));
    const joined = await readRelayMessage(relay.reader);
    if (joined.type !== RELAY_MESSAGE_TYPE_RESPONSE || relayResponse(joined.payload).code !== 0) {
      throw new Error("Relay refused the permanent device registration");
    }
  } catch (error) { relay.reader.dispose(); relay.socket.destroy(); throw error; }
  const pingTimer = setInterval(() => {
    if (!closed) relay.socket.write(relayMessage(RELAY_MESSAGE_TYPE_PING, new Uint8Array()));
  }, 20000);
  pingTimer.unref();
  const handleInvitation = (payload: Buffer) => {
    const task = (async () => {
      const invitation = parseRelayInvitation(payload, relay.host, relay.port);
      const tcp = await joinRelaySession(invitation);
      sockets.add(tcp);
      tcp.once("close", () => sockets.delete(tcp));
      try {
        const secure = await wrapRelaySessionTls(tcp, invitation, options.certPem, options.keyPem,
          options.alpnProtocols);
        const peer = secure.getPeerCertificate(true);
        if (!peer.raw || !crypto.createHash("sha256").update(peer.raw).digest().equals(invitation.from)) {
          throw new Error("Relay invitation identity does not match the peer certificate");
        }
        const value = { socket: new NodeTlsSocket(secure), remoteAddress: relay.host,
          remotePort: invitation.port, alpn: secure.alpnProtocol || "" };
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(value);
        else accepted.push(value);
      } catch (error) { tcp.destroy(); throw error; }
    })().catch(() => { /* A bad invitation cannot stop the permanent relay registration. */ });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const loop = (async () => {
    try {
      while (!closed) {
        const message = await readRelayMessage(relay.reader);
        if (message.type === RELAY_MESSAGE_TYPE_SESSION_INVITATION) handleInvitation(message.payload);
        else if (message.type === RELAY_MESSAGE_TYPE_PING) {
          relay.socket.write(relayMessage(RELAY_MESSAGE_TYPE_PONG, new Uint8Array()));
        } else if (message.type !== RELAY_MESSAGE_TYPE_PONG) throw new Error("Unexpected permanent relay message");
      }
    } catch (error) { if (!closed) fail(error instanceof Error ? error : new Error(String(error))); }
  })();
  return { port: 0,
    accept: () => {
      const value = accepted.shift();
      if (value) return Promise.resolve(value);
      if (closedError) return Promise.reject(closedError);
      return new Promise<Accepted>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close: async () => {
      closed = true;
      fail(new Error("Relay listener closed."));
      clearInterval(pingTimer);
      relay.reader.dispose();
      relay.socket.destroy();
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...pending]);
      await loop;
    } };
}

function normalizeDeviceId(id: string): string {
  return id.replace(/[^A-Z2-7]/gi, "").toUpperCase();
}

function canonicalDeviceId(id: string): string {
  const normalized = normalizeDeviceId(id);
  if (normalized.length !== 56) return normalized;
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const pos = i + 1;
    if (pos % 14 === 0) continue;
    out += normalized[i];
  }
  return out;
}

function base32NoPadding(input: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function computeDeviceIdFromDer(certDer: Uint8Array): string {
  const digest = crypto.createHash("sha256").update(Buffer.from(certDer)).digest();
  return base32NoPadding(new Uint8Array(digest));
}

function isWildcardAddress(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "";
}

function normalizeAnnounceAddress(
  address: string,
  fallbackHost: string,
): string | null {
  const trimmed = address.trim();
  if (trimmed === "") return null;
  if (!trimmed.includes("://")) {
    return `tcp://${fallbackHost}:${trimmed}`;
  }
  if (!/^tcp(?:4|6)?:\/\//.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.port) return null;
    const host = isWildcardAddress(parsed.hostname)
      ? fallbackHost
      : parsed.hostname;
    return `tcp://${host}:${parsed.port}`;
  } catch {
    return null;
  }
}

function tryParseLocalDiscoveryPacket(
  packet: Uint8Array,
): { deviceId: string; addresses: string[] } | null {
  if (packet.length < 4) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== LOCAL_DISCOVERY_MAGIC) return null;
  let decoded: { id?: unknown; addresses?: unknown };
  try {
    decoded = LocalDiscoveryAnnounce.decode(packet.slice(4)) as unknown as {
      id?: unknown;
      addresses?: unknown;
    };
  } catch {
    return null;
  }
  const id = decoded.id instanceof Uint8Array ? decoded.id : null;
  if (!id || id.length === 0) return null;
  const addresses = Array.isArray(decoded?.addresses)
    ? decoded.addresses
      .filter((entry: unknown): entry is string => typeof entry === "string")
    : [];
  return {
    deviceId: canonicalDeviceId(base32NoPadding(id)),
    addresses,
  };
}

interface ResolveNodeLocalDiscoveryOptions {
  expectedDeviceId?: string;
  timeoutMs?: number;
  listenPort?: number;
  signal?: AbortSignal;
}

export async function resolveNodeLocalDiscovery(
  options: ResolveNodeLocalDiscoveryOptions = {},
): Promise<{ payload: unknown; candidates: DiscoveredCandidate[] }> {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs && options.timeoutMs > 0
    ? Math.min(30000, Math.floor(options.timeoutMs))
    : 5000;
  const listenPort = Number.isFinite(options.listenPort) && options.listenPort && options.listenPort > 0
    ? Math.floor(options.listenPort)
    : LOCAL_DISCOVERY_PORT;
  const expectedId = options.expectedDeviceId
    ? canonicalDeviceId(options.expectedDeviceId)
    : "";
  const candidatesByAddress = new Map<string, DiscoveredCandidate>();
  const seenAnnouncements = new Map<string, { from: string; addresses: string[] }>();
  let boundCount = 0;
  let blockedCount = 0;
  const bindErrors: Array<{ socket: "udp4" | "udp6"; code: string; message: string }> = [];
  const multicastMembership: Array<{
    socket: "udp6";
    iface: string;
    joined: boolean;
    error?: string;
  }> = [];
  const stats = {
    packetsReceived: 0,
    packetsBySocket: { udp4: 0, udp6: 0 },
    packetsMagicMismatch: 0,
    packetsDecodeFailed: 0,
    packetsMissingId: 0,
    packetsFilteredByExpectedId: 0,
    announcementsAccepted: 0,
    announcementsWithNoAddresses: 0,
    uniqueSources: new Set<string>(),
  };
  const sockets: dgram.Socket[] = [];
  const abortSignal = options.signal;
  const processMessage = (
    socketType: "udp4" | "udp6",
    message: Buffer<ArrayBufferLike>,
    sourceAddress: string,
  ) => {
    stats.packetsReceived += 1;
    stats.packetsBySocket[socketType] += 1;
    stats.uniqueSources.add(sourceAddress);
    const decoded = tryParseLocalDiscoveryPacket(new Uint8Array(message));
    if (!decoded) {
      if (message.length < 4) {
        stats.packetsDecodeFailed += 1;
        return;
      }
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const magic = view.getUint32(0, false);
      if (magic !== LOCAL_DISCOVERY_MAGIC) {
        stats.packetsMagicMismatch += 1;
      } else {
        stats.packetsDecodeFailed += 1;
      }
      return;
    }
    if (!decoded.deviceId) {
      stats.packetsMissingId += 1;
      return;
    }
    if (expectedId && canonicalDeviceId(decoded.deviceId) !== expectedId) {
      stats.packetsFilteredByExpectedId += 1;
      return;
    }
    const normalizedAddresses = decoded.addresses
      .map((address) => normalizeAnnounceAddress(address, sourceAddress))
      .filter((entry): entry is string => entry !== null);
    if (normalizedAddresses.length === 0) {
      stats.announcementsWithNoAddresses += 1;
    }
    stats.announcementsAccepted += 1;
    seenAnnouncements.set(decoded.deviceId, {
      from: sourceAddress,
      addresses: normalizedAddresses,
    });
    for (const address of normalizedAddresses) {
      let parsed: URL;
      try {
        parsed = new URL(address);
      } catch {
        continue;
      }
      if (parsed.protocol === "tcp:" && parsed.hostname && parsed.port) {
        candidatesByAddress.set(address, {
          address,
          protocol: "tcp",
          host: parsed.hostname,
          port: Number(parsed.port),
          deviceId: decoded.deviceId,
        });
      }
    }
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (onAbort && abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      for (const socket of sockets) {
        socket.removeAllListeners("message");
        socket.removeAllListeners("error");
        socket.close();
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    if (abortSignal) {
      onAbort = () => {
        clearTimeout(timer);
        finish();
      };
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    const onSocketError = (type: "udp4" | "udp6", error: NodeJS.ErrnoException) => {
      bindErrors.push({
        socket: type,
        code: error.code ?? "UNKNOWN",
        message: error.message,
      });
      if (error.code === "EADDRINUSE" || error.code === "EPERM") {
        blockedCount += 1;
        if (blockedCount >= 2 && boundCount === 0) {
          clearTimeout(timer);
          finish();
        }
        return;
      }
      clearTimeout(timer);
      finish(error);
    };
    const openSocket = (type: "udp4" | "udp6", host: string) => {
      const socket = dgram.createSocket({ type, reuseAddr: true });
      sockets.push(socket);
      socket.on("error", (error) => onSocketError(type, error));
      socket.on("message", (message, rinfo) => {
        processMessage(type, message, rinfo.address);
      });
      socket.once("listening", () => {
        boundCount += 1;
        if (type === "udp6") {
          for (const ifaceName of Object.keys(os.networkInterfaces())) {
            try {
              socket.addMembership("ff12::8384", ifaceName);
              multicastMembership.push({
                socket: "udp6",
                iface: ifaceName,
                joined: true,
              });
            } catch {
              multicastMembership.push({
                socket: "udp6",
                iface: ifaceName,
                joined: false,
                error: "addMembership failed",
              });
            }
          }
        }
      });
      socket.bind(listenPort, host);
    };
    openSocket("udp4", "0.0.0.0");
    openSocket("udp6", "::");
  });
  return {
    payload: {
      source: "local-udp",
      timeoutMs,
      listenPort,
      socketsAttempted: 2,
      socketsBound: boundCount,
      bindErrors,
      multicastMembership,
      stats: {
        packetsReceived: stats.packetsReceived,
        packetsBySocket: stats.packetsBySocket,
        packetsMagicMismatch: stats.packetsMagicMismatch,
        packetsDecodeFailed: stats.packetsDecodeFailed,
        packetsMissingId: stats.packetsMissingId,
        packetsFilteredByExpectedId: stats.packetsFilteredByExpectedId,
        announcementsAccepted: stats.announcementsAccepted,
        announcementsWithNoAddresses: stats.announcementsWithNoAddresses,
        uniqueSources: [...stats.uniqueSources],
      },
      announcements: [...seenAnnouncements.entries()].map(([deviceId, entry]) => ({
        deviceId,
        from: entry.from,
        addresses: entry.addresses,
      })),
    },
    candidates: [...candidatesByAddress.values()],
  };
}

async function discoverNodeLocalCandidates(options: {
  expectedDeviceId: string;
  timeoutMs?: number;
}): Promise<DiscoveredCandidate[]> {
  const result = await resolveNodeLocalDiscovery({
    expectedDeviceId: options.expectedDeviceId,
    timeoutMs: options.timeoutMs ?? 1200,
  });
  return result.candidates;
}

function createDiscoveryResponse(
  status: number,
  body: ByteBuffer,
): SyncpeerDiscoveryResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text(): Promise<string> {
      return body.toString("utf8");
    },
    async json(): Promise<unknown> {
      return JSON.parse(body.toString("utf8"));
    },
  };
}

function decodeChunkedBody(body: ByteBuffer): ByteBuffer {
  let offset = 0;
  const chunks: ByteBuffer[] = [];
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset, "utf8");
    if (lineEnd < 0) break;
    const sizeHex = body.slice(offset, lineEnd).toString("utf8").split(";", 1)[0].trim();
    const size = parseInt(sizeHex, 16);
    offset = lineEnd + 2;
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) break;
    chunks.push(body.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function parseRawHttpResponse(raw: ByteBuffer): SyncpeerDiscoveryResponse {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    throw new Error("Malformed HTTP response from discovery server");
  }
  const headerText = raw.slice(0, headerEnd).toString("utf8");
  const lines = headerText.split("\r\n");
  const statusLine = lines[0] ?? "";
  const match = statusLine.match(/^HTTP\/\d+\.\d+\s+(\d+)/);
  if (!match) {
    throw new Error(`Malformed HTTP status line: ${statusLine}`);
  }
  const status = Number(match[1]);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  const body: ByteBuffer = (headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")
    ? decodeChunkedBody(raw.slice(headerEnd + 4))
    : raw.slice(headerEnd + 4);
  return createDiscoveryResponse(status, body);
}

async function rawPinnedDiscoveryFetch(
  input: string | URL,
  init?: SyncpeerDiscoveryFetchInit,
): Promise<SyncpeerDiscoveryResponse> {
  const url = typeof input === "string" ? new URL(input) : input;
  if (url.protocol !== "https:") {
    throw new Error(`Pinned discovery requires https: URL, got ${url.protocol}`);
  }
  const host = url.hostname;
  const port = Number(url.port || 443);
  const pinServerDeviceId = init?.pinServerDeviceId?.trim();
  const allowInsecureTls = !!init?.allowInsecureTls;

  const socket = tls.connect({
    host,
    port,
    servername: host,
    ALPNProtocols: ["http/1.1"],
    rejectUnauthorized: false,
  });
  const onAbort = () => socket.destroy(new Error("Discovery request cancelled."));
  if (init?.signal?.aborted) onAbort();
  else init?.signal?.addEventListener("abort", onAbort, { once: true });

  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });

  if (!allowInsecureTls && pinServerDeviceId) {
    const peer = socket.getPeerCertificate(true);
    if (!peer?.raw) {
      socket.destroy();
      throw new Error("Discovery server certificate missing");
    }
    const got = canonicalDeviceId(computeDeviceIdFromDer(new Uint8Array(peer.raw)));
    const want = canonicalDeviceId(pinServerDeviceId);
    if (got !== want) {
      socket.destroy();
      throw new Error(`Discovery server certificate ID mismatch: expected ${pinServerDeviceId}, got ${got}`);
    }
  }

  const method = init?.method ?? "GET";
  const pathWithQuery = `${url.pathname}${url.search}`;
  const headerLines = Object.entries(init?.headers ?? {}).map(([key, value]) => `${key}: ${value}`);
  const requestText = [
    `${method} ${pathWithQuery} HTTP/1.1`,
    `Host: ${url.host}`,
    "Accept: application/json",
    "Connection: close",
    ...headerLines,
    "",
    "",
  ].join("\r\n");

  socket.write(requestText, "utf8");
  const chunks: ByteBuffer[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: ByteBuffer) => chunks.push(Buffer.from(chunk)));
    socket.once("end", resolve);
    socket.once("close", resolve);
    socket.once("error", reject);
  });
  socket.destroy();
  init?.signal?.removeEventListener("abort", onAbort);
  return parseRawHttpResponse(Buffer.concat(chunks));
}

async function nodeDiscoveryFetch(
  input: string | URL,
  init?: SyncpeerDiscoveryFetchInit,
): Promise<SyncpeerDiscoveryResponse> {
  if (init?.pinServerDeviceId || init?.allowInsecureTls) {
    return rawPinnedDiscoveryFetch(input, init);
  }
  const url = typeof input === "string" ? new URL(input) : input;
  return new Promise<SyncpeerDiscoveryResponse>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: init?.method ?? "GET",
        headers: init?.headers,
        signal: init?.signal,
      },
      (response) => {
        const chunks: ByteBuffer[] = [];
        response.on("data", (chunk: ByteBuffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve(
            createDiscoveryResponse(
              response.statusCode ?? 0,
              Buffer.concat(chunks),
            ),
          );
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export function createNodeHostAdapter(): SyncpeerHostAdapter {
  const enableLogs = process.env.SYNCPEER_DEBUG === "1";
  return {
    connectTls: connectNodeTls,
    listenTls: listenNodeTls,
    connectQuic: connectNodeQuic,
    connectRelay: connectNodeRelay,
    listenRelay: listenNodeRelay,
    async sha256(data: Uint8Array): Promise<Uint8Array> {
      const digest = crypto.createHash("sha256").update(Buffer.from(data)).digest();
      return new Uint8Array(digest);
    },
    randomBytes(length: number): Uint8Array {
      return new Uint8Array(crypto.randomBytes(length));
    },
    discoveryFetch: nodeDiscoveryFetch,
    discoverLocalCandidates: discoverNodeLocalCandidates,
    log: enableLogs
      ? (event) => { console.error(`[syncpeer-core] ${event}`); }
      : undefined,
  };
}

export async function resolveNodeGlobalDiscovery(
  options: SyncpeerGlobalDiscoveryOptions,
): Promise<Awaited<ReturnType<typeof resolveGlobalDiscovery>>> {
  return resolveGlobalDiscovery(createNodeHostAdapter(), options);
}

export const createNodeSyncpeerClient = () => createSyncpeerCoreClient(createNodeHostAdapter());

export async function listenNodePeers(options: Omit<SyncpeerConnectOptions, "expectedDeviceId" | "port"> & {
  port?: number;
  approvedDeviceIds: readonly string[];
  onSession: (session: SyncpeerSessionHandle, remoteDeviceId: string) => void;
  onError?: (error: unknown) => void;
}): Promise<{ port: number;
  activeSessions: () => PeerSessionCandidate<SyncpeerSessionHandle>[];
  admitOutgoing: (remoteDeviceId: string, connectionId: string, session: SyncpeerSessionHandle) => Promise<boolean>;
  close: () => Promise<void> }> {
  const adapter = createNodeHostAdapter();
  const localCertificate = new crypto.X509Certificate(options.certPem);
  const localDeviceId = canonicalDeviceId(computeDeviceIdFromDer(new Uint8Array(localCertificate.raw)));
  return startIncomingPeerService(adapter, { ...options, localDeviceId,
    handshakeTimeoutMs: options.timeoutMs,
    connectionOptions: (expectedDeviceId, endpoint) =>
      ({ ...options, ...endpoint, expectedDeviceId }) });
}

/** Compatibility wrapper for callers that approve one peer. */
export async function listenNodePeer(options: SyncpeerConnectOptions & {
  expectedDeviceId: string;
  onSession: (session: SyncpeerSessionHandle) => void;
  onError?: (error: unknown) => void;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const listener = await listenNodePeers({ ...options, approvedDeviceIds: [options.expectedDeviceId],
    onSession: session => options.onSession(session) });
  return { port: listener.port, close: listener.close };
}

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
  value: string | undefined,
  label: "cert" | "key",
): Promise<string> => {
  if (!value) {
    throw new Error(`Missing ${label}. Provide PEM text or a readable file path.`);
  }
  const inline = maybeInlinePem(value);
  if (inline) return inline;
  return readFile(value, "utf8");
};

export const createNodeSessionTransport = (): SessionTransport => {
  const coreClient = createNodeSyncpeerClient();
  let activeOptions: ConnectOptions | null = null;
  let focusedFolderId: string | null = null;

  const keyFor = (options: ConnectOptions): string =>
    JSON.stringify({
      host: options.host,
      port: options.port,
      discoveryMode: options.discoveryMode ?? "automatic",
      discoveryServer: options.discoveryServer ?? "",
      remoteId: options.remoteId ?? "",
      deviceName: options.deviceName,
      timeoutMs: options.timeoutMs ?? 0,
      enableRelayFallback: options.enableRelayFallback ?? true,
      relayOnly: options.relayOnly ?? false,
      quicOnly: options.quicOnly ?? false,
      folderPasswords: options.folderPasswords ?? {},
      sharedFolders: options.sharedFolders ?? [],
      cert: options.cert ?? "",
      key: options.key ?? "",
    });

  const openSession = async (options: ConnectOptions, signal: AbortSignal) => {
    const certPem = await resolvePemValue(options.cert, "cert");
    const keyPem = await resolvePemValue(options.key, "key");
    return coreClient.openSession({
      host: options.host,
      port: options.port,
      discoveryMode: options.discoveryMode,
      discoveryServer: options.discoveryServer,
      certPem,
      keyPem,
      expectedDeviceId: options.remoteId,
      deviceName: options.deviceName,
      timeoutMs: options.timeoutMs,
      enableRelayFallback: options.enableRelayFallback,
      folderPasswords: options.folderPasswords,
      sharedFolders: options.sharedFolders,
      relayOnly: options.relayOnly,
      quicOnly: options.quicOnly,
    }, signal);
  };

  const lifecycle = createConnectionLifecycle<ConnectOptions>({ open: openSession, keyFor });
  const ensureSession = (options: ConnectOptions) => lifecycle.ensureSession(options);
  const remoteFs = createRecoveringRemoteFs({
    getOptions: () => activeOptions,
    ensureSession,
    getFocusedFolderId: () => focusedFolderId,
    setFocusedFolderId: (folderId) => { focusedFolderId = folderId; },
    getActiveSession: lifecycle.getSession,
  });

  return {
    connectAndSync: async (options: ConnectOptions): Promise<RemoteFsLike> => {
      await lifecycle.connect(options);
      activeOptions = options;
      return remoteFs;
    },
    connectAndGetOverview: async (options: ConnectOptions): Promise<ConnectionOverview> => {
      const overview = await withMetadataSession(
        options,
        ensureSession,
        focusedFolderId,
        async (session) => {
          const [folders, device, folderSyncStates] = await Promise.all([
            session.remoteFs.listFolders(),
            Promise.resolve(session.remoteFs.getRemoteDeviceInfo?.() ?? null),
            Promise.resolve(session.remoteFs.listFolderSyncStates?.() ?? []),
          ]);
          return {
            folders,
            device,
            folderSyncStates,
            connectedVia: session.connectedVia,
            transportKind: session.transportKind,
            connectionScope: session.connectionScope,
          };
        },
      );
      activeOptions = options;
      return overview;
    },
    connectAndGetFolderVersions: async (options: ConnectOptions) => {
      const versions = await withMetadataSession(
        options,
        ensureSession,
        focusedFolderId,
        async (session) => {
          const states = session.remoteFs.listFolderSyncStates?.();
          return Promise.resolve(states ?? []);
        },
      );
      activeOptions = options;
      return versions;
    },
    disconnect: async () => {
      activeOptions = null;
      focusedFolderId = null;
      await lifecycle.disconnect();
    },
    subscribeLifecycle: lifecycle.subscribe,
    setOnline: lifecycle.setOnline,
    setForeground: lifecycle.setForeground,
    setTransferActive: lifecycle.setTransferActive,
  };
};
