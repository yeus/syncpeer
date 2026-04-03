import {
  encodeHelloFrame,
  encodeMessageFrame,
  FrameParser,
  MessageTypeValues,
  Hello,
  ClusterConfig,
  Index,
  IndexUpdate,
  FileInfo,
  Request,
  Response,
} from "./core/protocol/bep.ts";
import { RemoteFs, type FileUploadOptions } from "./core/model/remoteFs.ts";
import type { AdvertisedDeviceInfo, RemoteDeviceInfo } from "./core/model/remoteFs.ts";
import {
  decryptEncryptedFilename,
  encryptUntrustedBlockHash,
  encryptUntrustedBytes,
  encryptUntrustedFilename,
  decryptUntrustedBytes,
  deriveUntrustedFileKey,
  deriveUntrustedFolderCrypto,
  verifyUntrustedPasswordToken,
  type UntrustedFolderCrypto,
} from "./core/model/untrusted.ts";

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
  folderPasswords?: Record<string, string>;
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
  isClosed: () => boolean;
  close: () => Promise<void>;
}

interface FolderState {
  id: string;
  label: string;
  readOnly: boolean;
  advertisedDevices: AdvertisedDeviceInfo[];
  encrypted: boolean;
  needsPassword: boolean;
  passwordError?: string;
  folderCrypto?: UntrustedFolderCrypto;
  localDevicePresentInFolder: boolean;
  stopReason: number;
  indexReceived: boolean;
  remoteIndexId?: string;
  remoteMaxSequence?: string;
  files: Map<string, { indexFile: any; request?: { encryptedName: string; fileKey: Uint8Array; encryptedBlocks: any[] } }>;
}

interface UploadedBlock {
  offset: number;
  size: number;
  hash: Uint8Array;
  encryptedData?: Uint8Array;
}

interface UploadedFileRecord {
  path: string;
  bytes: Uint8Array;
  blocks: UploadedBlock[];
  modifiedMs: number;
  sequence: number;
  encryptedName?: string;
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

function encodeDeviceId(raw: Uint8Array): string {
  return base32NoPadding(raw);
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

function normalizePathValue(input: string): string {
  return String(input ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
}

function padBytesWithRandom(
  input: Uint8Array,
  targetLength: number,
  randomBytes: Uint8Array,
): Uint8Array {
  if (input.length >= targetLength) return input;
  const padded = new Uint8Array(targetLength);
  padded.set(input, 0);
  padded.set(randomBytes.slice(0, targetLength - input.length), input.length);
  return padded;
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
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

function isTimeoutLikeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("i/o timeout")
  );
}

function isRemoteApprovalLikelyError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unknown device") ||
    normalized.includes("not configured") ||
    normalized.includes("not in config") ||
    normalized.includes("certificate unknown") ||
    normalized.includes("access denied") ||
    normalized.includes("not authorized")
  );
}

function isImmediateRemoteCloseLikeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("connection closed") ||
    normalized.includes("socket hang up") ||
    normalized.includes("eof")
  );
}

function maybeConnectionHint(
  opts: SyncpeerConnectOptions,
  errors: string[],
): string {
  if (!opts.expectedDeviceId || errors.length === 0) return "";
  const hasApprovalSignal = errors.some((entry) =>
    isRemoteApprovalLikelyError(entry),
  );
  if (hasApprovalSignal) {
    return "Remote peer rejected this device. On the remote Syncthing instance, add/accept this device, then retry.";
  }
  const allTimeoutLike = errors.every((entry) => isTimeoutLikeError(entry));
  if (allTimeoutLike) {
    return "All connection attempts timed out. If the remote peer is online but this is a new pairing, it may be waiting for you to accept this device on the remote Syncthing instance.";
  }
  const immediateCloseCount = errors.filter((entry) =>
    isImmediateRemoteCloseLikeError(entry),
  ).length;
  if (immediateCloseCount >= 2) {
    return "Connection was closed by the remote peer before sync started. If this is a first-time pairing, the remote Syncthing device is likely waiting for approval of this client. Accept the new device there, then retry.";
  }
  return "";
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
  private localIndexIdsByFolder = new Map<string, string>();
  private localSequencesByFolder = new Map<string, number>();
  private uploadedFilesByFolder = new Map<string, Map<string, UploadedFileRecord>>();
  private readonly folderPasswords: Map<string, string>;
  private readonly localVersionCounterId: string;
  private socket: SyncpeerTlsSocket;
  private adapter: SyncpeerHostAdapter;
  private localDeviceId: Uint8Array;
  private localDeviceName: string;
  private remoteDeviceId?: Uint8Array;

  constructor(
    socket: SyncpeerTlsSocket,
    adapter: SyncpeerHostAdapter,
    localDeviceId: Uint8Array,
    localDeviceName: string,
    folderPasswords?: Record<string, string>,
    remoteDeviceId?: Uint8Array,
  ) {
    this.socket = socket;
    this.adapter = adapter;
    this.localDeviceId = localDeviceId;
    this.localDeviceName = localDeviceName;
    this.remoteDeviceId = remoteDeviceId;
    this.parser = new FrameParser((type, msg) => this.onFrame(type, msg));
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.localIndexId = "1";
    this.localVersionCounterId = this.computeLocalVersionCounterId();
    this.folderPasswords = new Map(
      Object.entries(folderPasswords ?? {})
        .map(([folderId, password]) => [folderId.trim(), password.trim()] as const)
        .filter(([folderId, password]) => folderId !== "" && password !== ""),
    );
  }

  private computeLocalVersionCounterId(): string {
    const view = new DataView(
      this.localDeviceId.buffer,
      this.localDeviceId.byteOffset,
      Math.min(this.localDeviceId.byteLength, 8),
    );
    const high = BigInt(view.getUint32(0, false));
    const low = BigInt(view.getUint32(4, false));
    return ((high << 32n) | low).toString();
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

  private localIndexIdForFolder(folderId: string): string {
    const existing = this.localIndexIdsByFolder.get(folderId);
    if (existing) return existing;
    const mask64 = (1n << 64n) - 1n;
    let hash = 1469598103934665603n;
    const seed = `${this.localIndexId}:${folderId}`;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= BigInt(seed.charCodeAt(index));
      hash = (hash * 1099511628211n) & mask64;
    }
    if (hash === 0n) hash = 1n;
    const next = hash.toString();
    this.localIndexIdsByFolder.set(folderId, next);
    return next;
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
    if (type !== MessageTypeValues.PING) {
      this.log("frame.received", {
        type,
        isClusterConfig: type === MessageTypeValues.CLUSTER_CONFIG,
        isIndex: type === MessageTypeValues.INDEX,
        isIndexUpdate: type === MessageTypeValues.INDEX_UPDATE,
        isRequest: type === MessageTypeValues.REQUEST,
        isResponse: type === MessageTypeValues.RESPONSE,
      });
    }
    switch (type) {
      case MessageTypeValues.CLUSTER_CONFIG:
        void this.handleClusterConfig(msg);
        break;
      case MessageTypeValues.INDEX:
      case MessageTypeValues.INDEX_UPDATE:
        void this.handleIndex(msg);
        break;
      case MessageTypeValues.RESPONSE:
        this.handleResponse(msg);
        break;
      case MessageTypeValues.REQUEST:
        void this.handleRequest(msg);
        break;
      case MessageTypeValues.CLOSE: {
        const reason =
          typeof msg?.reason === "string" && msg.reason.trim() !== ""
            ? msg.reason.trim()
            : "Remote sent CLOSE";
        this.log("frame.close", { reason });
        this.onSocketClosed(new Error(`BEP close from remote: ${reason}`));
        break;
      }
      default:
        break;
    }
  }

  private async handleClusterConfig(cfg: any): Promise<void> {
    for (const folder of cfg.folders || []) {
      const folderDevices = Array.isArray(folder.devices) ? folder.devices : [];
      const advertisedDevices: AdvertisedDeviceInfo[] = folderDevices
        .filter((device: any) => device?.id instanceof Uint8Array && !bytesEqual(device.id, this.localDeviceId))
        .map((device: any) => ({
          id: encodeDeviceId(device.id),
          name:
            typeof device.name === "string" && device.name.trim() !== ""
              ? device.name.trim()
              : undefined,
        }));
      const remoteDevice = this.remoteDeviceId
        ? folderDevices.find((device: any) =>
            bytesEqual(device.id, this.remoteDeviceId!),
          )
        : folderDevices.find(
            (device: any) => !bytesEqual(device.id, this.localDeviceId),
          );
      const localDeviceEntry = folderDevices.find((device: any) =>
        device?.id instanceof Uint8Array && bytesEqual(device.id, this.localDeviceId),
      );
      const remoteIndexId =
        remoteDevice?.index_id != null ? String(remoteDevice.index_id) : "0";
      const remoteMaxSequence = String(remoteDevice?.max_sequence ?? 0);
      const folderId = String(folder.id ?? "").trim();
      const stopReason = Number(folder.stop_reason ?? 0);
      const normalizedDeviceIds = folderDevices
        .filter((device: any) => device?.id instanceof Uint8Array)
        .map((device: any) => encodeDeviceId(device.id));
      const localToken =
        localDeviceEntry?.encryption_password_token instanceof Uint8Array
          ? localDeviceEntry.encryption_password_token
          : null;
      const remoteToken =
        remoteDevice?.encryption_password_token instanceof Uint8Array
          ? remoteDevice.encryption_password_token
          : null;
      const announcedToken = localToken ?? remoteToken;
      this.log("cluster.folder.received", {
        folderId,
        folderType: Number(folder.type ?? 0),
        stopReason,
        remoteIndexId,
        remoteMaxSequence,
        deviceCount: folderDevices.length,
        localDevicePresentInFolder: !!localDeviceEntry,
        remoteDevicePresentInFolder: !!remoteDevice,
        folderDeviceIds: normalizedDeviceIds,
        advertisedDeviceIds: advertisedDevices.map((device) => device.id),
        localTokenLengthFromPeer: localToken?.length ?? 0,
        remoteTokenLengthFromPeer: remoteToken?.length ?? 0,
      });
      const encrypted =
        Number(folder.type ?? 0) === 3 ||
        (announcedToken?.length ?? 0) > 0;
      let folderCrypto: UntrustedFolderCrypto | undefined;
      let needsPassword = false;
      let passwordError: string | undefined;
      if (encrypted) {
        const password = this.folderPasswords.get(folderId);
        if (!password) {
          needsPassword = true;
        } else {
          try {
            const derived = await deriveUntrustedFolderCrypto(folderId, password);
            const tokenValid = await verifyUntrustedPasswordToken(
              derived,
              announcedToken,
            );
            this.log("untrusted.folder.token_check", {
              folderId,
              hasPassword: true,
              localTokenLengthFromPeer: localToken?.length ?? 0,
              remoteTokenLengthFromPeer: remoteToken?.length ?? 0,
              localTokenLength: derived.passwordToken.length,
              tokenValid,
            });
            if (!tokenValid) {
              needsPassword = true;
              passwordError = `Encryption password did not match folder ${folderId}.`;
            } else {
              folderCrypto = derived;
            }
          } catch (error) {
            needsPassword = true;
            passwordError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      const previousState = this.folders.get(folderId);
      const preserveIndexState =
        previousState &&
        previousState.remoteIndexId === remoteIndexId &&
        previousState.remoteMaxSequence === remoteMaxSequence;
      const state: FolderState = {
        id: folderId,
        label: folder.label || folderId,
        readOnly: !!folder.read_only || Number(folder.type ?? 0) === 2,
        advertisedDevices,
        encrypted,
        needsPassword,
        passwordError,
        folderCrypto,
        localDevicePresentInFolder: !!localDeviceEntry,
        stopReason,
        indexReceived: preserveIndexState
          ? previousState.indexReceived
          : false,
        remoteIndexId,
        remoteMaxSequence,
        files: preserveIndexState
          ? previousState.files
          : new Map(),
      };
      this.folders.set(folderId, state);
      const knownSequence = Number.isFinite(Number(remoteMaxSequence))
        ? Number(remoteMaxSequence)
        : 0;
      const previousSequence = this.localSequencesByFolder.get(folderId) ?? 0;
      if (knownSequence > previousSequence) {
        this.localSequencesByFolder.set(folderId, knownSequence);
      }
      if (encrypted) {
        this.log("untrusted.folder.state", {
          folderId,
          needsPassword,
          hasFolderCrypto: !!folderCrypto,
          passwordError: passwordError ?? null,
        });
      }
    }
    if (!this.echoedClusterConfig) {
      this.echoedClusterConfig = true;
      const folders = (cfg.folders || []).map((folder: any) => {
        const folderId = String(folder.id ?? "");
        const state = this.folders.get(folderId);
        const localFolderIndexId = this.localIndexIdForFolder(folderId);
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
          index_id: localFolderIndexId,
          // Compatibility: some peers reject our cluster config if we advertise that
          // we also have encrypted-at-rest data for the same folder.
          encryption_password_token: undefined,
        });
        this.log("cluster.echo.folder.prepared", {
          folderId: String(folder.id ?? ""),
          stopReason: Number(folder.stop_reason ?? 0),
          deviceCountIn: Array.isArray(folder.devices) ? folder.devices.length : 0,
          deviceCountOut: devices.length,
          localDeviceInserted: true,
        });
        if (state?.encrypted) {
          this.log("untrusted.folder.echo_config", {
            folderId: folder.id,
            sourceType: Number(folder.type ?? 0),
            echoedType: state?.encrypted ? 3 : Number(folder.type ?? 0),
            localTokenLength: 0,
            localTokenSuppressed: true,
          });
        }
        return {
          ...folder,
          type: state?.encrypted ? 3 : folder.type,
          devices,
        };
      });
      const frame = encodeMessageFrame(
        MessageTypeValues.CLUSTER_CONFIG,
        ClusterConfig,
        { folders },
        0,
      );
      this.log("cluster.echo.send.start", {
        folderCount: folders.length,
      });
      try {
        await this.socket.write(frame);
        this.log("cluster.echo.send.done", {
          folderCount: folders.length,
          bytes: frame.length,
        });
        for (const folder of folders) {
          const folderId = String(folder?.id ?? "").trim();
          if (!folderId) continue;
          const stopReason = Number(folder?.stop_reason ?? 0);
          if (stopReason !== 0) {
            this.log("index.bootstrap.skipped", {
              folderId,
              stopReason,
              reason: "folder_stopped_by_peer",
            });
            continue;
          }
          const indexFrame = encodeMessageFrame(
            MessageTypeValues.INDEX,
            Index,
            { folder: folderId, files: [], last_sequence: 0 },
            0,
          );
          await this.socket.write(indexFrame);
          this.log("index.bootstrap.sent", {
            folderId,
            bytes: indexFrame.length,
          });
        }
      } catch (error) {
        this.log("cluster.echo.send.failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.readyState === "pending") {
      this.readyState = "ready";
      this.readyResolve();
    }
  }

  private async handleIndex(index: any): Promise<void> {
    const folderId = index.folder;
    const state = this.folders.get(folderId);
    if (!state) return;
    const files = Array.isArray(index.files) ? index.files : [];
    this.log("index.received", {
      folderId,
      fileCount: files.length,
      encrypted: state.encrypted,
      hasFolderCrypto: !!state.folderCrypto,
      needsPassword: state.needsPassword,
    });
    state.indexReceived = true;
    let decryptedStored = 0;
    let decryptFailed = 0;
    for (const file of files) {
      if (!state.encrypted) {
        state.files.set(file.name, { indexFile: file });
        decryptedStored += 1;
        continue;
      }
      if (!state.folderCrypto) {
        continue;
      }
      try {
        const encryptedName = String(file.name ?? "");
        const plaintextName = await decryptEncryptedFilename(
          state.folderCrypto.folderKey,
          encryptedName,
        );
        const fileKey = deriveUntrustedFileKey(
          state.folderCrypto.folderKey,
          plaintextName,
        );
        const encryptedMetadata =
          file.encrypted instanceof Uint8Array
            ? file.encrypted
            : new Uint8Array(file.encrypted ?? []);
        const originalFile =
          encryptedMetadata.length > 0
            ? FileInfo.decode(decryptUntrustedBytes(fileKey, encryptedMetadata))
            : file;
        const encryptedBlocks = Array.isArray(file.blocks ?? file.Blocks)
          ? (file.blocks ?? file.Blocks).map((block: any) => ({
              offset: Number(block.offset ?? 0),
              size: Number(block.size ?? 0),
              hash: block.hash instanceof Uint8Array ? block.hash : new Uint8Array(block.hash ?? []),
            }))
          : [];
        state.files.set(plaintextName, {
          indexFile: originalFile,
          request: {
            encryptedName,
            fileKey,
            encryptedBlocks,
          },
        });
        decryptedStored += 1;
      } catch (error) {
        decryptFailed += 1;
        this.log("untrusted.index.decrypt_failed", {
          folderId,
          encryptedName: String(file?.name ?? ""),
          message: error instanceof Error ? error.message : String(error),
        });
        state.passwordError =
          error instanceof Error ? error.message : String(error);
        state.needsPassword = true;
      }
    }
    this.log("index.applied", {
      folderId,
      encrypted: state.encrypted,
      storedFiles: state.files.size,
      processedFiles: files.length,
      decryptedStored,
      decryptFailed,
      needsPassword: state.needsPassword,
      passwordError: state.passwordError ?? null,
    });
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

  private getUploadedFile(folderId: string, path: string): UploadedFileRecord | null {
    const folder = this.uploadedFilesByFolder.get(folderId);
    if (!folder) return null;
    const normalizedPath = normalizePathValue(path);
    return folder.get(normalizedPath) ?? null;
  }

  private storeUploadedFile(folderId: string, record: UploadedFileRecord): void {
    const normalizedPath = normalizePathValue(record.path);
    if (!this.uploadedFilesByFolder.has(folderId)) {
      this.uploadedFilesByFolder.set(folderId, new Map());
    }
    const storedRecord: UploadedFileRecord = {
      ...record,
      path: normalizedPath,
      bytes: new Uint8Array(record.bytes),
      blocks: record.blocks.map((block) => ({
        offset: block.offset,
        size: block.size,
        hash: new Uint8Array(block.hash),
        encryptedData: block.encryptedData
          ? new Uint8Array(block.encryptedData)
          : undefined,
      })),
    };
    this.uploadedFilesByFolder.get(folderId)?.set(normalizedPath, storedRecord);
    if (record.encryptedName) {
      const encryptedName = normalizePathValue(record.encryptedName);
      if (encryptedName) {
        this.uploadedFilesByFolder.get(folderId)?.set(encryptedName, storedRecord);
      }
    }
  }

  private nextFolderSequence(folderId: string): number {
    const current = this.localSequencesByFolder.get(folderId) ?? 0;
    const next = current + 1;
    this.localSequencesByFolder.set(folderId, next);
    return next;
  }

  private async handleRequest(req: any): Promise<void> {
    const id = Number(req?.id ?? 0);
    const folderId = String(req?.folder ?? "").trim();
    const path = String(req?.name ?? "");
    const offset = Math.max(0, Number(req?.offset ?? 0));
    const size = Math.max(0, Number(req?.size ?? 0));
    const record = this.getUploadedFile(folderId, path);
    let code = 0;
    let data = new Uint8Array(0);
    try {
      if (!record) {
        code = 2;
      } else if (
        record.encryptedName &&
        normalizePathValue(path) === normalizePathValue(record.encryptedName)
      ) {
        if (offset < 0 || size < 0) {
          code = 2;
        } else {
          const chunks: Uint8Array[] = [];
          let remaining = size;
          let cursor = offset;
          for (const block of record.blocks) {
            const encryptedData = block.encryptedData;
            if (!encryptedData) continue;
            const blockStart = block.offset;
            const blockEnd = block.offset + block.size;
            if (cursor >= blockEnd) continue;
            if (cursor < blockStart && chunks.length === 0) {
              // Requested an offset that is between known block boundaries.
              code = 2;
              break;
            }
            const startInBlock = Math.max(0, cursor - blockStart);
            const available = block.size - startInBlock;
            if (available <= 0) continue;
            const sliceSize = Math.min(remaining, available);
            chunks.push(encryptedData.slice(startInBlock, startInBlock + sliceSize));
            cursor += sliceSize;
            remaining -= sliceSize;
            if (remaining <= 0) break;
          }
          if (code === 0) {
            if (chunks.length === 0) {
              code = 2;
            } else {
              const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
              const merged = new Uint8Array(total);
              let cursorOut = 0;
              for (const chunk of chunks) {
                merged.set(chunk, cursorOut);
                cursorOut += chunk.length;
              }
              data = merged;
            }
          }
        }
      } else if (offset > record.bytes.length) {
        code = 2;
      } else {
        const end = Math.min(record.bytes.length, offset + size);
        data = record.bytes.slice(offset, end);
      }
    } catch (error) {
      code = 1;
      this.log("upload.request.failed", {
        id,
        folderId,
        path,
        offset,
        size,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const responseFrame = encodeMessageFrame(
      MessageTypeValues.RESPONSE,
      Response,
      { id, data, code },
      0,
    );
    try {
      await this.socket.write(responseFrame);
      this.log("upload.request.responded", {
        id,
        folderId,
        path,
        offset,
        size,
        responseCode: code,
        responseBytes: data.length,
      });
    } catch (error) {
      this.log("upload.response.write_failed", {
        id,
        folderId,
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async publishFile(
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: FileUploadOptions,
  ): Promise<void> {
    const folder = this.folders.get(folderId);
    if (!folder) {
      throw new Error(`Unknown folder: ${folderId}`);
    }
    if (folder.readOnly) {
      throw new Error(`Folder ${folderId} is read-only for this client.`);
    }
    if (folder.stopReason !== 0) {
      throw new Error(`Folder ${folderId} is stopped on remote (stopReason=${folder.stopReason}).`);
    }
    const normalizedPath = normalizePathValue(path);
    if (!normalizedPath) {
      throw new Error("Upload path must not be empty.");
    }
    const blockSize = 128 * 1024;
    const uploadStartedAtMs = Date.now();
    const notifyProgress = (
      processedBytes: number,
      phase: "preparing" | "publishing",
    ) => {
      options?.onProgress?.({
        processedBytes: Math.min(bytes.length, Math.max(0, processedBytes)),
        totalBytes: bytes.length,
        elapsedMs: Math.max(1, Date.now() - uploadStartedAtMs),
        phase,
      });
    };
    const blocks: UploadedBlock[] = [];
    let encryptedName: string | undefined;
    if (!folder.encrypted) {
      for (let offset = 0; offset < bytes.length; offset += blockSize) {
        const end = Math.min(bytes.length, offset + blockSize);
        const chunk = bytes.slice(offset, end);
        const hash = await this.adapter.sha256(chunk);
        blocks.push({
          offset,
          size: chunk.length,
          hash: toUint8Array(hash),
        });
        notifyProgress(end, "preparing");
      }
    } else {
      if (!folder.folderCrypto || folder.needsPassword) {
        throw new Error(`Folder ${folderId} requires a valid encryption password before upload.`);
      }
      const fileKey = deriveUntrustedFileKey(folder.folderCrypto.folderKey, normalizedPath);
      encryptedName = await encryptUntrustedFilename(
        folder.folderCrypto.folderKey,
        normalizedPath,
      );
      let encryptedOffset = 0;
      const originalBlocks: Array<{ offset: number; size: number; hash: Uint8Array }> = [];
      const fakeBlocks: Array<{ offset: number; size: number; hash: Uint8Array }> = [];
      for (let offset = 0; offset < bytes.length; offset += blockSize) {
        const end = Math.min(bytes.length, offset + blockSize);
        const chunk = bytes.slice(offset, end);
        const hashPlain = toUint8Array(await this.adapter.sha256(chunk));
        const isLastBlock = end >= bytes.length;
        const paddedChunk =
          isLastBlock && chunk.length < 1024
            ? padBytesWithRandom(
                chunk,
                1024,
                toUint8Array(await this.adapter.randomBytes(1024 - chunk.length)),
              )
            : chunk;
        const nonce = toUint8Array(await this.adapter.randomBytes(24));
        const encryptedData = encryptUntrustedBytes(fileKey, paddedChunk, nonce);
        const encryptedHash = encryptUntrustedBlockHash(fileKey, hashPlain);
        originalBlocks.push({ offset, size: chunk.length, hash: hashPlain });
        fakeBlocks.push({
          offset: encryptedOffset,
          size: encryptedData.length,
          hash: encryptedHash,
        });
        blocks.push({
          offset: encryptedOffset,
          size: encryptedData.length,
          hash: encryptedHash,
          encryptedData,
        });
        encryptedOffset += encryptedData.length;
        notifyProgress(end, "preparing");
      }
      const modifiedMs = Math.max(0, Math.floor(options?.modifiedMs ?? Date.now()));
      const sequence = this.nextFolderSequence(folderId);
      const baseVersion = {
        counters: [{ id: this.localVersionCounterId, value: String(sequence) }],
      };
      const originalFileInfo = {
        name: normalizedPath,
        type: 0,
        size: bytes.length,
        permissions: 0o644,
        modified_s: Math.floor(modifiedMs / 1000),
        modified_ns: (modifiedMs % 1000) * 1_000_000,
        modified_by: this.localVersionCounterId,
        deleted: false,
        invalid: false,
        no_permissions: false,
        version: baseVersion,
        sequence,
        block_size: blockSize,
        blocks: originalBlocks.map((block) => ({
          offset: block.offset,
          size: block.size,
          hash: block.hash,
        })),
      };
      const encryptedMetadata = encryptUntrustedBytes(
        fileKey,
        FileInfo.encode(originalFileInfo).finish(),
        toUint8Array(await this.adapter.randomBytes(24)),
      );
      const advertisedFileInfo = {
        name: encryptedName,
        type: 0,
        size: fakeBlocks.reduce((sum, block) => sum + block.size, 0),
        permissions: 0o644,
        modified_s: 1_234_567_890,
        modified_ns: 0,
        modified_by: this.localVersionCounterId,
        deleted: false,
        invalid: false,
        no_permissions: false,
        version: baseVersion,
        sequence,
        block_size: blockSize + 40,
        blocks: fakeBlocks.map((block) => ({
          offset: block.offset,
          size: block.size,
          hash: block.hash,
        })),
        encrypted: encryptedMetadata,
      };
      folder.files.set(normalizedPath, {
        indexFile: advertisedFileInfo,
        request: {
          encryptedName,
          fileKey,
          encryptedBlocks: fakeBlocks.map((block) => ({
            offset: block.offset,
            size: block.size,
            hash: block.hash,
          })),
        },
      });
      this.storeUploadedFile(folderId, {
        path: normalizedPath,
        bytes,
        blocks,
        modifiedMs,
        sequence,
        encryptedName,
      });
      const frame = encodeMessageFrame(
        MessageTypeValues.INDEX_UPDATE,
        IndexUpdate,
        {
          folder: folderId,
          files: [advertisedFileInfo],
        },
        0,
      );
      await this.socket.write(frame);
      notifyProgress(bytes.length, "publishing");
      this.log("upload.index_update.sent", {
        folderId,
        path: normalizedPath,
        encrypted: true,
        encryptedName,
        sizeBytes: bytes.length,
        blockCount: blocks.length,
        sequence,
      });
      return;
    }
    const modifiedMs = Math.max(0, Math.floor(options?.modifiedMs ?? Date.now()));
    const sequence = this.nextFolderSequence(folderId);
    const fileInfo = {
      name: normalizedPath,
      type: 0,
      size: bytes.length,
      permissions: 0o644,
      modified_s: Math.floor(modifiedMs / 1000),
      modified_ns: (modifiedMs % 1000) * 1_000_000,
      modified_by: this.localVersionCounterId,
      deleted: false,
      invalid: false,
      no_permissions: false,
      version: {
        counters: [
          {
            id: this.localVersionCounterId,
            value: String(sequence),
          },
        ],
      },
      sequence,
      block_size: blockSize,
      blocks: blocks.map((block) => ({
        offset: block.offset,
        size: block.size,
        hash: block.hash,
      })),
    };
    folder.files.set(normalizedPath, { indexFile: fileInfo });
    this.storeUploadedFile(folderId, {
      path: normalizedPath,
      bytes,
      blocks,
      modifiedMs,
      sequence,
    });
    const frame = encodeMessageFrame(
      MessageTypeValues.INDEX_UPDATE,
      IndexUpdate,
      {
        folder: folderId,
        files: [fileInfo],
      },
      0,
    );
    await this.socket.write(frame);
    notifyProgress(bytes.length, "publishing");
    this.log("upload.index_update.sent", {
      folderId,
      path: normalizedPath,
      encrypted: false,
      sizeBytes: bytes.length,
      blockCount: blocks.length,
      sequence,
    });
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
      (folderId, path, bytes, options) =>
        this.publishFile(folderId, path, bytes, options),
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

  isClosed(): boolean {
    return this.closed;
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
  const localDeviceIdEncoded = encodeDeviceId(localDeviceId);
  const peerCertDer = await socket.peerCertificateDer();
  const remoteDeviceIdBytes = await adapter.sha256(peerCertDer);
  const remoteDeviceId = await computeDeviceId(adapter, peerCertDer);
  adapter.log?.("core.bep.handshake.peer_cert", {
    connectedHost,
    connectedPort,
    localDeviceId: localDeviceIdEncoded,
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
    opts.folderPasswords,
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
    isClosed: () => session.isClosed(),
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
  const connectDeadline = Date.now() + totalTimeout;
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
    for (const candidate of directCandidates) {
      const remainingMs = Math.max(0, connectDeadline - Date.now());
      if (remainingMs <= 0) {
        break;
      }
      const candidateTimeoutMs = Math.min(perCandidateTimeout, remainingMs);
      try {
        adapter.log?.("core.discovery.candidate.try", {
          address: candidate.address,
          host: candidate.host,
          port: candidate.port,
          perCandidateTimeout: candidateTimeoutMs,
          strategy: "sequential",
        });
        return await withTimeout(
          openDirectSession(
            adapter,
            opts,
            candidate.host!,
            candidate.port!,
          ),
          candidateTimeoutMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        adapter.log?.("core.discovery.candidate.failed", {
          address: candidate.address,
          host: candidate.host,
          port: candidate.port,
          message,
        });
        errors.push(`${candidate.address}: ${message}`);
      }
    }
  }

  if (opts.enableRelayFallback !== false) {
    for (const candidate of relayCandidates) {
      const remainingMs = Math.max(0, connectDeadline - Date.now());
      if (remainingMs <= 0) {
        break;
      }
      try {
        adapter.log?.("core.discovery.relay.try", {
          address: candidate.address,
        });
        return await withTimeout(
          openRelaySession(adapter, opts, candidate.address),
          remainingMs,
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

  const hint = maybeConnectionHint(opts, errors);
  const technical = `Could not connect using discovered candidates. ${errors.join(" | ")}`;
  throw new Error(hint ? `${hint} Technical details: ${technical}` : technical);
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
    openSession: async (options: SyncpeerConnectOptions) => {
      try {
        return await openSession(adapter, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          options.expectedDeviceId &&
          isTimeoutLikeError(message) &&
          !isRemoteApprovalLikelyError(message)
        ) {
          throw new Error(
            "Connection timed out. This does not automatically mean approval is missing. " +
              "Approval is mainly a first-pairing possibility; previously connected devices usually time out for network/path reasons. " +
              `Technical details: ${message}`,
          );
        }
        throw error;
      }
    },
  };
}
