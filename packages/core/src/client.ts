import {
  encodeHelloFrame,
  encodeMessageFrame,
  FrameParser,
  MessageTypeValues,
  Hello,
  ClusterConfig,
  Index,
  Request,
} from "./core/protocol/bep.js";
import { RemoteDeviceInfo, RemoteFs } from "./core/model/remoteFs.js";

export interface SyncpeerTlsConnectOptions {
  host: string;
  port: number;
  certPem: string;
  keyPem: string;
  caPem?: string;
}

export interface SyncpeerTlsSocket {
  read: (maxBytes?: number) => Promise<Uint8Array>;
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  peerCertificateDer: () => Promise<Uint8Array>;
}

export interface SyncpeerRelayConnectOptions {
  relayAddress: string;
  expectedDeviceId: string;
  certPem: string;
  keyPem: string;
  caPem?: string;
}

export interface SyncpeerRelayConnectResult {
  socket: SyncpeerTlsSocket;
  connectedVia: string;
}

export interface SyncpeerDiscoveryFetchInit {
  method?: string;
  headers?: Record<string, string>;
  pinServerDeviceId?: string;
  allowInsecureTls?: boolean;
}

export interface SyncpeerDiscoveryResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface SyncpeerHostAdapter {
  connectTls: (
    options: SyncpeerTlsConnectOptions,
  ) => Promise<SyncpeerTlsSocket>;
  connectRelay?: (
    options: SyncpeerRelayConnectOptions,
  ) => Promise<SyncpeerRelayConnectResult>;
  sha256: (data: Uint8Array) => Promise<Uint8Array> | Uint8Array;
  randomBytes: (length: number) => Promise<Uint8Array> | Uint8Array;
  discoveryFetch: (
    input: string | URL,
    init?: SyncpeerDiscoveryFetchInit,
  ) => Promise<SyncpeerDiscoveryResponse>;
  log?: (event: string, details?: Record<string, unknown>) => void;
}

export interface SyncpeerConnectOptions {
  host: string;
  port: number;
  certPem: string;
  keyPem: string;
  caPem?: string;
  expectedDeviceId?: string;
  deviceName: string;
  clientName?: string;
  clientVersion?: string;
  timeoutMs?: number;
  discoveryMode?: "global" | "direct";
  discoveryServer?: string;
  enableRelayFallback?: boolean;
}

export interface SyncpeerGlobalDiscoveryOptions {
  expectedDeviceId: string;
  discoveryServer?: string;
}

export interface DiscoveredCandidate {
  address: string;
  protocol: "tcp" | "relay" | "unknown";
  host?: string;
  port?: number;
}

export interface SyncpeerGlobalDiscoveryResult {
  payload: unknown;
  candidates: DiscoveredCandidate[];
}

export interface SyncpeerSessionHandle {
  remoteFs: RemoteFs;
  connectedVia: string;
  transportKind: "direct-tcp" | "relay";
  close: () => Promise<void>;
}

interface FolderState {
  id: string;
  label: string;
  readOnly: boolean;
  indexReceived: boolean;
  remoteIndexId?: string;
  remoteMaxSequence?: string;
  files: Map<string, any>;
}

interface PendingRequestMeta {
  id: number;
  folder: string;
  name: string;
  offset: number;
  size: number;
  blockNo: number;
  fromTemporary: boolean;
  hashLength: number;
  startedAtMs: number;
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function decodeBase64(raw: string): Uint8Array {
  if (typeof atob === "function") {
    const decoded = atob(raw);
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
    return out;
  }
  const ctor = (
    globalThis as {
      Buffer?: { from: (value: string, encoding: string) => Uint8Array };
    }
  ).Buffer;
  if (ctor) return new Uint8Array(ctor.from(raw, "base64"));
  throw new Error("No base64 decoder available in this runtime");
}

function parseFirstCertificateDer(pem: string): Uint8Array {
  const match = pem.match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
  );
  if (!match) {
    throw new Error("Could not parse CERTIFICATE PEM block from certPem");
  }
  const body = match[1].replace(/\s+/g, "");
  return decodeBase64(body);
}

async function computeDeviceId(
  adapter: SyncpeerHostAdapter,
  certDer: Uint8Array,
): Promise<string> {
  const digest = await adapter.sha256(certDer);
  return base32NoPadding(digest);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0)
    return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Connection timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeDiscoveryServerUrl(rawUrl: string | undefined): URL {
  const raw = (rawUrl ?? "").trim();
  const defaultUrl = "https://discovery.syncthing.net/v2/";
  const withScheme =
    raw === "" ? defaultUrl : raw.includes("://") ? raw : `https://${raw}`;
  const base = new URL(withScheme);
  if (base.pathname === "/" || base.pathname === "") {
    base.pathname = "/v2/";
  }
  if (!base.pathname.endsWith("/")) {
    base.pathname = `${base.pathname}/`;
  }
  return base;
}

function parseDiscoveryCandidate(address: unknown): DiscoveredCandidate | null {
  if (typeof address !== "string" || address.trim() === "") return null;
  const value = address.trim();
  if (value.startsWith("tcp://")) {
    const parsed = new URL(value);
    if (!parsed.hostname || !parsed.port) return null;
    return {
      address: value,
      protocol: "tcp",
      host: parsed.hostname,
      port: Number(parsed.port),
    };
  }
  if (value.startsWith("relay://")) {
    const parsed = new URL(value);
    return {
      address: value,
      protocol: "relay",
      host: parsed.hostname || undefined,
      port: parsed.port ? Number(parsed.port) : undefined,
    };
  }
  return { address: value, protocol: "unknown" };
}

function isPrivateIpv4(host: string): boolean {
  if (/^10\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    return n >= 16 && n <= 31;
  }
  return false;
}

function scoreCandidate(candidate: DiscoveredCandidate): number {
  if (candidate.protocol === "relay") return 0;
  if (candidate.protocol !== "tcp") return -1;
  if (!candidate.host) return -1;
  // Prefer LAN/private routes first; on mobile this is often the fastest
  // reliable path when both private and public candidates are present.
  return isPrivateIpv4(candidate.host) ? 200 : 100;
}

function describeCandidate(candidate: DiscoveredCandidate): string {
  return `${candidate.address} (${candidate.protocol}${candidate.host ? ` ${candidate.host}` : ""}${candidate.port ? `:${candidate.port}` : ""})`;
}

function dedupeCandidates(candidates: DiscoveredCandidate[]): DiscoveredCandidate[] {
  const seen = new Set<string>();
  const out: DiscoveredCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.protocol}:${candidate.host ?? ""}:${candidate.port ?? ""}:${candidate.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function extractDiscoveryAuth(url: URL): {
  pinServerDeviceId?: string;
  allowInsecureTls: boolean;
} {
  const pinServerDeviceId =
    url.searchParams.get("id")?.trim() || undefined;
  const allowInsecureTls = url.searchParams.has("insecure");
  url.searchParams.delete("id");
  url.searchParams.delete("insecure");
  return { pinServerDeviceId, allowInsecureTls };
}

async function resolveGlobalDiscoveryInternal(
  adapter: SyncpeerHostAdapter,
  options: SyncpeerGlobalDiscoveryOptions,
): Promise<SyncpeerGlobalDiscoveryResult> {
  if (!options.expectedDeviceId) {
    throw new Error(
      "Remote Device ID is required when discovery mode is global.",
    );
  }
  const server = normalizeDiscoveryServerUrl(options.discoveryServer);
  const auth = extractDiscoveryAuth(server);
  server.searchParams.set("device", options.expectedDeviceId);
  const response = await adapter.discoveryFetch(server.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    pinServerDeviceId: auth.pinServerDeviceId,
    allowInsecureTls: auth.allowInsecureTls,
  });
  if (response.status === 404) {
    throw new Error(
      `Global discovery did not find device ${options.expectedDeviceId}.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Global discovery failed (${response.status}): ${await response.text()}`,
    );
  }
  const payload = await response.json();
  const rawAddresses: unknown[] = Array.isArray((payload as any)?.addresses)
    ? (payload as any).addresses
    : [];
  const candidates = dedupeCandidates(
    rawAddresses
      .map(parseDiscoveryCandidate)
      .filter((entry): entry is DiscoveredCandidate => entry !== null),
  );

  adapter.log?.("core.discovery.full_response", {
    expectedDeviceId: options.expectedDeviceId,
    payload,
    candidates,
  });

  return { payload, candidates };
}

export async function resolveGlobalDiscovery(
  adapter: SyncpeerHostAdapter,
  options: SyncpeerGlobalDiscoveryOptions,
): Promise<SyncpeerGlobalDiscoveryResult> {
  return resolveGlobalDiscoveryInternal(adapter, options);
}

class BepSession {
  private parser: FrameParser;
  private pending = new Map<
    number,
    {
      resolve: (data: Uint8Array) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      meta: PendingRequestMeta;
    }
  >();
  private nextId = 1;
  private folders = new Map<string, FolderState>();
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyState: "pending" | "ready" | "closed" = "pending";
  private closeReason: Error | null = null;
  private closed = false;
  private echoedClusterConfig = false;
  private localIndexId: string;

  constructor(
    private socket: SyncpeerTlsSocket,
    private adapter: SyncpeerHostAdapter,
    private localDeviceId: Uint8Array,
    private localDeviceName: string,
    private remoteDeviceId?: Uint8Array,
  ) {
    this.parser = new FrameParser((type, msg) => this.onFrame(type, msg));
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.localIndexId = "1";
  }

  async initialize(leftover: Uint8Array): Promise<void> {
    const random = await this.adapter.randomBytes(8);
    const view = new DataView(
      random.buffer,
      random.byteOffset,
      random.byteLength,
    );
    const value = view.getBigUint64(0, false);
    this.localIndexId = value === 0n ? "1" : value.toString();
    if (leftover.length > 0) {
      this.parser.feed(leftover);
    }
    void this.readLoop();
  }

  private log(event: string, details?: Record<string, unknown>): void {
    this.adapter.log?.(`core.${event}`, details);
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const chunk = await this.socket.read();
        if (this.closed) return;
        if (chunk.length === 0) {
          continue;
        }
        this.parser.feed(chunk);
      }
    } catch (error) {
      this.onSocketClosed(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private onSocketClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = "closed";
    this.closeReason = error;
    this.log("socket.closed", { message: error.message });
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.readyResolve();
  }

  private onFrame(type: number, msg: any): void {
    switch (type) {
      case MessageTypeValues.CLUSTER_CONFIG:
        this.handleClusterConfig(msg);
        break;
      case MessageTypeValues.INDEX:
      case MessageTypeValues.INDEX_UPDATE:
        this.handleIndex(msg);
        break;
      case MessageTypeValues.RESPONSE:
        this.handleResponse(msg);
        break;
      default:
        break;
    }
  }

  private handleClusterConfig(cfg: any): void {
    for (const folder of cfg.folders || []) {
      const folderDevices = Array.isArray(folder.devices) ? folder.devices : [];
      const remoteDevice = this.remoteDeviceId
        ? folderDevices.find((device: any) =>
            bytesEqual(device.id, this.remoteDeviceId!),
          )
        : folderDevices.find(
            (device: any) => !bytesEqual(device.id, this.localDeviceId),
          );
      const remoteIndexId =
        remoteDevice?.index_id != null ? String(remoteDevice.index_id) : "0";
      const remoteMaxSequence = String(remoteDevice?.max_sequence ?? 0);
      const state: FolderState = {
        id: folder.id,
        label: folder.label || folder.id,
        readOnly: !!folder.read_only || Number(folder.type ?? 0) === 2,
        indexReceived: false,
        remoteIndexId,
        remoteMaxSequence,
        files: new Map(),
      };
      this.folders.set(folder.id, state);
    }
    if (!this.echoedClusterConfig) {
      this.echoedClusterConfig = true;
      const folders = (cfg.folders || []).map((folder: any) => {
        const baseDevices = Array.isArray(folder.devices)
          ? [...folder.devices]
          : [];
        const devices = baseDevices
          .filter((device: any) => !bytesEqual(device.id, this.localDeviceId))
          .map((device: any) => {
            const next = { ...device };
            if (
              this.remoteDeviceId &&
              bytesEqual(device.id, this.remoteDeviceId)
            ) {
              next.max_sequence = 0;
              next.index_id = 0;
            }
            return next;
          });
        devices.push({
          id: this.localDeviceId,
          name: this.localDeviceName,
          addresses: ["dynamic"],
          compression: 0,
          max_sequence: 0,
          index_id: this.localIndexId,
        });
        return {
          ...folder,
          devices,
        };
      });
      const frame = encodeMessageFrame(
        MessageTypeValues.CLUSTER_CONFIG,
        ClusterConfig,
        { folders },
        0,
      );
      void this.socket.write(frame);
      for (const folder of folders) {
        const indexFrame = encodeMessageFrame(
          MessageTypeValues.INDEX,
          Index,
          { folder: folder.id, files: [], last_sequence: 0 },
          0,
        );
        void this.socket.write(indexFrame);
      }
    }
    if (this.readyState === "pending") {
      this.readyState = "ready";
      this.readyResolve();
    }
  }

  private handleIndex(index: any): void {
    const folderId = index.folder;
    const state = this.folders.get(folderId);
    if (!state) return;
    state.indexReceived = true;
    for (const file of index.files || []) {
      state.files.set(file.name, file);
    }
  }

  private handleResponse(resp: any): void {
    const id = resp.id;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.log("request.response", {
      id,
      folder: entry.meta.folder,
      name: entry.meta.name,
      offset: entry.meta.offset,
      size: entry.meta.size,
      blockNo: entry.meta.blockNo,
      fromTemporary: entry.meta.fromTemporary,
      code: Number(resp.code ?? 0),
      responseBytes: resp.data instanceof Uint8Array ? resp.data.length : null,
      durationMs: Date.now() - entry.meta.startedAtMs,
    });
    if (resp.code && resp.code !== 0) {
      const code = Number(resp.code);
      const label =
        code === 1
          ? "Generic Error"
          : code === 2
            ? "No Such File"
            : code === 3
              ? "Invalid File"
              : "Unknown Error";
      entry.reject(new Error(`Response error code ${code} (${label})`));
    } else {
      entry.resolve(resp.data as Uint8Array);
    }
  }

  async waitForReady(): Promise<void> {
    await this.readyPromise;
    if (this.readyState !== "ready") {
      throw (
        this.closeReason ??
        new Error("Connection closed before initial cluster config")
      );
    }
  }

  requestBlock(
    folder: string,
    name: string,
    offset: number,
    size: number,
    options?: { hash?: Uint8Array; blockNo?: number; fromTemporary?: boolean },
  ): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("Connection closed"));
    const id = this.nextId++;
    const blockHash = options?.hash ?? new Uint8Array(0);
    const blockNo = Number.isFinite(options?.blockNo)
      ? Number(options?.blockNo)
      : 0;
    const fromTemporary = options?.fromTemporary ?? true;
    const meta: PendingRequestMeta = {
      id,
      folder,
      name,
      offset,
      size,
      blockNo,
      fromTemporary,
      hashLength: blockHash.length,
      startedAtMs: Date.now(),
    };
    this.log("request.start", { ...meta });
    const frame = encodeMessageFrame(
      MessageTypeValues.REQUEST,
      Request,
      {
        id,
        folder,
        name,
        offset,
        size,
        hash: blockHash,
        block_no: blockNo,
        from_temporary: fromTemporary,
      },
      0,
    );
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log("request.timeout", {
          ...meta,
          durationMs: Date.now() - meta.startedAtMs,
        });
        reject(new Error(`Request timeout for ${name} at offset ${offset}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer, meta });
      this.socket.write(frame).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.log("request.write_failed", {
          ...meta,
          message: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - meta.startedAtMs,
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  buildRemoteFs(metadata: RemoteDeviceInfo): RemoteFs {
    return new RemoteFs(
      this.folders,
      (folder, name, offset, size, options) =>
        this.requestBlock(folder, name, offset, size, options),
      (event, details) => this.log(event.replace(/^core\./, ""), details),
      metadata,
      () => {
        void this.close();
      },
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    await this.socket.close();
  }
}

async function readRemoteHello(
  socket: SyncpeerTlsSocket,
): Promise<{ hello: any; leftover: Uint8Array }> {
  let buf = new Uint8Array(0);
  const magic = 0x2ea7d90b;
  while (true) {
    const chunk = await socket.read();
    if (chunk.length === 0)
      throw new Error("Connection closed before BEP hello");
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0);
    merged.set(chunk, buf.length);
    buf = merged;
    if (buf.length < 6) continue;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const gotMagic = view.getUint32(0, false);
    if (gotMagic !== magic)
      throw new Error(`Invalid hello magic ${gotMagic.toString(16)}`);
    const len = view.getUint16(4, false);
    if (buf.length < 6 + len) continue;
    const helloBuf = buf.slice(6, 6 + len);
    const leftover = buf.slice(6 + len);
    const hello = Hello.decode(helloBuf);
    return { hello, leftover };
  }
}

async function openBepSessionOnSocket(
  adapter: SyncpeerHostAdapter,
  socket: SyncpeerTlsSocket,
  opts: SyncpeerConnectOptions,
  connectedHost: string,
  connectedPort: number,
  connectedVia: string,
  transportKind: "direct-tcp" | "relay",
): Promise<SyncpeerSessionHandle> {
  adapter.log?.("core.bep.handshake.start", {
    connectedHost,
    connectedPort,
    expectedDeviceId: opts.expectedDeviceId,
  });
  const localCertDer = parseFirstCertificateDer(opts.certPem);
  const localDeviceId = await adapter.sha256(localCertDer);
  const peerCertDer = await socket.peerCertificateDer();
  const remoteDeviceIdBytes = await adapter.sha256(peerCertDer);
  const remoteDeviceId = await computeDeviceId(adapter, peerCertDer);
  adapter.log?.("core.bep.handshake.peer_cert", {
    connectedHost,
    connectedPort,
    remoteDeviceId,
    peerCertificateBytes: peerCertDer.length,
  });

  if (opts.expectedDeviceId) {
    const got = canonicalDeviceId(remoteDeviceId);
    const want = canonicalDeviceId(opts.expectedDeviceId);
    if (got !== want) {
      await socket.close();
      throw new Error(
        `Remote device ID mismatch: expected ${opts.expectedDeviceId}, got ${got} (connected to ${connectedHost}:${connectedPort})`,
      );
    }
  }

  adapter.log?.("core.bep.handshake.hello_send", {
    connectedHost,
    connectedPort,
  });
  const helloFrame = encodeHelloFrame({
    device_name: opts.deviceName,
    client_name: opts.clientName ?? "syncpeer",
    client_version: opts.clientVersion ?? "0.1.0",
  });
  await socket.write(helloFrame);
  const { hello, leftover } = await readRemoteHello(socket);
  adapter.log?.("core.bep.handshake.hello_recv", {
    connectedHost,
    connectedPort,
    remoteDeviceName: String(hello.device_name ?? "unknown"),
    remoteClientName: String(hello.client_name ?? "unknown"),
    remoteClientVersion: String(hello.client_version ?? "unknown"),
    leftoverBytes: leftover.length,
  });
  const remoteDeviceInfo: RemoteDeviceInfo = {
    id: remoteDeviceId,
    deviceName: String(hello.device_name ?? "unknown"),
    clientName: String(hello.client_name ?? "unknown"),
    clientVersion: String(hello.client_version ?? "unknown"),
  };

  const session = new BepSession(
    socket,
    adapter,
    localDeviceId,
    opts.deviceName,
    remoteDeviceIdBytes,
  );
  await session.initialize(leftover);
  adapter.log?.("core.bep.cluster_config.wait", {
    connectedHost,
    connectedPort,
  });
  await session.waitForReady();
  adapter.log?.("core.bep.handshake.ready", {
    connectedHost,
    connectedPort,
    remoteDeviceId,
  });
  return {
    remoteFs: session.buildRemoteFs(remoteDeviceInfo),
    connectedVia,
    transportKind,
    close: () => session.close(),
  };
}

async function openDirectSession(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  host: string,
  port: number,
): Promise<SyncpeerSessionHandle> {
  adapter.log?.("core.direct.connect.start", {
    host,
    port,
    deviceName: opts.deviceName,
    expectedDeviceId: opts.expectedDeviceId,
  });
  const socket = await adapter.connectTls({
    host,
    port,
    certPem: opts.certPem,
    keyPem: opts.keyPem,
    caPem: opts.caPem,
  });
  adapter.log?.("core.direct.connect.tls_ready", {
    host,
    port,
  });
  const session = await openBepSessionOnSocket(
    adapter,
    socket,
    opts,
    host,
    port,
    `tcp://${host}:${port}`,
    "direct-tcp",
  );
  adapter.log?.("core.direct.connect.ready", {
    host,
    port,
  });
  return session;
}

async function openRelaySession(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  relayAddress: string,
): Promise<SyncpeerSessionHandle> {
  if (!adapter.connectRelay) {
    throw new Error("Relay transport is not available in this host adapter");
  }
  if (!opts.expectedDeviceId) {
    throw new Error("Remote Device ID is required for relay connection");
  }
  adapter.log?.("core.relay.connect.start", {
    relayAddress,
    expectedDeviceId: opts.expectedDeviceId,
  });
  const relay = await adapter.connectRelay({
    relayAddress,
    expectedDeviceId: opts.expectedDeviceId,
    certPem: opts.certPem,
    keyPem: opts.keyPem,
    caPem: opts.caPem,
  });
  adapter.log?.("core.relay.connect.tunnel_ready", {
    relayAddress,
    connectedVia: relay.connectedVia,
  });
  const session = await openBepSessionOnSocket(
    adapter,
    relay.socket,
    opts,
    relay.connectedVia,
    0,
    relay.connectedVia,
    "relay",
  );
  adapter.log?.("core.relay.connect.ready", {
    relayAddress,
    connectedVia: relay.connectedVia,
  });
  return session;
}

async function openSession(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
): Promise<SyncpeerSessionHandle> {
  const discoveryMode = opts.discoveryMode ?? "direct";

  if (discoveryMode !== "global") {
    return openDirectSession(adapter, opts, opts.host, opts.port);
  }

  const discovery = await resolveGlobalDiscoveryInternal(adapter, {
    expectedDeviceId: opts.expectedDeviceId ?? "",
    discoveryServer: opts.discoveryServer,
  });

  const ordered = [...discovery.candidates].sort(
    (a, b) => scoreCandidate(b) - scoreCandidate(a),
  );

  const directCandidates = ordered.filter(
    (candidate) =>
      candidate.protocol === "tcp" &&
      candidate.host &&
      Number.isFinite(candidate.port),
  );

  const relayCandidates = ordered.filter(
    (candidate) => candidate.protocol === "relay",
  );

  adapter.log?.("core.discovery.candidates.ordered", {
    directCandidates,
    relayCandidates,
  });

  const totalTimeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs && opts.timeoutMs > 0
    ? opts.timeoutMs
    : 15000;
  const perCandidateTimeout = Math.max(
    8000,
    Math.min(30000, Math.floor(totalTimeout / Math.max(directCandidates.length || 1, 1))),
  );
  adapter.log?.("core.discovery.connect_strategy", {
    totalTimeout,
    perCandidateTimeout,
    directCandidateCount: directCandidates.length,
    relayCandidateCount: relayCandidates.length,
    orderedCandidates: ordered.map((candidate) => describeCandidate(candidate)),
  });

  const errors: string[] = [];
  if (directCandidates.length > 0) {
    const directResult = await new Promise<SyncpeerSessionHandle | null>((resolve) => {
      let pending = directCandidates.length;
      let settled = false;
      for (const candidate of directCandidates) {
        adapter.log?.("core.discovery.candidate.try", {
          address: candidate.address,
          host: candidate.host,
          port: candidate.port,
          perCandidateTimeout,
        });
        withTimeout(
          openDirectSession(
            adapter,
            opts,
            candidate.host!,
            candidate.port!,
          ),
          perCandidateTimeout,
        )
          .then(async (session) => {
            if (settled) {
              await session.close().catch(() => undefined);
              return;
            }
            settled = true;
            resolve(session);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            adapter.log?.("core.discovery.candidate.failed", {
              address: candidate.address,
              host: candidate.host,
              port: candidate.port,
              message,
            });
            errors.push(`${candidate.address}: ${message}`);
          })
          .finally(() => {
            pending -= 1;
            if (!settled && pending <= 0) {
              resolve(null);
            }
          });
      }
    });
    if (directResult) {
      return directResult;
    }
  }

  if (opts.enableRelayFallback !== false) {
    for (const candidate of relayCandidates) {
      try {
        adapter.log?.("core.discovery.relay.try", {
          address: candidate.address,
        });
        return await withTimeout(
          openRelaySession(adapter, opts, candidate.address),
          Math.max(10000, totalTimeout),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        adapter.log?.("core.discovery.relay.failed", {
          address: candidate.address,
          message,
        });
        errors.push(`${candidate.address}: ${message}`);
      }
    }
  } else if (relayCandidates.length > 0) {
    errors.push("Relay fallback is disabled by settings");
  }

  throw new Error(
    `Could not connect using discovered candidates. ${errors.join(" | ")}`,
  );
}

export interface SyncpeerCoreClient {
  openSession: (
    options: SyncpeerConnectOptions,
  ) => Promise<SyncpeerSessionHandle>;
}

export function createSyncpeerCoreClient(
  adapter: SyncpeerHostAdapter,
): SyncpeerCoreClient {
  return {
    openSession: (options: SyncpeerConnectOptions) =>
      withTimeout(openSession(adapter, options), options.timeoutMs),
  };
}
