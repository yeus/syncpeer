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

export interface SyncpeerHostAdapter {
  connectTls: (options: SyncpeerTlsConnectOptions) => Promise<SyncpeerTlsSocket>;
  sha256: (data: Uint8Array) => Promise<Uint8Array> | Uint8Array;
  randomBytes: (length: number) => Promise<Uint8Array> | Uint8Array;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
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
}

export interface SyncpeerSessionHandle {
  remoteFs: RemoteFs;
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
  const ctor = (globalThis as { Buffer?: { from: (value: string, encoding: string) => Uint8Array } }).Buffer;
  if (ctor) return new Uint8Array(ctor.from(raw, "base64"));
  throw new Error("No base64 decoder available in this runtime");
}

function parseFirstCertificateDer(pem: string): Uint8Array {
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!match) {
    throw new Error("Could not parse CERTIFICATE PEM block from certPem");
  }
  const body = match[1].replace(/\s+/g, "");
  return decodeBase64(body);
}

async function computeDeviceId(adapter: SyncpeerHostAdapter, certDer: Uint8Array): Promise<string> {
  const digest = await adapter.sha256(certDer);
  return base32NoPadding(digest);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Connection timed out after ${timeoutMs} ms`)), timeoutMs);
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
  const withScheme = raw === "" ? defaultUrl : raw.includes("://") ? raw : `https://${raw}`;
  const base = new URL(withScheme);
  if (base.pathname === "/" || base.pathname === "") {
    base.pathname = "/v2/";
  }
  if (!base.pathname.endsWith("/")) {
    base.pathname = `${base.pathname}/`;
  }
  return base;
}

function parseDiscoveryAddress(address: unknown): { host: string; port: number } | null {
  if (typeof address !== "string" || address.trim() === "") return null;
  const value = address.trim();
  if (!value.startsWith("tcp://")) return null;
  const parsed = new URL(value);
  if (!parsed.hostname || !parsed.port) return null;
  return { host: parsed.hostname, port: Number(parsed.port) };
}

async function resolveHostPortFromGlobalDiscovery(
  adapter: SyncpeerHostAdapter,
  options: SyncpeerConnectOptions,
): Promise<{ host: string; port: number }> {
  if (!options.expectedDeviceId) {
    throw new Error("Remote Device ID is required when discovery mode is global.");
  }
  const server = normalizeDiscoveryServerUrl(options.discoveryServer);
  server.searchParams.set("device", options.expectedDeviceId);
  const response = await adapter.fetch(server.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    throw new Error(`Global discovery did not find device ${options.expectedDeviceId}.`);
  }
  if (!response.ok) {
    throw new Error(`Global discovery failed (${response.status}): ${await response.text()}`);
  }
  const payload = await response.json();
  const addresses: unknown[] = Array.isArray(payload?.addresses) ? payload.addresses : [];
  const resolved = addresses.map(parseDiscoveryAddress).find((entry: { host: string; port: number } | null) => entry !== null) ?? null;
  if (!resolved) {
    throw new Error(
      `Global discovery returned no supported tcp:// addresses for device ${options.expectedDeviceId}.`,
    );
  }
  return resolved;
}

class BepSession {
  private parser: FrameParser;
  private pending = new Map<number, {
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    meta: PendingRequestMeta;
  }>();
  private nextId = 1;
  private folders = new Map<string, FolderState>();
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
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
    const view = new DataView(random.buffer, random.byteOffset, random.byteLength);
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
          // Tauri transport can return empty chunks on read poll timeouts.
          continue;
        }
        this.parser.feed(chunk);
      }
    } catch (error) {
      this.onSocketClosed(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onSocketClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
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
        ? folderDevices.find((device: any) => bytesEqual(device.id, this.remoteDeviceId!))
        : folderDevices.find((device: any) => !bytesEqual(device.id, this.localDeviceId));
      const remoteIndexId = remoteDevice?.index_id != null ? String(remoteDevice.index_id) : "0";
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
        const baseDevices = Array.isArray(folder.devices) ? [...folder.devices] : [];
        const devices = baseDevices
          .filter((device: any) => !bytesEqual(device.id, this.localDeviceId))
          .map((device: any) => {
            const next = { ...device };
            if (this.remoteDeviceId && bytesEqual(device.id, this.remoteDeviceId)) {
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
      const frame = encodeMessageFrame(MessageTypeValues.CLUSTER_CONFIG, ClusterConfig, { folders }, 0);
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
    this.readyResolve();
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
        code === 1 ? "Generic Error" :
        code === 2 ? "No Such File" :
        code === 3 ? "Invalid File" :
        "Unknown Error";
      entry.reject(new Error(`Response error code ${code} (${label})`));
    } else {
      entry.resolve(resp.data as Uint8Array);
    }
  }

  async waitForReady(): Promise<void> {
    await this.readyPromise;
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
    const blockNo = Number.isFinite(options?.blockNo) ? Number(options?.blockNo) : 0;
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
    const frame = encodeMessageFrame(MessageTypeValues.REQUEST, Request, {
      id,
      folder,
      name,
      offset,
      size,
      hash: blockHash,
      block_no: blockNo,
      from_temporary: fromTemporary,
    }, 0);
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
      (folder, name, offset, size, options) => this.requestBlock(folder, name, offset, size, options),
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

async function readRemoteHello(socket: SyncpeerTlsSocket): Promise<{ hello: any; leftover: Uint8Array }> {
  let buf = new Uint8Array(0);
  const magic = 0x2ea7d90b;
  while (true) {
    const chunk = await socket.read();
    if (chunk.length === 0) throw new Error("Connection closed before BEP hello");
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0);
    merged.set(chunk, buf.length);
    buf = merged;
    if (buf.length < 6) continue;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const gotMagic = view.getUint32(0, false);
    if (gotMagic !== magic) throw new Error(`Invalid hello magic ${gotMagic.toString(16)}`);
    const len = view.getUint16(4, false);
    if (buf.length < 6 + len) continue;
    const helloBuf = buf.slice(6, 6 + len);
    const leftover = buf.slice(6 + len);
    const hello = Hello.decode(helloBuf);
    return { hello, leftover };
  }
}

async function openSession(adapter: SyncpeerHostAdapter, opts: SyncpeerConnectOptions): Promise<SyncpeerSessionHandle> {
  const discoveryMode = opts.discoveryMode ?? "direct";
  let targetHost = opts.host;
  let targetPort = opts.port;

  if (discoveryMode === "global") {
    try {
      const resolved = await resolveHostPortFromGlobalDiscovery(adapter, opts);
      targetHost = resolved.host;
      targetPort = resolved.port;
    } catch (error) {
      adapter.log?.("core.discovery.failed", {
        message: error instanceof Error ? error.message : String(error),
        fallbackHost: opts.host,
        fallbackPort: opts.port,
      });
    }
  }

  const socket = await adapter.connectTls({
    host: targetHost,
    port: targetPort,
    certPem: opts.certPem,
    keyPem: opts.keyPem,
    caPem: opts.caPem,
  });

  const localCertDer = parseFirstCertificateDer(opts.certPem);
  const localDeviceId = await adapter.sha256(localCertDer);
  const peerCertDer = await socket.peerCertificateDer();
  const remoteDeviceIdBytes = await adapter.sha256(peerCertDer);
  const remoteDeviceId = await computeDeviceId(adapter, peerCertDer);

  if (opts.expectedDeviceId) {
    const got = canonicalDeviceId(remoteDeviceId);
    const want = canonicalDeviceId(opts.expectedDeviceId);
    if (got !== want) {
      await socket.close();
      throw new Error(`Remote device ID mismatch: expected ${opts.expectedDeviceId}, got ${got}`);
    }
  }

  const helloFrame = encodeHelloFrame({
    device_name: opts.deviceName,
    client_name: opts.clientName ?? "syncpeer",
    client_version: opts.clientVersion ?? "0.1.0",
  });
  await socket.write(helloFrame);
  const { hello, leftover } = await readRemoteHello(socket);
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
  await session.waitForReady();
  return {
    remoteFs: session.buildRemoteFs(remoteDeviceInfo),
    close: () => session.close(),
  };
}

export interface SyncpeerCoreClient {
  openSession: (options: SyncpeerConnectOptions) => Promise<SyncpeerSessionHandle>;
}

export function createSyncpeerCoreClient(adapter: SyncpeerHostAdapter): SyncpeerCoreClient {
  return {
    openSession: (options: SyncpeerConnectOptions) => withTimeout(openSession(adapter, options), options.timeoutMs),
  };
}
