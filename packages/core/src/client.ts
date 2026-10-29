import {
  encodeHelloFrame,
  encodeMessageFrame,
  FrameParser,
  MessageTypeValues,
  Hello,
  Close,
  ClusterConfig,
  Index,
  IndexUpdate,
  Request,
  Response,
  Ping,
  type BepBlockInfo,
  type BepClose,
  type BepClusterConfig,
  type BepFileInfo,
  type BepHello,
  type BepIndex,
  type BepRequest,
  type BepResponse,
} from "./core/protocol/bep.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { createCiphertextReplica } from "./sync/ciphertextReplica.js";
import { createCiphertextIndex, selectCiphertextPublication } from "./sync/ciphertextIndex.js";
import { memoryUploadSource, type FileUploadSource } from "./transfer/stream.js";
import { scryptPasswordKdf, type PasswordKdf } from "./core/model/passwordKdf.js";
import {
  isTransportFailure,
  RemoteFs,
  type FileDownloadProgress,
  type FileDeleteOptions,
  type FileUploadOptions,
} from "./core/model/remoteFs.js";
import type { AdvertisedDeviceInfo, RemoteDeviceInfo } from "./core/model/remoteFs.js";
import { advanceVersionVector, versionCounterId } from "./core/protocol/versionVector.js";
import { compareVersionVectors } from "./sync/folderSync.js";
import type { LocalFolderReplica } from "./sync/replicaIndex.js";
import { replicaContentSignature } from "./sync/replicaMerge.js";
import { assertReplicaPath, isInternalReplicaPath } from "./sync/replicaPaths.js";
import { decryptUntrustedFileInfo, encryptUntrustedFileInfo } from "./core/model/untrustedMetadata.js";
import {
  coalescePendingIndexFrame,
  type FolderIndexMessage,
  type PendingIndexFrame,
} from "./core/protocol/indexQueue.js";
import {
  decryptUntrustedBlockHash,
  encryptUntrustedBlock,
  encryptUntrustedFilename,
  deriveUntrustedFileKey,
  deriveUntrustedFolderCrypto,
  verifyUntrustedPasswordToken,
  type UntrustedFolderCrypto,
} from "./core/model/untrusted.js";

const throwIfConnectionAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  const error = new Error("Connection attempt was cancelled.");
  error.name = "AbortError";
  throw error;
};

export interface SyncpeerTlsConnectOptions {
  host: string;
  port: number;
  certPem: string;
  keyPem: string;
  caPem?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  alpnProtocols?: readonly string[];
}

export interface SyncpeerQuicConnectOptions extends SyncpeerTlsConnectOptions {
  alpn: "bep/1.0";
  keepaliveMs: number;
  idleTimeoutMs: number;
}

export interface SyncpeerTlsSocket {
  read: (maxBytes?: number) => Promise<Uint8Array>;
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  peerCertificateDer: () => Promise<Uint8Array>;
}

export interface SyncpeerTlsListenOptions {
  host: string;
  port: number;
  certPem: string;
  keyPem: string;
  alpnProtocols: readonly string[];
  handshakeTimeoutMs?: number;
}

export interface SyncpeerAcceptedTlsSocket {
  socket: SyncpeerTlsSocket;
  remoteAddress: string;
  remotePort: number;
  alpn: string;
  connectedVia?: string;
  transportKind?: "direct-tcp" | "relay";
  connectionScope?: ConnectionScope;
}
export interface SyncpeerTlsListener {
  port: number;
  accept: () => Promise<SyncpeerAcceptedTlsSocket>;
  close: () => Promise<void>;
}

export interface SyncpeerRelayConnectOptions {
  relayAddress: string;
  expectedDeviceId: string;
  certPem: string;
  keyPem: string;
  caPem?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  alpnProtocols?: readonly string[];
}

export interface SyncpeerRelayConnectResult {
  socket: SyncpeerTlsSocket;
  connectedVia: string;
}

export interface SyncpeerRelayListenOptions {
  signal?: AbortSignal;
  relayAddress: string;
  certPem: string;
  keyPem: string;
  alpnProtocols: readonly string[];
  handshakeTimeoutMs?: number;
}

export interface SyncpeerDiscoveryFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  certPem?: string;
  keyPem?: string;
  pinServerDeviceId?: string;
  allowInsecureTls?: boolean;
  signal?: AbortSignal;
}

export interface SyncpeerDiscoveryResponse {
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface SyncpeerHostAdapter {
  connectTls: (
    options: SyncpeerTlsConnectOptions,
  ) => Promise<SyncpeerTlsSocket>;
  listenTls?: (
    options: SyncpeerTlsListenOptions,
  ) => Promise<SyncpeerTlsListener>;
  connectQuic?: (
    options: SyncpeerQuicConnectOptions,
  ) => Promise<SyncpeerTlsSocket>;
  connectRelay?: (
    options: SyncpeerRelayConnectOptions,
  ) => Promise<SyncpeerRelayConnectResult>;
  listenRelay?: (
    options: SyncpeerRelayListenOptions,
  ) => Promise<SyncpeerTlsListener>;
  sha256: (data: Uint8Array) => Promise<Uint8Array> | Uint8Array;
  randomBytes: (length: number) => Promise<Uint8Array> | Uint8Array;
  /** Defaults to the in-process scrypt derivation; platforms may inject a worker. */
  kdf?: PasswordKdf;
  discoveryFetch: (
    input: string | URL,
    init?: SyncpeerDiscoveryFetchInit,
  ) => Promise<SyncpeerDiscoveryResponse>;
  discoverLocalCandidates?: (options: {
    expectedDeviceId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<DiscoveredCandidate[]>;
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
  discoveryMode?: "automatic" | "global" | "lan" | "direct";
  discoveryServer?: string;
  enableRelayFallback?: boolean;
  relayOnly?: boolean;
  quicOnly?: boolean;
  folderPasswords?: Record<string, string>;
  sharedFolders?: SharedFolder[];
  replicaScanIntervalMs?: number;
  requestTimeoutMs?: number;
  keepalive?: {
    pingIntervalMs?: number;
    receiveTimeoutMs?: number;
  };
}

export type SharedFolder = {
  id: string;
  label?: string;
  /** Participates in BEP but is omitted from the user-facing folder catalog. */
  internal?: boolean;
} & ({
  replica?: LocalFolderReplica;
  ciphertextReplica?: never;
  encryption:
    | { mode: "encrypted"; password: string }
    | { mode: "plaintext" };
} | {
  replica?: never;
  ciphertextReplica: ReturnType<typeof createCiphertextReplica>;
  encryption: { mode: "ciphertext"; passwordToken: Uint8Array };
});

export interface SyncpeerGlobalDiscoveryOptions {
  expectedDeviceId: string;
  discoveryServer?: string;
}

export type ConnectionScope = "lan" | "wan" | "unknown";

type DiscoverySource = "local" | "global" | "manual";

export interface DiscoveredCandidate {
  address: string;
  protocol: "tcp" | "quic" | "relay" | "unknown";
  host?: string;
  port?: number;
  deviceId?: string;
  scope?: ConnectionScope;
  source?: DiscoverySource;
}

export interface SyncpeerGlobalDiscoveryResult {
  payload: unknown;
  candidates: DiscoveredCandidate[];
}

export interface SyncpeerSessionHandle {
  /** Identity verified from the peer certificate during the TLS handshake. */
  remoteDeviceId: string;
  remoteFs: RemoteFs;
  /** Hydrate newly loaded local folder secrets without replacing an active TLS session. */
  updateFolderPasswords?: (passwords: Record<string, string>) => Promise<void>;
  connectedVia: string;
  transportKind: "direct-tcp" | "direct-quic" | "relay";
  connectionScope?: ConnectionScope;
  isClosed: () => boolean;
  close: () => Promise<void>;
  closed: Promise<SyncpeerSessionClosure>;
}

export interface SyncpeerSessionClosure {
  kind: "manual" | "transport" | "protocol";
  message: string;
}

export const withSessionTransportProgress = (
  session: SyncpeerSessionHandle,
  onProgress?: (progress: FileDownloadProgress) => void,
): ((progress: FileDownloadProgress) => void) | undefined =>
  onProgress
    ? (progress) => onProgress({
        ...progress,
        transportKind: session.transportKind,
        ...(session.connectionScope ? { connectionScope: session.connectionScope } : {}),
        connectedVia: session.connectedVia,
      })
    : undefined;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

export async function withRecoveringSession<TOptions, TResult>(
  options: TOptions | null,
  ensureSession: (options: TOptions) => Promise<SyncpeerSessionHandle>,
  focusedFolderId: string | null,
  operation: (session: SyncpeerSessionHandle) => Promise<TResult>,
  canRecover: () => boolean = () => true,
): Promise<TResult> {
  if (options === null) {
    throw new Error("No active connection. Connect first.");
  }
  let session = await ensureSession(options);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (focusedFolderId) session.remoteFs.setFocusedFolder(focusedFolderId);
    try {
      return await operation(session);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!canRecover() || !session.isClosed() || attempt === 3) throw error;
      session = await ensureSession(options);
    }
  }
  throw new Error("Session recovery exhausted unexpectedly.");
}

export class UploadOutcomeUnknownError extends Error {
  readonly name = "UploadOutcomeUnknownError";

  constructor(message = "Upload outcome is unknown after the connection closed.", options?: ErrorOptions) {
    super(message, options);
  }
}

export async function withMetadataSession<TOptions, TResult>(
  options: TOptions | null,
  ensureSession: (options: TOptions) => Promise<SyncpeerSessionHandle>,
  focusedFolderId: string | null,
  operation: (session: SyncpeerSessionHandle) => Promise<TResult>,
): Promise<TResult> {
  if (options === null) throw new Error("No active connection. Connect first.");
  let lastError: unknown;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const session = await ensureSession(options);
    if (focusedFolderId) session.remoteFs.setFocusedFolder(focusedFolderId);
    try {
      return await operation(session);
    } catch (error) {
      lastError = error;
      if (isAbortError(error) || !isTransportFailure(error) || !session.isClosed() || attempt === 2) {
        throw error;
      }
    }
  }
  throw lastError;
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
  files: Map<string, { indexFile: BepFileInfo; request?: { encryptedName: string; fileKey: Uint8Array; encryptedBlocks: BepBlockInfo[] } }>;
}

interface UploadedBlock {
  offset: number;
  size: number;
  hash: Uint8Array;
}

interface UploadedFileRecord {
  path: string;
  size: number;
  /** Advertised block layout; encrypted folders use the ciphertext layout. */
  blocks: UploadedBlock[];
  /** Plaintext block layout used to verify source reads before serving. */
  plaintextBlocks: UploadedBlock[];
  source: FileUploadSource;
  modifiedMs: number;
  sequence: number;
  encryptedName?: string;
  fileKey?: Uint8Array;
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

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function certificateDerFromPem(pem: string): Uint8Array {
  const match = pem.match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
  );
  if (!match) {
    throw new Error("Could not parse CERTIFICATE PEM block from certPem");
  }
  const body = match[1].replace(/\s+/g, "");
  return decodeBase64(body);
}

export async function deviceIdFromCertificate(
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

async function withSessionTimeout(
  opening: Promise<SyncpeerSessionHandle>,
  timeoutMs: number,
): Promise<SyncpeerSessionHandle> {
  let timedOut = false;
  const guarded = opening.then(async (session) => {
    if (!timedOut) return session;
    await session.close().catch(() => undefined);
    throw new Error("Connection attempt completed after its timeout");
  });
  try {
    return await withTimeout(guarded, timeoutMs);
  } catch (error) {
    timedOut = true;
    throw error;
  }
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

function isTransientRelayError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not found") ||
    normalized.includes("unexpected-eof") ||
    normalized.includes("close_notify") ||
    normalized.includes("broken pipe") ||
    normalized.includes("connection reset") ||
    normalized.includes("eof")
  );
}

function errorSignals(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [String(error)];
  seen.add(error);
  const value = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  const ownSignals = [value.name, value.message, value.code]
    .filter((entry): entry is string => typeof entry === "string");
  const nestedErrors = Array.isArray(value.errors) ? value.errors : [];
  return [
    ...ownSignals,
    ...errorSignals(value.cause, seen),
    ...nestedErrors.flatMap((nested) => errorSignals(nested, seen)),
  ];
}

function isTransientDiscoveryError(error: unknown): boolean {
  const message = errorSignals(error).join(" ");
  const normalized = message.toLowerCase();
  return (
    isTimeoutLikeError(message) ||
    isTransientRelayError(message) ||
    normalized.includes("etimedout") ||
    normalized.includes("enetunreach") ||
    normalized.includes("ehostunreach") ||
    normalized.includes("eai_again") ||
    normalized.includes("no global discovery candidates") ||
    normalized.includes("global discovery did not find") ||
    normalized.includes("connection closed before bep hello")
  );
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfConnectionAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new Error("Connection attempt was cancelled.")); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function formatClientVersion(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") return "syncpeer/0.1.0";
  return /^syncpeer\b/i.test(raw) ? raw : `syncpeer/${raw}`;
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

export function normalizeDiscoveryServerUrl(rawUrl: string | undefined): URL {
  const raw = (rawUrl ?? "").trim();
  const defaultUrl = "https://discovery-lookup.syncthing.net/v2/?noannounce";
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
  if (/^tcp(?:4|6)?:\/\//.test(value)) {
    const parsed = new URL(value);
    if (!parsed.hostname || !parsed.port) return null;
    return {
      address: value,
      protocol: "tcp",
      host: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: Number(parsed.port),
      scope: connectionScopeForHost(parsed.hostname),
      source: "global",
    };
  }
  if (/^quic(?:4|6)?:\/\//.test(value)) {
    const parsed = new URL(value);
    if (!parsed.hostname || !parsed.port) return null;
    return {
      address: value,
      protocol: "quic",
      host: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: Number(parsed.port),
      scope: connectionScopeForHost(parsed.hostname),
      source: "global",
    };
  }
  if (value.startsWith("relay://")) {
    const parsed = new URL(value);
    return {
      address: value,
      protocol: "relay",
      host: parsed.hostname || undefined,
      port: parsed.port ? Number(parsed.port) : undefined,
      scope: "wan",
      source: "global",
    };
  }
  return { address: value, protocol: "unknown", scope: "unknown", source: "global" };
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

function connectionScopeForHost(host: string): ConnectionScope {
  const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || isPrivateIpv4(normalized)) return "lan";
  const parsed = normalized.includes(":") ? normalized : "";
  if (parsed === "::1" || parsed.startsWith("fe80:") || parsed.startsWith("fc") || parsed.startsWith("fd")) {
    return "lan";
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalized) || parsed !== "") return "wan";
  return "unknown";
}

export function candidatePreferenceScore(candidate: DiscoveredCandidate): number {
  if (candidate.protocol === "relay") return 0;
  if (candidate.protocol !== "tcp" && candidate.protocol !== "quic") return -1;
  if (!candidate.host) return -1;
  const scope = candidate.scope ?? connectionScopeForHost(candidate.host);
  if (scope === "lan") return candidate.protocol === "tcp" ? 500 : 400;
  return candidate.protocol === "tcp" ? 300 : 200;
}

export const candidateCooldownMs = (failures: number): number =>
  [5000, 10_000, 20_000, 40_000][Math.max(0, failures - 1)] ?? 60_000;

function describeCandidate(candidate: DiscoveredCandidate): string {
  return `${candidate.address} (${candidate.protocol}${candidate.host ? ` ${candidate.host}` : ""}${candidate.port ? `:${candidate.port}` : ""})`;
}

function dedupeCandidates(candidates: DiscoveredCandidate[]): DiscoveredCandidate[] {
  const seen = new Set<string>();
  const out: DiscoveredCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.protocol}:${candidate.host?.toLowerCase() ?? ""}:${candidate.port ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export const normalizeDiscoveredCandidates = (
  candidates: DiscoveredCandidate[],
): DiscoveredCandidate[] => dedupeCandidates(candidates)
  .sort((left, right) => candidatePreferenceScore(right) - candidatePreferenceScore(left));

interface CandidateHealth {
  failures: number;
  successes: number;
  shortLived: number;
  cooldownUntilMs: number;
}

interface CandidateRuntime {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const candidateKey = (candidate: DiscoveredCandidate): string =>
  `${candidate.protocol}:${candidate.host?.toLowerCase() ?? ""}:${candidate.port ?? ""}`;

const recordCandidateFailure = (
  health: Map<string, CandidateHealth>,
  candidate: DiscoveredCandidate,
  now: () => number,
): void => {
  const key = candidateKey(candidate);
  const failures = (health.get(key)?.failures ?? 0) + 1;
  const cooldownMs = candidateCooldownMs(failures);
  const previous = health.get(key);
  health.set(key, {
    failures,
    successes: previous?.successes ?? 0,
    shortLived: previous?.shortLived ?? 0,
    cooldownUntilMs: now() + cooldownMs,
  });
};

const trackCandidateSession = (
  health: Map<string, CandidateHealth>,
  candidate: DiscoveredCandidate,
  session: SyncpeerSessionHandle,
  now: () => number,
): void => {
  const key = candidateKey(candidate);
  const previous = health.get(key);
  health.set(key, {
    failures: previous?.failures ?? 0,
    successes: (previous?.successes ?? 0) + 1,
    shortLived: previous?.shortLived ?? 0,
    cooldownUntilMs: previous?.cooldownUntilMs ?? 0,
  });
  const connectedAtMs = now();
  void session.closed.then((closure) => {
    if (closure.kind === "manual") return;
    if (now() - connectedAtMs >= 30_000) {
      health.delete(key);
    } else {
      const current = health.get(key);
      if (current) health.set(key, { ...current, shortLived: current.shortLived + 1 });
      recordCandidateFailure(health, candidate, now);
    }
  });
};

export function extractDiscoveryAuth(url: URL): {
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

async function fetchGlobalDiscovery(
  adapter: SyncpeerHostAdapter,
  options: SyncpeerGlobalDiscoveryOptions,
  server: URL,
  auth: ReturnType<typeof extractDiscoveryAuth>,
  signal?: AbortSignal,
) {
  const response = await adapter.discoveryFetch(server.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    pinServerDeviceId: auth.pinServerDeviceId,
    allowInsecureTls: auth.allowInsecureTls,
    signal,
  });
  if (response.status === 404) {
    throw new Error(`Global discovery did not find device ${options.expectedDeviceId}.`);
  }
  if (!response.ok) {
    throw new Error(`Global discovery failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

function parseGlobalCandidates(payload: unknown): DiscoveredCandidate[] {
  const rawAddresses: unknown[] =
    typeof payload === "object" && payload !== null &&
    "addresses" in payload && Array.isArray(payload.addresses)
      ? payload.addresses
      : [];
  return dedupeCandidates(
    rawAddresses
      .map(parseDiscoveryCandidate)
      .filter((entry): entry is DiscoveredCandidate => entry !== null),
  );
}

async function resolveGlobalDiscoveryInternal(
  adapter: SyncpeerHostAdapter,
  options: SyncpeerGlobalDiscoveryOptions,
  signal?: AbortSignal,
): Promise<SyncpeerGlobalDiscoveryResult> {
  if (!options.expectedDeviceId) {
    throw new Error("Remote Device ID is required when discovery mode is global.");
  }
  const server = normalizeDiscoveryServerUrl(options.discoveryServer);
  const auth = extractDiscoveryAuth(server);
  server.searchParams.set("device", options.expectedDeviceId);
  const payload = await fetchGlobalDiscovery(adapter, options, server, auth, signal);
  const candidates = parseGlobalCandidates(payload);
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

type UploadPlan = {
  folder: FolderState;
  folderId: string;
  path: string;
  source: FileUploadSource;
  options?: FileUploadOptions;
  plaintextBlocks: UploadedBlock[];
  modifiedMs: number;
  sequence: number;
  baseVersion: ReturnType<typeof advanceVersionVector>;
  blockSize: number;
  startedAtMs: number;
  throwIfCancelled: () => void;
  uploadRateBps: (processedBytes: number) => number;
  notifyProgress: (processedBytes: number, phase: "preparing" | "publishing") => void;
};

type ClusterFolder = NonNullable<BepClusterConfig["folders"]>[number];
type ClusterDevice = NonNullable<ClusterFolder["devices"]>[number];
type ClusterFolderContext = {
  folderId: string;
  folderDevices: ClusterDevice[];
  advertisedDevices: AdvertisedDeviceInfo[];
  remoteDevice: ClusterDevice | undefined;
  localDeviceEntry: ClusterDevice | undefined;
  remoteIndexId: string;
  remoteMaxSequence: string;
  stopReason: number;
  normalizedDeviceIds: string[];
  localToken: Uint8Array | null;
  remoteToken: Uint8Array | null;
  announcedToken: Uint8Array | null;
  encrypted: boolean;
  folderPassword: string | undefined;
};

class BepSession {
  private parser: FrameParser;
  private pending = new Map<
    number,
    {
      resolve: (data: Uint8Array) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      onAbort?: () => void;
      cleanup?: () => void;
      meta: PendingRequestMeta;
    }
  >();
  private nextId = 1;
  private folders = new Map<string, FolderState>();
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyState: "pending" | "ready" | "closed" = "pending";
  private closeReason: Error | null = null;
  private closureResolve!: (closure: SyncpeerSessionClosure) => void;
  readonly closurePromise: Promise<SyncpeerSessionClosure>;
  private closed = false;
  private echoedClusterConfig = false;
  private localIndexId = "1";
  private localIndexIdsByFolder = new Map<string, string>();
  private localSequencesByFolder = new Map<string, number>();
  private pendingIndexByFolder = new Map<string, PendingIndexFrame>();
  private indexApplyInFlight = new Set<string>();
  private lockedEncryptedIndexes = new Map<string, Map<string, BepFileInfo>>();
  private announcedTokens = new Map<string, Uint8Array>();
  private stateTasks = new Set<Promise<void>>();
  private readonly indexTasks = new Set<Promise<void>>();
  private clusterFoldersTask: Promise<void> = Promise.resolve();
  private replicaScanTimer: ReturnType<typeof setInterval> | null = null;
  private replicaScanInFlight = false;
  private sentReplicaSequences = new Map<string, number>();
  private advertisedReplicaFiles = new Map<string, Map<string, { original: BepFileInfo; advertised: BepFileInfo }>>();
  private uploadedFilesByFolder = new Map<string, Map<string, UploadedFileRecord>>();
  private awaitingPublications = new Map<string, { expected: BepFileInfo; received: boolean }>();
  private readonly folderPasswords: Map<string, string>;
  private readonly sharedFolders = new Map<
    string,
    SharedFolder & { folderCrypto?: UntrustedFolderCrypto }
  >();
  private readonly localVersionCounterId: string;
  private activeFolderIds = new Set<string>();
  private socket: SyncpeerTlsSocket;
  private adapter: SyncpeerHostAdapter;
  private kdf: PasswordKdf;
  private localDeviceId: Uint8Array;
  private localDeviceName: string;
  private remoteDeviceId?: Uint8Array;
  private readonly pingIntervalMs: number;
  private readonly receiveTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveInFlight = false;
  private lastReadAt = Date.now();
  private lastWriteAt = Date.now();
  private writeChain = Promise.resolve();

  constructor(
    socket: SyncpeerTlsSocket,
    adapter: SyncpeerHostAdapter,
    localDeviceId: Uint8Array,
    localDeviceName: string,
    folderPasswords?: Record<string, string>,
    sharedFolders?: SharedFolder[],
    remoteDeviceId?: Uint8Array,
    keepalive?: SyncpeerConnectOptions["keepalive"],
    requestTimeoutMs?: number,
  ) {
    this.socket = socket;
    this.adapter = adapter;
    this.kdf = adapter.kdf ?? scryptPasswordKdf;
    this.localDeviceId = localDeviceId;
    this.localDeviceName = localDeviceName;
    this.remoteDeviceId = remoteDeviceId;
    this.pingIntervalMs = Math.max(1, keepalive?.pingIntervalMs ?? 90_000);
    this.receiveTimeoutMs = Math.max(
      this.pingIntervalMs,
      keepalive?.receiveTimeoutMs ?? 300_000,
    );
    this.requestTimeoutMs = Math.max(1_000, requestTimeoutMs ?? 20_000);
    this.parser = new FrameParser((type, msg) => this.onFrame(type, msg));
    this.closurePromise = new Promise<SyncpeerSessionClosure>((resolve) => {
      this.closureResolve = resolve;
    });
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.localVersionCounterId = versionCounterId(this.localDeviceId);
    this.folderPasswords = new Map(
      Object.entries(folderPasswords ?? {})
        .map(([folderId, password]) => [folderId.trim(), password] as const)
        .filter(([folderId, password]) => folderId !== "" && password.length > 0),
    );
    this.configureSharedFolders(sharedFolders);
  }

  private configureSharedFolders(sharedFolders?: SharedFolder[]) {
    for (const folder of sharedFolders ?? []) this.configureSharedFolder(folder);
  }

  private configureSharedFolder(folder: SharedFolder) {
    const id = folder.id.trim();
    if (!id) throw new Error("Shared folder ID must not be empty.");
    if (this.sharedFolders.has(id)) {
      throw new Error(`Shared folder ID must be unique: ${id}`);
    }
    const label = folder.label?.trim() || id;
    if (folder.encryption.mode === "ciphertext") {
      if (!folder.ciphertextReplica || folder.replica) throw new Error("Ciphertext sharing requires exactly one ciphertext replica.");
      const identity = createCiphertextIndex({ folderId: id, passwordToken: folder.encryption.passwordToken }).identity;
      this.sharedFolders.set(id, { id, label, internal: folder.internal === true,
        ciphertextReplica: folder.ciphertextReplica,
        encryption: { mode: "ciphertext", passwordToken: identity.passwordToken } });
      return;
    }
    if (folder.ciphertextReplica) throw new Error("Ciphertext replica requires explicit ciphertext sharing.");
    if (folder.encryption.mode === "encrypted") {
      const password = folder.encryption.password;
      if (!password) throw new Error(`Encrypted shared folder ${id} requires a password.`);
      this.folderPasswords.set(id, password);
      this.sharedFolders.set(id, {
        id,
        label,
        internal: folder.internal === true,
        encryption: { mode: "encrypted", password },
        replica: folder.replica,
      });
    } else {
      this.sharedFolders.set(id, {
        id,
        label,
        internal: folder.internal === true,
        encryption: { mode: "plaintext" },
        replica: folder.replica,
      });
    }
  }

  async initialize(leftover: Uint8Array): Promise<void> {
    // The local replica has no persisted BEP index epoch yet. Assign a fresh
    // epoch for each session so a wiped/rebuilt index is never mistaken for
    // the old one. Remote-only browsers advertise index ID zero separately.
    const random = await this.adapter.randomBytes(8);
    const raw = new DataView(random.buffer, random.byteOffset, random.byteLength).getBigUint64(0, false);
    this.localIndexId = (raw === 0n ? 1n : raw).toString();
    await this.initializeSharedFolders();
    if (leftover.length > 0) {
      this.parser.feed(leftover);
    }
    this.lastReadAt = Date.now();
    this.lastWriteAt = Date.now();
    void this.readLoop();
    this.keepaliveTimer = setInterval(
      () => void this.checkKeepalive(),
      Math.max(1, Math.floor(this.pingIntervalMs / 2)),
    );
  }

  async updateFolderPasswords(passwords: Record<string, string>): Promise<void> {
    const updated = new Map(Object.entries(passwords)
      .map(([id, password]) => [id.trim(), password] as const)
      .filter(([id, password]) => !!id && password.length > 0));
    const changed = [...new Set([...this.folderPasswords.keys(), ...updated.keys()])]
      .filter(id => this.folderPasswords.get(id) !== updated.get(id));
    if (!changed.length) return;
    this.folderPasswords.clear();
    for (const [id, password] of updated) this.folderPasswords.set(id, password);
    for (const folderId of changed) {
      const state = this.folders.get(folderId);
      if (!state?.encrypted || this.sharedFolders.has(folderId)) continue;
      state.files.clear();
      state.folderCrypto = undefined;
      state.needsPassword = true;
      state.passwordError = undefined;
      const password = updated.get(folderId);
      if (!password) continue;
      try {
        const crypto = await deriveUntrustedFolderCrypto(folderId, password, this.kdf);
        if (!await verifyUntrustedPasswordToken(crypto, this.announcedTokens.get(folderId))) {
          state.passwordError = "Encryption password does not match this folder.";
          continue;
        }
        state.folderCrypto = crypto;
        state.needsPassword = false;
        const pending = this.lockedEncryptedIndexes.get(folderId);
        if (pending) {
          const applied = await this.applyIndexFiles(state, folderId, [...pending.values()]);
          this.log("untrusted.folder.hydrated", { count: applied.decryptedStored });
        }
      } catch (error) {
        state.needsPassword = true;
        state.passwordError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async advertiseSharedFolders(): Promise<void> {
    this.echoedClusterConfig = true;
    await this.writeFrame(encodeMessageFrame(MessageTypeValues.CLUSTER_CONFIG, ClusterConfig, {
      folders: [...this.sharedFolders.keys()].map(id => this.sharedFolderConfig(id)),
    }, 0));
  }

  private async initializeSharedFolders(): Promise<void> {
    for (const [folderId, sharedFolder] of this.sharedFolders) {
      if (sharedFolder.encryption.mode === "ciphertext") {
        const snapshot = await sharedFolder.ciphertextReplica!.snapshot();
        if (snapshot.identity.folderId !== folderId || !bytesEqual(snapshot.identity.passwordToken, sharedFolder.encryption.passwordToken)) {
          throw new Error("Ciphertext replica identity does not match shared folder.");
        }
      }
      const folderCrypto = sharedFolder.encryption.mode === "encrypted"
        ? await deriveUntrustedFolderCrypto(
            folderId,
            sharedFolder.encryption.password,
            this.kdf,
          )
        : undefined;
      this.sharedFolders.set(folderId, { ...sharedFolder, folderCrypto });
      this.folders.set(folderId, {
        id: folderId,
        label: sharedFolder.label ?? folderId,
        readOnly: false,
        advertisedDevices: [],
        encrypted: !!folderCrypto || sharedFolder.encryption.mode === "ciphertext",
        needsPassword: sharedFolder.encryption.mode === "ciphertext",
        folderCrypto,
        localDevicePresentInFolder: sharedFolder.encryption.mode !== "ciphertext",
        stopReason: 0,
        indexReceived: false,
        remoteIndexId: "0",
        remoteMaxSequence: "0",
        files: new Map(),
      });
    }
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
        this.lastReadAt = Date.now();
        this.parser.feed(chunk);
      }
    } catch (error) {
      this.onSocketClosed(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private onSocketClosed(error: Error, kind: SyncpeerSessionClosure["kind"] = "transport"): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = "closed";
    this.closeReason = error;
    this.closureResolve({ kind, message: error.message });
    this.stopKeepalive();
    this.log("socket.closed", { message: error.message });
    for (const { reject, cleanup } of this.pending.values()) {
      cleanup?.();
      reject(error);
    }
    this.pending.clear();
    this.readyResolve();
    void this.socket.close().catch(() => undefined);
  }

  private async checkKeepalive(): Promise<void> {
    if (this.closed || this.keepaliveInFlight) return;
    const now = Date.now();
    if (now - this.lastReadAt > this.receiveTimeoutMs) {
      this.onSocketClosed(new Error("BEP receive timeout"));
      return;
    }
    if (now - this.lastWriteAt < this.pingIntervalMs) return;
    this.keepaliveInFlight = true;
    try {
      await this.writeFrame(
        encodeMessageFrame(
          MessageTypeValues.PING,
          Ping,
          {},
          0,
        ),
      );
      this.log("keepalive.ping.sent");
    } catch {
      // writeFrame closes the session and records the transport error.
    } finally {
      this.keepaliveInFlight = false;
    }
  }

  private writeFrame(data: Uint8Array, allowClosed = false): Promise<void> {
    const write = this.writeChain.then(async () => {
      if (this.closed && !allowClosed) {
        throw this.closeReason ?? new Error("Connection closed");
      }
      await this.socket.write(data);
      this.lastWriteAt = Date.now();
    });
    this.writeChain = write.catch(() => undefined);
    write.catch((error) => {
      this.onSocketClosed(error instanceof Error ? error : new Error(String(error)));
    });
    return write;
  }

  private stopKeepalive(): void {
    if (this.replicaScanTimer) clearInterval(this.replicaScanTimer);
    this.replicaScanTimer = null;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  startReplicaSync(intervalMs = 5000): void {
    if (![...this.sharedFolders.values()].some(folder => folder.replica || folder.ciphertextReplica)) return;
    if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new Error("Replica scan interval must be at least 100 ms.");
    this.replicaScanTimer = setInterval(() => {
      if (this.closed || this.replicaScanInFlight) return;
      this.replicaScanInFlight = true;
      this.trackStateTask((async () => {
        for (const [folderId, shared] of this.sharedFolders) {
          const state = this.folders.get(folderId);
          if (!shared.replica?.receive || shared.replica.isPaused?.() || !state?.indexReceived || state.needsPassword || this.indexApplyInFlight.has(folderId)) continue;
          await shared.replica.receive(folderId, [...state.files.values()].map(file => file.indexFile),
            (path, offset, size, hash) => this.requestReplicaRange(folderId, path, offset, size, hash));
        }
        await this.sendSharedFolderIndexes(true);
      })().catch(error => {
        if (!this.closed) this.log("replica.scan.failed", { message: error instanceof Error ? error.message : String(error) });
      }).finally(() => { this.replicaScanInFlight = false; }));
    }, intervalMs);
  }

  private logFrameReceived(type: number) {
    if (
      type === MessageTypeValues.PING ||
      type === MessageTypeValues.INDEX ||
      type === MessageTypeValues.INDEX_UPDATE
    ) return;
    this.log("frame.received", {
      type,
      isClusterConfig: type === MessageTypeValues.CLUSTER_CONFIG,
      isIndex: type === MessageTypeValues.INDEX,
      isIndexUpdate: type === MessageTypeValues.INDEX_UPDATE,
      isRequest: type === MessageTypeValues.REQUEST,
      isResponse: type === MessageTypeValues.RESPONSE,
    });
  }

  private onFrame(type: number, msg: unknown): void {
    this.logFrameReceived(type);
    switch (type) {
      case MessageTypeValues.CLUSTER_CONFIG: {
        const config = msg as BepClusterConfig;
        if (config.secondary) {
          this.handleSecondaryClusterConfig(config);
          break;
        }
        const folders = this.prepareClusterFolders(config);
        this.clusterFoldersTask = folders;
        this.trackStateTask(folders.then(() => this.finishClusterConfig(config)));
        break;
      }
      case MessageTypeValues.INDEX:
      case MessageTypeValues.INDEX_UPDATE:
        this.enqueueIndex(type, msg as BepIndex);
        break;
      case MessageTypeValues.RESPONSE:
        this.handleResponse(msg as BepResponse);
        break;
      case MessageTypeValues.REQUEST:
        void this.handleRequest(msg as BepRequest);
        break;
      case MessageTypeValues.CLOSE: {
        const close = msg as BepClose;
        const reason =
          typeof close.reason === "string" && close.reason.trim() !== ""
            ? close.reason.trim()
            : "Remote sent CLOSE";
        this.log("frame.close", { reason });
        this.onSocketClosed(new Error(`BEP close from remote: ${reason}`), "protocol");
        break;
      }
      default:
        break;
    }
  }

  private enqueueIndex(type: number, index: BepIndex): void {
    const folderId = String(index?.folder ?? "").trim();
    if (!folderId) {
      void this.handleIndex(index);
      return;
    }
      const incoming: PendingIndexFrame = {
        kind: type === MessageTypeValues.INDEX ? "index" : "update",
        index: index as FolderIndexMessage,
    };
    const pending = this.pendingIndexByFolder.get(folderId);
    this.pendingIndexByFolder.set(
      folderId,
      pending ? coalescePendingIndexFrame(pending, incoming, this.sharedFolders.get(folderId)?.ciphertextReplica ? "history" : "latest") : incoming,
    );
    if (this.indexApplyInFlight.has(folderId)) return;
    const task = this.drainIndexQueue(folderId);
    this.indexTasks.add(task);
    void task.finally(() => this.indexTasks.delete(task));
    this.trackStateTask(task);
  }

  private trackStateTask(operation: Promise<void>): void {
    const task = operation.catch(error => {
      if (!this.closed) this.onSocketClosed(error instanceof Error ? error : new Error(String(error)), "protocol");
    });
    this.stateTasks.add(task);
    void task.finally(() => this.stateTasks.delete(task));
  }

  private async drainIndexQueue(folderId: string): Promise<void> {
    await this.clusterFoldersTask;
    this.indexApplyInFlight.add(folderId);
    try {
      while (!this.closed) {
        const next = this.pendingIndexByFolder.get(folderId);
        if (!next) break;
        this.pendingIndexByFolder.delete(folderId);
        await this.handleIndex(next.index as BepIndex);
      }
    } finally {
      this.indexApplyInFlight.delete(folderId);
    }
  }

  private async requestFolderIndex(folderId: string): Promise<void> {
    const normalizedFolderId = String(folderId ?? "").trim();
    if (!normalizedFolderId) return;
    const folder = this.folders.get(normalizedFolderId);
    if (!folder) throw new Error(`Unknown folder: ${normalizedFolderId}`);
    this.activeFolderIds = new Set([normalizedFolderId]);
    // BEP has no request-index operation. Empty Index is a publication, not
    // a request, and Syncthing may reject it for a browse-only folder.
    // Our ClusterConfig already advertises a zero remote index/sequence to
    // request a full remote inventory on connection.
    this.log("index.bootstrap.skipped", { reason: "passive_remote_index" });
  }

  private sharedFolderConfig(folderId: string) {
    const sharedFolder = this.sharedFolders.get(folderId);
    if (!sharedFolder || !this.remoteDeviceId) {
      throw new Error(`Cannot advertise shared folder ${folderId} without a remote device.`);
    }
    const localFolderIndexId = this.localIndexIdForFolder(folderId);
    return {
      id: folderId,
      label: sharedFolder.label ?? folderId,
      type: sharedFolder.encryption.mode === "ciphertext" ? 3 : 0,
      read_only: false,
      devices: [
        {
          id: this.localDeviceId,
          name: this.localDeviceName,
          addresses: ["dynamic"],
          compression: 0,
          max_sequence: this.localSequencesByFolder.get(folderId) ?? 0,
          index_id: localFolderIndexId,
        },
        {
          id: this.remoteDeviceId,
          addresses: ["dynamic"],
          compression: 0,
          max_sequence: 0,
          index_id: 0,
          encryption_password_token: sharedFolder.encryption.mode === "ciphertext"
            ? sharedFolder.encryption.passwordToken : sharedFolder.folderCrypto?.passwordToken,
        },
      ],
    };
  }

  private async sendCiphertextIndex(
    folderId: string,
    folder: FolderState,
    replica: NonNullable<SharedFolder["ciphertextReplica"]>,
    changedOnly: boolean,
  ) {
    if (!folder.localDevicePresentInFolder || folder.stopReason) return;
    const snapshot = await replica.snapshot();
    if (changedOnly && this.sentReplicaSequences.get(folderId) === snapshot.sequence) return;
    const files = selectCiphertextPublication(snapshot).map(entry => entry.info);
    await this.writeFrame(encodeMessageFrame(MessageTypeValues.INDEX, Index, {
      folder: folderId, files, last_sequence: snapshot.sequence,
    }, 0));
    this.localSequencesByFolder.set(folderId, snapshot.sequence);
    this.sentReplicaSequences.set(folderId, snapshot.sequence);
  }

  private async sendReplicaIndex(
    folderId: string,
    folder: FolderState,
    replica: NonNullable<SharedFolder["replica"]> | undefined,
    changedOnly: boolean,
  ) {
    if (replica?.isPaused?.()) return;
    if (changedOnly && !replica) return;
    if (replica) this.log("shared_folder.index.scan.start");
    const files = replica ? await replica.scan() : [...folder.files.values()].map(file => file.indexFile);
    if (replica) this.log("shared_folder.index.scan.done", { fileCount: files.length });
    const advertisedFiles = folder.folderCrypto
      ? await Promise.all(files.map(async file => encryptUntrustedFileInfo(
        folder.folderCrypto!.folderKey, file, await this.adapter.randomBytes(24))))
      : files;
    if (replica?.isPaused?.()) return;
    if (replica) {
      this.localSequencesByFolder.set(folderId,
        files.reduce((max, file) => Math.max(max, Number(file.sequence ?? 0)), 0));
    }
    const sequence = this.localSequencesByFolder.get(folderId) ?? 0;
    if (changedOnly && this.sentReplicaSequences.get(folderId) === sequence) return;
    if (replica) {
      this.advertisedReplicaFiles.set(folderId, new Map(advertisedFiles.map((advertised, index) =>
        [advertised.name, { original: files[index], advertised }])));
    }
    const frame = encodeMessageFrame(
      MessageTypeValues.INDEX,
      Index,
      { folder: folderId, files: advertisedFiles, last_sequence: sequence },
      0,
    );
    await this.writeFrame(frame);
    if (replica) this.sentReplicaSequences.set(folderId, sequence);
    this.log("shared_folder.index.sent", {
      folderId,
      fileCount: advertisedFiles.length,
      sequence,
      bytes: frame.length,
    });
  }

  private async sendSharedFolderIndexes(changedOnly = false): Promise<void> {
    for (const folderId of this.sharedFolders.keys()) {
      const folder = this.folders.get(folderId);
      if (!folder) continue;
      const shared = this.sharedFolders.get(folderId);
      if (shared?.ciphertextReplica) {
        await this.sendCiphertextIndex(folderId, folder, shared.ciphertextReplica, changedOnly);
      } else {
        await this.sendReplicaIndex(folderId, folder, shared?.replica, changedOnly);
      }
    }
  }

  private clusterFolderContext(folder: ClusterFolder): ClusterFolderContext {
    const folderDevices = folder.devices ?? [];
    const advertisedDevices: AdvertisedDeviceInfo[] = folderDevices
      .filter((device) => device.id instanceof Uint8Array && !bytesEqual(device.id, this.localDeviceId))
      .map((device) => ({
        id: encodeDeviceId(device.id),
        name: typeof device.name === "string" && device.name.trim() !== "" ? device.name.trim() : undefined,
      }));
    const remoteDevice = this.remoteDeviceId
      ? folderDevices.find((device) => bytesEqual(device.id, this.remoteDeviceId!))
      : folderDevices.find((device) => device.id instanceof Uint8Array && !bytesEqual(device.id, this.localDeviceId));
    const localDeviceEntry = folderDevices.find((device) =>
      device?.id instanceof Uint8Array && bytesEqual(device.id, this.localDeviceId));
    const folderId = String(folder.id ?? "").trim();
    const localToken = localDeviceEntry?.encryption_password_token instanceof Uint8Array
      ? localDeviceEntry.encryption_password_token : null;
    const remoteToken = remoteDevice?.encryption_password_token instanceof Uint8Array
      ? remoteDevice.encryption_password_token : null;
    return {
      folderId,
      folderDevices,
      advertisedDevices,
      remoteDevice,
      localDeviceEntry,
      remoteIndexId: remoteDevice?.index_id != null ? String(remoteDevice.index_id) : "0",
      remoteMaxSequence: String(remoteDevice?.max_sequence ?? 0),
      stopReason: Number(folder.stop_reason ?? 0),
      normalizedDeviceIds: folderDevices.filter((device) => device.id instanceof Uint8Array)
        .map((device) => encodeDeviceId(device.id)),
      localToken,
      remoteToken,
      announcedToken: localToken ?? remoteToken,
      encrypted: Number(folder.type ?? 0) === 3 || ((localToken ?? remoteToken)?.length ?? 0) > 0,
      folderPassword: this.folderPasswords.get(folderId),
    };
  }

  private acceptSharedClusterFolder(folder: ClusterFolder, ctx: ClusterFolderContext, shared: SharedFolder) {
    if (shared.encryption.mode === "ciphertext") {
      const offered = [ctx.localToken, ctx.remoteToken].filter((token): token is Uint8Array => !!token?.length);
      const expected = shared.encryption.passwordToken;
      if (!offered.length || offered.some(token => !bytesEqual(token, expected))) {
        throw new Error("Remote encrypted folder identity mismatch.");
      }
    }
    const state = this.folders.get(ctx.folderId);
    if (state) {
      state.advertisedDevices = ctx.advertisedDevices;
      state.localDevicePresentInFolder = !!ctx.localDeviceEntry;
      state.remoteIndexId = ctx.remoteIndexId;
      state.remoteMaxSequence = ctx.remoteMaxSequence;
      state.stopReason = ctx.stopReason;
    }
    this.log("shared_folder.acceptance.received", {
      folderId: ctx.folderId,
      folderType: Number(folder.type ?? 0),
      localDevicePresentInFolder: !!ctx.localDeviceEntry,
      encrypted: shared.encryption.mode === "encrypted",
    });
  }

  private async resolveClusterFolderCrypto(ctx: ClusterFolderContext) {
    if (!ctx.encrypted) return { folderCrypto: undefined, needsPassword: false, passwordError: undefined };
    if (!ctx.folderPassword) return { folderCrypto: undefined, needsPassword: true, passwordError: undefined };
    try {
      const derived = await deriveUntrustedFolderCrypto(ctx.folderId, ctx.folderPassword, this.kdf);
      const tokenValid = await verifyUntrustedPasswordToken(derived, ctx.announcedToken);
      this.log("untrusted.folder.token_check", {
        folderId: ctx.folderId,
        hasPassword: true,
        localTokenLengthFromPeer: ctx.localToken?.length ?? 0,
        remoteTokenLengthFromPeer: ctx.remoteToken?.length ?? 0,
        localTokenLength: derived.passwordToken.length,
        tokenValid,
      });
      if (!tokenValid) {
        return { folderCrypto: undefined, needsPassword: true,
          passwordError: `Encryption password did not match folder ${ctx.folderId}.` };
      }
      return { folderCrypto: derived, needsPassword: false, passwordError: undefined };
    } catch (error) {
      return { folderCrypto: undefined, needsPassword: true,
        passwordError: error instanceof Error ? error.message : String(error) };
    }
  }

  private applyClusterFolderState(
    folder: ClusterFolder,
    ctx: ClusterFolderContext,
    crypto: Awaited<ReturnType<BepSession["resolveClusterFolderCrypto"]>>,
  ) {
    const previousState = this.folders.get(ctx.folderId);
    const preserveIndexState = previousState &&
      previousState.remoteIndexId === ctx.remoteIndexId &&
      previousState.remoteMaxSequence === ctx.remoteMaxSequence;
    if (ctx.announcedToken?.length) this.announcedTokens.set(ctx.folderId, ctx.announcedToken.slice());
    const state: FolderState = {
      id: ctx.folderId,
      label: folder.label || ctx.folderId,
      readOnly: !!folder.read_only || Number(folder.type ?? 0) === 2,
      advertisedDevices: ctx.advertisedDevices,
      encrypted: ctx.encrypted,
      needsPassword: crypto.needsPassword,
      passwordError: crypto.passwordError,
      folderCrypto: crypto.folderCrypto,
      localDevicePresentInFolder: !!ctx.localDeviceEntry,
      stopReason: ctx.stopReason,
      indexReceived: preserveIndexState ? previousState.indexReceived : false,
      remoteIndexId: ctx.remoteIndexId,
      remoteMaxSequence: ctx.remoteMaxSequence,
      files: preserveIndexState ? previousState.files : new Map(),
    };
    this.folders.set(ctx.folderId, state);
    if (ctx.encrypted) {
      this.log("untrusted.folder.state", {
        folderId: ctx.folderId,
        hasFolderPassword: !!ctx.folderPassword,
        needsPassword: crypto.needsPassword,
        hasFolderCrypto: !!crypto.folderCrypto,
        passwordError: crypto.passwordError ?? null,
      });
    }
  }

  private async handleClusterFolder(folder: ClusterFolder) {
    const ctx = this.clusterFolderContext(folder);
    const shared = this.sharedFolders.get(ctx.folderId);
    if (shared) {
      this.acceptSharedClusterFolder(folder, ctx, shared);
      return;
    }
    this.log("cluster.folder.received", {
      folderId: ctx.folderId,
      folderType: Number(folder.type ?? 0),
      stopReason: ctx.stopReason,
      remoteIndexId: ctx.remoteIndexId,
      remoteMaxSequence: ctx.remoteMaxSequence,
      deviceCount: ctx.folderDevices.length,
      localDevicePresentInFolder: !!ctx.localDeviceEntry,
      remoteDevicePresentInFolder: !!ctx.remoteDevice,
      folderDeviceIds: ctx.normalizedDeviceIds,
      advertisedDeviceIds: ctx.advertisedDevices.map((device) => device.id),
      localTokenLengthFromPeer: ctx.localToken?.length ?? 0,
      remoteTokenLengthFromPeer: ctx.remoteToken?.length ?? 0,
    });
    const crypto = await this.resolveClusterFolderCrypto(ctx);
    this.applyClusterFolderState(folder, ctx, crypto);
  }

  private echoFolderDevices(folder: ClusterFolder, localFolderIndexId: string) {
    const baseDevices = folder.devices ? [...folder.devices] : [];
    const devices = baseDevices
      .filter((device) => device.id instanceof Uint8Array && !bytesEqual(device.id, this.localDeviceId))
      .map((device) => {
        const next = { ...device };
        if (this.remoteDeviceId && bytesEqual(device.id, this.remoteDeviceId)) {
          next.max_sequence = 0;
          next.index_id = 0;
        }
        return next;
      });
    const incomingLocalDevice = baseDevices.find((device) => bytesEqual(device.id, this.localDeviceId));
    const incomingLocalToken =
      incomingLocalDevice?.encryption_password_token instanceof Uint8Array &&
      incomingLocalDevice.encryption_password_token.length > 0
        ? incomingLocalDevice.encryption_password_token : undefined;
    devices.push({
      id: this.localDeviceId,
      name: this.localDeviceName,
      addresses: ["dynamic"],
      compression: 0,
      max_sequence: 0,
      index_id: localFolderIndexId,
      encryption_password_token: incomingLocalToken,
    });
    return devices;
  }

  private echoClusterFolder(folder: ClusterFolder) {
    const folderId = String(folder.id ?? "");
    if (this.sharedFolders.has(folderId)) return this.sharedFolderConfig(folderId);
    const state = this.folders.get(folderId);
    const localFolderIndexId = "0";
    const devices = this.echoFolderDevices(folder, localFolderIndexId);
    const sourceType = Number(folder.type ?? 0);
    const echoedType = state?.encrypted ? 3 : sourceType;
    this.log("cluster.echo.folder.prepared", {
      folderId,
      stopReason: Number(folder.stop_reason ?? 0),
      deviceCountIn: folder.devices?.length ?? 0,
      deviceCountOut: devices.length,
      localDeviceInserted: true,
    });
    if (state?.encrypted) {
      this.log("untrusted.folder.echo_config", {
        folderId: folder.id,
        sourceType,
        echoedType,
        localTokenLength: devices.at(-1)?.encryption_password_token?.length ?? 0,
        localTokenIncluded: !!devices.at(-1)?.encryption_password_token,
      });
    }
    return { ...folder, type: echoedType, devices };
  }

  private async echoClusterConfig(cfg: BepClusterConfig) {
    this.echoedClusterConfig = true;
    const folders = (cfg.folders ?? []).map((folder) => this.echoClusterFolder(folder));
    const incomingFolderIds = new Set((cfg.folders ?? []).map((folder) => String(folder.id ?? "")));
    for (const folderId of this.sharedFolders.keys()) {
      if (!incomingFolderIds.has(folderId)) folders.push(this.sharedFolderConfig(folderId));
    }
    const frame = encodeMessageFrame(MessageTypeValues.CLUSTER_CONFIG, ClusterConfig, { folders }, 0);
    this.log("cluster.echo.send.start", { folderCount: folders.length });
    try {
      await this.writeFrame(frame);
      this.log("cluster.echo.send.done", { folderCount: folders.length, bytes: frame.length });
      this.log("index.bootstrap.deferred", { reason: "lazy_on_folder_open", folderCount: folders.length });
    } catch (error) {
      this.log("cluster.echo.send.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleSecondaryClusterConfig(cfg: BepClusterConfig) {
    this.log("cluster.secondary.received", { folderCount: cfg.folders?.length ?? 0 });
  }

  private async prepareClusterFolders(cfg: BepClusterConfig) {
    for (const folder of cfg.folders ?? []) await this.handleClusterFolder(folder);
  }

  private async finishClusterConfig(cfg: BepClusterConfig) {
    if (!this.echoedClusterConfig) await this.echoClusterConfig(cfg);
    await this.sendSharedFolderIndexes();
    // Inbound index tasks remain tracked independently. Replica receive may wait
    // on remote block I/O and must not hold the BEP handshake in Connecting.
    if (this.readyState === "pending") {
      this.readyState = "ready";
      this.readyResolve();
    }
  }

  private async handleCiphertextIndex(
    folderId: string,
    state: FolderState,
    files: BepFileInfo[],
    shared: SharedFolder & { ciphertextReplica: NonNullable<SharedFolder["ciphertextReplica"]> },
  ) {
    if (!state.localDevicePresentInFolder || state.stopReason) {
      throw new Error("Encrypted folder is not shared by the remote peer.");
    }
    for (const file of files) {
      await shared.ciphertextReplica.receive(
        { folderId, passwordToken: shared.encryption.passwordToken },
        file,
        (offset, size, hash, signal) =>
          this.requestBlock(folderId, file.name, offset, size, { hash, signal }),
      );
    }
    state.indexReceived = true;
    await this.sendSharedFolderIndexes(true);
  }

  private applyPlainIndexFile(state: FolderState, folderId: string, file: BepFileInfo) {
    state.files.set(file.name, { indexFile: file });
    this.acknowledgePublication(folderId, file.name, file);
  }

  private async applyEncryptedIndexFile(state: FolderState, folderId: string, file: BepFileInfo) {
    if (!state.folderCrypto) return { original: undefined, failed: false };
    try {
      const encryptedName = String(file.name ?? "");
      const { fileInfo: originalFile, fileKey } = await decryptUntrustedFileInfo(state.folderCrypto.folderKey, file);
      const encryptedBlocks = (file.blocks ?? file.Blocks ?? []).map((block) => ({
        offset: Number(block.offset),
        size: Number(block.size),
        hash: block.hash,
      }));
      state.files.set(originalFile.name, {
        indexFile: originalFile,
        request: { encryptedName, fileKey, encryptedBlocks },
      });
      this.acknowledgePublication(folderId, originalFile.name, originalFile);
      return { original: originalFile, failed: false };
    } catch (error) {
      this.log("untrusted.index.decrypt_failed", {
        folderId,
        encryptedName: String(file?.name ?? ""),
        message: error instanceof Error ? error.message : String(error),
      });
      state.passwordError = error instanceof Error ? error.message : String(error);
      state.needsPassword = true;
      return { original: undefined, failed: true };
    }
  }

  private async applyIndexFiles(state: FolderState, folderId: string, files: BepFileInfo[]) {
    let decryptedStored = 0;
    let decryptFailed = 0;
    const replicaFiles: BepFileInfo[] = [];
    for (const file of files) {
      if (!state.encrypted) {
        this.applyPlainIndexFile(state, folderId, file);
        replicaFiles.push(file);
        decryptedStored += 1;
        continue;
      }
      const applied = await this.applyEncryptedIndexFile(state, folderId, file);
      if (applied.failed) decryptFailed += 1;
      if (applied.original) {
        replicaFiles.push(applied.original);
        decryptedStored += 1;
      }
    }
    return { decryptedStored, decryptFailed, replicaFiles };
  }

  private async receiveReplicaIndex(folderId: string, state: FolderState, replicaFiles: BepFileInfo[]) {
    const replica = this.sharedFolders.get(folderId)?.replica;
    this.log("replica.index.decision", {
      internal: this.sharedFolders.get(folderId)?.internal === true,
      hasReceiver: !!replica?.receive,
      paused: replica?.isPaused?.() ?? false,
      needsPassword: state.needsPassword,
      fileCount: replicaFiles.length,
    });
    if (!replica?.receive || replica.isPaused?.() || state.needsPassword) return;
    try {
      this.log("replica.index.receive.start", {
        internal: this.sharedFolders.get(folderId)?.internal === true,
        fileCount: replicaFiles.length,
      });
      const changed = await replica.receive(folderId, replicaFiles,
        (path, offset, size, hash) => this.requestReplicaRange(folderId, path, offset, size, hash));
      this.log("replica.index.receive.done", {
        internal: this.sharedFolders.get(folderId)?.internal === true,
        changed,
      });
      if (changed) await this.sendSharedFolderIndexes();
    } catch (error) {
      if (!this.closed) {
        this.log("replica.receive.failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async handleIndex(index: BepIndex): Promise<void> {
    const folderId = String(index.folder ?? "");
    const state = this.folders.get(folderId);
    if (!state) return;
    const lastSequence = Number(index.last_sequence ?? 0);
    if (Number.isFinite(lastSequence) && lastSequence > Number(state.remoteMaxSequence ?? 0)) {
      state.remoteMaxSequence = String(lastSequence);
    }
    const files = index.files ?? [];
    const shared = this.sharedFolders.get(folderId);
    if (shared?.ciphertextReplica && shared.encryption.mode === "ciphertext") {
      await this.handleCiphertextIndex(folderId, state, files, shared);
      return;
    }
    // Keep encrypted wire metadata even after unlock so replacing or correcting
    // a credential does not require another TLS connection or lose an index.
    if (state.encrypted && !shared) {
      const queued = this.lockedEncryptedIndexes.get(folderId) ?? new Map<string, BepFileInfo>();
      for (const file of files) queued.set(String(file.name ?? ""), file);
      this.lockedEncryptedIndexes.set(folderId, queued);
    }
    this.log("index.received", {
      folderId,
      fileCount: files.length,
      encrypted: state.encrypted,
      hasFolderCrypto: !!state.folderCrypto,
      needsPassword: state.needsPassword,
    });
    state.indexReceived = true;
    const applied = await this.applyIndexFiles(state, folderId, files);
    this.log("index.applied", {
      folderId,
      encrypted: state.encrypted,
      storedFiles: state.files.size,
      processedFiles: files.length,
      decryptedStored: applied.decryptedStored,
      decryptFailed: applied.decryptFailed,
      needsPassword: state.needsPassword,
      passwordError: state.passwordError ?? null,
    });
    await this.receiveReplicaIndex(folderId, state, applied.replicaFiles);
  }

  private handleResponse(resp: BepResponse): void {
    const id = Number(resp.id ?? 0);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.cleanup?.();
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
      blocks: record.blocks.map((block) => ({
        offset: block.offset,
        size: block.size,
        hash: new Uint8Array(block.hash),
      })),
      plaintextBlocks: record.plaintextBlocks.map((block) => ({
        offset: block.offset,
        size: block.size,
        hash: new Uint8Array(block.hash),
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

  private async readEncryptedReplicaRequest(folderId: string, req: BepRequest, replica: LocalFolderReplica, crypto: UntrustedFolderCrypto): Promise<Uint8Array> {
    const file = this.advertisedReplicaFiles.get(folderId)?.get(String(req.name));
    if (!file || file.original.deleted || Number(file.original.type ?? 0) !== 0) throw new Error("Encrypted replica file is not advertised.");
    const index = file.advertised.blocks?.findIndex(block =>
      Number(block.offset) === Number(req.offset) && Number(block.size) === Number(req.size)) ?? -1;
    if (index < 0) throw new Error("Encrypted replica block range is not advertised.");
    const original = file.original.blocks?.[index];
    const advertised = file.advertised.blocks?.[index];
    if (!original || !advertised) throw new Error("Encrypted replica block metadata is incomplete.");
    if (req.hash?.length) {
      const key = deriveUntrustedFileKey(crypto.folderKey, file.original.name);
      try {
        const requestedHash = decryptUntrustedBlockHash(key, req.hash, Number(original.offset));
        if (!bytesEqual(requestedHash, original.hash)) {
          throw new Error("Encrypted replica block token does not identify the advertised plaintext block.");
        }
      } finally {
        key.fill(0);
      }
    }
    const bytes = await replica.readBlock(file.original.name, Number(original.offset), original.size, original.hash);
    const key = deriveUntrustedFileKey(crypto.folderKey, file.original.name);
    try { return await encryptUntrustedBlock(key, bytes, size => this.adapter.randomBytes(size)); }
    finally { bytes.fill(0); key.fill(0); }
  }

  private async readCiphertextRequest(
    folderId: string,
    path: string,
    offset: number,
    size: number,
    req: BepRequest,
    shared: SharedFolder & { ciphertextReplica: NonNullable<SharedFolder["ciphertextReplica"]> },
  ) {
    const state = this.folders.get(folderId);
    if (!state?.localDevicePresentInFolder || state.stopReason) {
      throw new Error("Encrypted folder is not shared by the remote peer.");
    }
    if (!(req.hash instanceof Uint8Array)) throw new Error("Ciphertext block token is required.");
    return shared.ciphertextReplica.readNamedBlock(path, offset, size, req.hash);
  }

  private async readUploadRequestData(record: UploadedFileRecord, req: BepRequest, path: string, offset: number, size: number) {
    if (record.encryptedName && normalizePathValue(path) === normalizePathValue(record.encryptedName)) {
      if (offset < 0 || size < 0) return { code: 2, data: new Uint8Array(0) };
      return { code: 0, data: await this.readEncryptedUploadRange(record, offset, size) };
    }
    if (record.encryptedName) return { code: 2, data: new Uint8Array(0) };
    if (offset > record.size) return { code: 2, data: new Uint8Array(0) };
    return {
      code: 0,
      data: await this.readPlaintextUploadRange(record, offset, size,
        req.hash instanceof Uint8Array ? req.hash : undefined),
    };
  }

  private async readRequestData(req: BepRequest, record: UploadedFileRecord | null) {
    const folderId = String(req?.folder ?? "").trim();
    const path = String(req?.name ?? "");
    const offset = Math.max(0, Number(req?.offset ?? 0));
    const size = Math.max(0, Number(req?.size ?? 0));
    let code = 0;
    let data: Uint8Array = new Uint8Array(0);
    try {
      assertReplicaPath(path);
      if (isInternalReplicaPath(path)) throw new Error("Internal file requests are not allowed.");
      const shared = this.sharedFolders.get(folderId);
      const replica = shared?.replica;
      if (shared?.ciphertextReplica) {
        data = await this.readCiphertextRequest(folderId, path, offset, size, req, shared);
      } else if (!record && replica) {
        data = shared.folderCrypto
          ? await this.readEncryptedReplicaRequest(folderId, req, replica, shared.folderCrypto)
          : await replica.readBlock(path, offset, size, req.hash);
      } else if (!record) {
        code = 2;
      } else {
        ({ code, data } = await this.readUploadRequestData(record, req, path, offset, size));
      }
    } catch (error) {
      code = 1;
      this.log("upload.request.failed", {
        id: Number(req?.id ?? 0),
        folderId,
        path,
        offset,
        size,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { code, data };
  }

  private async sendRequestResponse(
    id: number,
    folderId: string,
    path: string,
    offset: number,
    size: number,
    code: number,
    data: Uint8Array,
  ) {
    const responseFrame = encodeMessageFrame(MessageTypeValues.RESPONSE, Response, { id, data, code }, 0);
    try {
      await this.writeFrame(responseFrame);
      this.log("upload.request.responded", {
        id, folderId, path, offset, size,
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

  private async handleRequest(req: BepRequest): Promise<void> {
    const id = Number(req?.id ?? 0);
    const folderId = String(req?.folder ?? "").trim();
    const path = String(req?.name ?? "");
    const offset = Math.max(0, Number(req?.offset ?? 0));
    const size = Math.max(0, Number(req?.size ?? 0));
    const record = this.getUploadedFile(folderId, path);
    const { code, data } = await this.readRequestData(req, record);
    await this.sendRequestResponse(id, folderId, path, offset, size, code, data);
  }

  /** Re-reads and verifies one plaintext block so a changed source fails closed. */
  private async readPlaintextUploadRange(record: UploadedFileRecord, offset: number, size: number,
    expectedHash?: Uint8Array): Promise<Uint8Array> {
    const length = Math.min(size, record.size - offset);
    const bytes = await record.source.read(offset, length);
    if (bytes.length !== length) throw new Error("Upload source returned an unexpected length.");
    const block = record.blocks.find(candidate => candidate.offset === offset && candidate.size === length);
    if (block && expectedHash && !bytesEqual(expectedHash, block.hash)) {
      throw new Error("Requested block does not match this upload.");
    }
    if (block && !bytesEqual(toUint8Array(await this.adapter.sha256(bytes)), block.hash)) {
      throw new Error("Upload source changed after publication.");
    }
    return bytes;
  }

  /** Re-encrypts advertised blocks from the verified plaintext source, so peers
   * receive ciphertext that decrypts to the published block hashes. Requests
   * must cover whole advertised blocks, which is what BEP peers send.
   */
  private async readEncryptedUploadRange(record: UploadedFileRecord, offset: number, size: number): Promise<Uint8Array> {
    if (!record.fileKey || record.blocks.length !== record.plaintextBlocks.length) {
      throw new Error("Uploaded encrypted file is unavailable.");
    }
    const end = offset + size;
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < record.blocks.length; index += 1) {
      const block = record.blocks[index];
      const blockEnd = block.offset + block.size;
      if (blockEnd <= offset) continue;
      if (block.offset >= end) break;
      if (block.offset < offset || blockEnd > end) {
        throw new Error("Encrypted upload requests must align with advertised blocks.");
      }
      chunks.push(await this.encryptUploadBlock(record, index));
    }
    if (chunks.length === 0) throw new Error("Encrypted upload block is unavailable.");
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      merged.set(chunk, cursor);
      cursor += chunk.length;
    }
    return merged;
  }

  private async encryptUploadBlock(record: UploadedFileRecord, index: number): Promise<Uint8Array> {
    const plaintext = record.plaintextBlocks[index];
    const bytes = await record.source.read(plaintext.offset, plaintext.size);
    try {
      if (bytes.length !== plaintext.size) throw new Error("Upload source returned an unexpected length.");
      if (!bytesEqual(toUint8Array(await this.adapter.sha256(bytes)), plaintext.hash)) {
        throw new Error("Upload source changed after publication.");
      }
      return await encryptUntrustedBlock(record.fileKey!, bytes, size => this.adapter.randomBytes(size));
    } finally { bytes.fill(0); }
  }

  async publishFile(
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: FileUploadOptions,
  ): Promise<void> {
    // Own the bytes so later caller mutations cannot change what peers receive.
    await this.publishFileFromSource(folderId, path, memoryUploadSource(new Uint8Array(bytes)), options);
  }

  /** Publishes a random-access source through a bounded path: blocks are hashed
   * one at a time, and peers are served by re-reading the source instead of
   * retaining the file in memory.
   */
  private uploadTarget(folderId: string, path: string, source: FileUploadSource) {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder: ${folderId}`);
    if (folder.readOnly) throw new Error(`Folder ${folderId} is read-only for this client.`);
    if (folder.stopReason !== 0) {
      throw new Error(`Folder ${folderId} is stopped on remote (stopReason=${folder.stopReason}).`);
    }
    const normalizedPath = normalizePathValue(path);
    if (!normalizedPath) throw new Error("Upload path must not be empty.");
    assertReplicaPath(normalizedPath);
    if (isInternalReplicaPath(normalizedPath)) throw new Error("Internal files cannot be published.");
    if (!Number.isSafeInteger(source.size) || source.size < 0) {
      throw new Error("Upload source size must be a non-negative safe integer.");
    }
    if (folder.encrypted && (!folder.folderCrypto || folder.needsPassword)) {
      throw new Error(`Folder ${folderId} requires a valid encryption password before upload.`);
    }
    return { folder, normalizedPath };
  }

  private uploadProgress(source: FileUploadSource, options: FileUploadOptions | undefined, startedAtMs: number) {
    const throwIfCancelled = () => {
      if (!options?.signal?.aborted) return;
      const error = new Error("Upload cancelled.");
      error.name = "AbortError";
      throw error;
    };
    const uploadRateBps = (processedBytes: number) =>
      processedBytes > 0
        ? Math.floor((processedBytes * 1000) / Math.max(1, Date.now() - startedAtMs))
        : 0;
    const notifyProgress = (processedBytes: number, phase: "preparing" | "publishing") => {
      options?.onProgress?.({
        processedBytes: Math.min(source.size, Math.max(0, processedBytes)),
        totalBytes: source.size,
        elapsedMs: Math.max(1, Date.now() - startedAtMs),
        phase,
      });
    };
    return { throwIfCancelled, uploadRateBps, notifyProgress };
  }

  private async readUploadBlocks(
    source: FileUploadSource,
    blockSize: number,
    throwIfCancelled: () => void,
    digest: ReturnType<typeof sha256.create> | undefined,
    notifyProgress: (processedBytes: number, phase: "preparing" | "publishing") => void,
  ) {
    const blocks: UploadedBlock[] = [];
    for (let offset = 0; offset < source.size; offset += blockSize) {
      throwIfCancelled();
      const length = Math.min(blockSize, source.size - offset);
      const chunk = await source.read(offset, length);
      try {
        if (chunk.length !== length) throw new Error("Upload source returned an unexpected length.");
        digest?.update(chunk);
        blocks.push({ offset, size: chunk.length, hash: toUint8Array(await this.adapter.sha256(chunk)) });
      } finally {
        chunk.fill(0);
      }
      notifyProgress(offset + length, "preparing");
    }
    return blocks;
  }

  private plaintextUploadInfo(plan: UploadPlan) {
    return {
      name: plan.path,
      type: 0,
      size: plan.source.size,
      permissions: 0o644,
      modified_s: Math.floor(plan.modifiedMs / 1000),
      modified_ns: (plan.modifiedMs % 1000) * 1_000_000,
      modified_by: this.localVersionCounterId,
      deleted: false,
      invalid: false,
      no_permissions: false,
      version: plan.baseVersion,
      sequence: plan.sequence,
      block_size: plan.blockSize,
      blocks: plan.plaintextBlocks.map(({ offset, size, hash }) => ({ offset, size, hash })),
    };
  }

  private async encryptedUploadInfo(plan: UploadPlan) {
    const folderCrypto = plan.folder.folderCrypto!;
    const fileKey = deriveUntrustedFileKey(folderCrypto.folderKey, plan.path);
    const encryptedName = await encryptUntrustedFilename(folderCrypto.folderKey, plan.path);
    const originalFileInfo = this.plaintextUploadInfo(plan);
    const advertisedFileInfo = await encryptUntrustedFileInfo(
      folderCrypto.folderKey,
      originalFileInfo,
      toUint8Array(await this.adapter.randomBytes(24)),
    );
    const advertisedBlocks: UploadedBlock[] = (advertisedFileInfo.blocks ?? []).map(block => ({
      offset: Number(block.offset),
      size: Number(block.size),
      hash: toUint8Array(block.hash),
    }));
    return { originalFileInfo, advertisedFileInfo, advertisedBlocks, encryptedName, fileKey };
  }

  private async publishPlaintextUpload(plan: UploadPlan) {
    const fileInfo = this.plaintextUploadInfo(plan);
    plan.throwIfCancelled();
    plan.folder.files.set(plan.path, { indexFile: fileInfo });
    this.log("upload.prepared", {
      folderId: plan.folderId,
      path: plan.path,
      encrypted: false,
      sizeBytes: plan.source.size,
      blockCount: plan.plaintextBlocks.length,
      elapsedMs: Date.now() - plan.startedAtMs,
      avgRateBps: plan.uploadRateBps(plan.source.size),
    });
    this.storeUploadedFile(plan.folderId, { path: plan.path, size: plan.source.size,
      blocks: plan.plaintextBlocks, plaintextBlocks: plan.plaintextBlocks, source: plan.source,
      modifiedMs: plan.modifiedMs, sequence: plan.sequence });
    const frame = encodeMessageFrame(MessageTypeValues.INDEX_UPDATE, IndexUpdate,
      { folder: plan.folderId, files: [fileInfo] }, 0);
    await this.publishAndWait(frame, plan.folderId, plan.path, fileInfo, plan.options);
    plan.notifyProgress(plan.source.size, "publishing");
    this.log("upload.index_update.sent", {
      folderId: plan.folderId, path: plan.path, encrypted: false,
      sizeBytes: plan.source.size, blockCount: plan.plaintextBlocks.length, sequence: plan.sequence,
    });
    this.log("upload.complete", {
      folderId: plan.folderId, path: plan.path, encrypted: false,
      sizeBytes: plan.source.size, blockCount: plan.plaintextBlocks.length,
      elapsedMs: Date.now() - plan.startedAtMs,
      avgRateBps: plan.uploadRateBps(plan.source.size),
    });
  }

  private async publishEncryptedUpload(plan: UploadPlan) {
    const info = await this.encryptedUploadInfo(plan);
    plan.throwIfCancelled();
    this.log("upload.prepared", {
      folderId: plan.folderId,
      path: plan.path,
      encrypted: true,
      sizeBytes: plan.source.size,
      blockCount: plan.plaintextBlocks.length,
      elapsedMs: Date.now() - plan.startedAtMs,
      avgRateBps: plan.uploadRateBps(plan.source.size),
    });
    plan.folder.files.set(plan.path, {
      indexFile: info.originalFileInfo,
      request: {
        encryptedName: info.encryptedName,
        fileKey: info.fileKey,
        encryptedBlocks: info.advertisedBlocks.map(({ offset, size, hash }) => ({ offset, size, hash })),
      },
    });
    this.storeUploadedFile(plan.folderId, { path: plan.path, size: plan.source.size,
      blocks: info.advertisedBlocks, plaintextBlocks: plan.plaintextBlocks, source: plan.source,
      modifiedMs: plan.modifiedMs, sequence: plan.sequence,
      encryptedName: info.encryptedName, fileKey: info.fileKey });
    const frame = encodeMessageFrame(MessageTypeValues.INDEX_UPDATE, IndexUpdate,
      { folder: plan.folderId, files: [info.advertisedFileInfo] }, 0);
    await this.publishAndWait(frame, plan.folderId, plan.path, info.originalFileInfo, plan.options);
    plan.notifyProgress(plan.source.size, "publishing");
    this.log("upload.index_update.sent", {
      folderId: plan.folderId, path: plan.path, encrypted: true,
      encryptedName: info.encryptedName, sizeBytes: plan.source.size,
      blockCount: plan.plaintextBlocks.length, sequence: plan.sequence,
    });
    this.log("upload.complete", {
      folderId: plan.folderId, path: plan.path, encrypted: true,
      sizeBytes: plan.source.size, blockCount: plan.plaintextBlocks.length,
      elapsedMs: Date.now() - plan.startedAtMs,
      avgRateBps: plan.uploadRateBps(plan.source.size),
    });
  }

  async publishFileFromSource(
    folderId: string,
    path: string,
    source: FileUploadSource,
    options?: FileUploadOptions,
  ): Promise<void> {
    const { folder, normalizedPath } = this.uploadTarget(folderId, path, source);
    const startedAtMs = Date.now();
    const { throwIfCancelled, uploadRateBps, notifyProgress } =
      this.uploadProgress(source, options, startedAtMs);
    const blockSize = 128 * 1024;
    this.log("upload.start", {
      folderId, path: normalizedPath, encrypted: folder.encrypted,
      sizeBytes: source.size, blockSize, streamed: true,
    });
    const digest = options?.expectedHash ? sha256.create() : undefined;
    const plaintextBlocks = await this.readUploadBlocks(
      source, blockSize, throwIfCancelled, digest, notifyProgress,
    );
    if (digest && bytesToHex(digest.digest()) !== options!.expectedHash) {
      throw new Error("Upload source changed after publication started; retry later.");
    }
    const modifiedMs = Math.max(0, Math.floor(options?.modifiedMs ?? Date.now()));
    const sequence = this.nextFolderSequence(folderId);
    const baseVersion = advanceVersionVector(
      folder.files.get(normalizedPath)?.indexFile.version,
      this.localVersionCounterId,
    );
    const plan: UploadPlan = { folder, folderId, path: normalizedPath, source, options,
      plaintextBlocks, modifiedMs, sequence, baseVersion, blockSize, startedAtMs,
      throwIfCancelled, uploadRateBps, notifyProgress };
    if (!folder.encrypted) await this.publishPlaintextUpload(plan);
    else await this.publishEncryptedUpload(plan);
  }

  private acknowledgePublication(folderId: string, path: string, file: BepFileInfo): void {
    const pending = this.awaitingPublications.get(`${folderId}\0${path}`);
    if (!pending) return;
    const order = compareVersionVectors(file.version, pending.expected.version);
    pending.received = (order === "equal" || order === "after") && replicaContentSignature(file) === replicaContentSignature(pending.expected);
  }

  private async publishAndWait(frame: Uint8Array, folderId: string, path: string, expected: BepFileInfo, options?: FileUploadOptions): Promise<void> {
    if (!options?.waitForRemote) { await this.writeFrame(frame); return; }
    const key = `${folderId}\0${path}`;
    if (this.awaitingPublications.has(key)) throw new Error("A publication for this file is already pending.");
    const pending = { expected, received: false };
    this.awaitingPublications.set(key, pending);
    try {
      await this.writeFrame(frame);
      const deadline = Date.now() + 120000;
      while (!pending.received) {
        options.signal?.throwIfAborted();
        if (this.closed) throw new Error("Connection closed before remote upload confirmation.");
        if (Date.now() >= deadline) throw new UploadOutcomeUnknownError("Peer has not confirmed the uploaded file.");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally { this.awaitingPublications.delete(key); }
  }

  private deletionTarget(folderId: string, path: string) {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error(`Unknown folder: ${folderId}`);
    if (folder.readOnly) throw new Error(`Folder ${folderId} is read-only for this client.`);
    if (folder.stopReason !== 0) {
      throw new Error(`Folder ${folderId} is stopped on remote (stopReason=${folder.stopReason}).`);
    }
    if (folder.encrypted && (!folder.folderCrypto || folder.needsPassword)) {
      throw new Error(`Folder ${folderId} requires a valid encryption password before deletion.`);
    }
    const normalizedPath = normalizePathValue(path);
    if (!normalizedPath) throw new Error("Deletion path must not be empty.");
    assertReplicaPath(normalizedPath);
    if (isInternalReplicaPath(normalizedPath)) throw new Error("Internal files cannot be deleted remotely.");
    return { folder, normalizedPath };
  }

  private deletionFileInfo(folder: FolderState, normalizedPath: string, sequence: number, modifiedMs: number, advertisedName: string) {
    const fileInfo = {
      name: advertisedName,
      type: 0,
      size: 0,
      permissions: 0o644,
      modified_s: folder.encrypted ? 1_234_567_890 : Math.floor(modifiedMs / 1000),
      modified_ns: folder.encrypted ? 0 : (modifiedMs % 1000) * 1_000_000,
      modified_by: this.localVersionCounterId,
      deleted: true,
      invalid: false,
      no_permissions: false,
      version: advanceVersionVector(folder.files.get(normalizedPath)?.indexFile.version, this.localVersionCounterId),
      sequence,
      block_size: 128 * 1024,
      blocks: [],
    };
    const originalFileInfo = { ...fileInfo, name: normalizedPath,
      modified_s: Math.floor(modifiedMs / 1000), modified_ns: (modifiedMs % 1000) * 1000000 };
    return { fileInfo, originalFileInfo };
  }

  async publishDeletion(folderId: string, path: string, options?: FileDeleteOptions): Promise<void> {
    const { folder, normalizedPath } = this.deletionTarget(folderId, path);
    const sequence = this.nextFolderSequence(folderId);
    const modifiedMs = Math.max(0, Math.floor(options?.modifiedMs ?? Date.now()));
    let advertisedName = normalizedPath;
    if (folder.encrypted && folder.folderCrypto) {
      advertisedName = await encryptUntrustedFilename(folder.folderCrypto.folderKey, normalizedPath);
    }
    const { fileInfo, originalFileInfo } = this.deletionFileInfo(
      folder, normalizedPath, sequence, modifiedMs, advertisedName,
    );
    const advertisedFileInfo = folder.encrypted && folder.folderCrypto
      ? await encryptUntrustedFileInfo(folder.folderCrypto.folderKey, originalFileInfo,
        toUint8Array(await this.adapter.randomBytes(24)))
      : fileInfo;
    folder.files.set(normalizedPath, { indexFile: originalFileInfo });
    const uploaded = this.uploadedFilesByFolder.get(folderId);
    uploaded?.delete(normalizedPath);
    if (advertisedName !== normalizedPath) uploaded?.delete(advertisedName);
    const frame = encodeMessageFrame(
      MessageTypeValues.INDEX_UPDATE,
      IndexUpdate,
      { folder: folderId, files: [advertisedFileInfo], last_sequence: sequence, prev_sequence: sequence - 1 },
      0,
    );
    await this.publishAndWait(frame, folderId, normalizedPath, originalFileInfo, options);
    this.log("delete.index_update.sent", { folderId, path: normalizedPath, sequence });
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

  private requestReplicaRange(folderId: string, path: string, offset: number, size: number, hash?: Uint8Array): Promise<Uint8Array> {
    const folder = this.folders.get(folderId);
    if (!folder || folder.needsPassword) return Promise.reject(new Error("Replica folder metadata is unavailable."));
    if (folder.encrypted) return this.buildRemoteFs().readFileRange(folderId, path, offset, size);
    return this.requestBlock(folderId, path, offset, size, { hash });
  }

  private pendingBlockRequest(
    frame: Uint8Array,
    meta: PendingRequestMeta,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
      };
      const timer: ReturnType<typeof setTimeout> = setTimeout(
        () => this.blockRequestTimeout(meta, reject, cleanup),
        this.requestTimeoutMs,
      );
      const onAbort = () => this.blockRequestAbort(meta, reject, cleanup);
      this.pending.set(meta.id, { resolve, reject, timer, onAbort, cleanup, meta });
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.signal?.aborted) onAbort();
      this.writeFrame(frame).catch((error) => this.blockRequestWriteFailure(meta, reject, error));
    });
  }

  private blockRequestTimeout(meta: PendingRequestMeta, reject: (error: Error) => void, cleanup: () => void) {
    this.pending.delete(meta.id);
    cleanup();
    this.log("request.timeout", {
      ...meta,
      timeoutMs: this.requestTimeoutMs,
      durationMs: Date.now() - meta.startedAtMs,
    });
    reject(new Error(`Request timeout for ${meta.name} at offset ${meta.offset}`));
  }

  private blockRequestAbort(meta: PendingRequestMeta, reject: (error: Error) => void, cleanup: () => void) {
    if (!this.pending.has(meta.id)) {
      cleanup();
      return;
    }
    this.pending.delete(meta.id);
    cleanup();
    const error = new Error("Download cancelled.");
    error.name = "AbortError";
    reject(error);
  }

  private blockRequestWriteFailure(meta: PendingRequestMeta, reject: (error: Error) => void, error: unknown) {
    const entry = this.pending.get(meta.id);
    if (!entry) return;
    entry.cleanup?.();
    this.pending.delete(meta.id);
    this.log("request.write_failed", {
      ...meta,
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - meta.startedAtMs,
    });
    reject(error instanceof Error ? error : new Error(String(error)));
  }

  requestBlock(
    folder: string,
    name: string,
    offset: number,
    size: number,
    options?: {
      hash?: Uint8Array;
      blockNo?: number;
      fromTemporary?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("Connection closed"));
    if (options?.signal?.aborted) {
      const error = new Error("Download cancelled.");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    const id = this.nextId++;
    const blockHash = options?.hash ?? new Uint8Array(0);
    const blockNo = Number.isFinite(options?.blockNo) ? Number(options?.blockNo) : 0;
    const fromTemporary = options?.fromTemporary ?? true;
    const meta: PendingRequestMeta = {
      id, folder, name, offset, size, blockNo, fromTemporary,
      hashLength: blockHash.length,
      startedAtMs: Date.now(),
    };
    this.log("request.start", { ...meta });
    return this.pendingBlockRequest(
      encodeMessageFrame(
        MessageTypeValues.REQUEST,
        Request,
        { id, folder, name, offset, size, hash: blockHash, block_no: blockNo, from_temporary: fromTemporary },
        0,
      ),
      meta,
      options,
    );
  }

  buildRemoteFs(metadata?: RemoteDeviceInfo): RemoteFs {
    return new RemoteFs(
      this.folders,
      (folder, name, offset, size, options) =>
        this.requestBlock(folder, name, offset, size, options),
      (folderId) => this.requestFolderIndex(folderId),
      (folderId) => {
        const normalized = folderId ? String(folderId).trim() || null : null;
        this.activeFolderIds = normalized ? new Set([normalized]) : new Set();
      },
      (event, details) => this.log(event.replace(/^core\./, ""), details),
      metadata,
      () => {
        void this.close();
      },
      (folderId, path, bytes, options) =>
        this.publishFile(folderId, path, bytes, options),
      (bytes) => this.adapter.sha256(bytes),
      (folderId, path, options) =>
        this.publishDeletion(folderId, path, options),
      (folderId, path, source, options) =>
        this.publishFileFromSource(folderId, path, source, options),
      new Set([...this.sharedFolders].filter(([, folder]) => folder.internal).map(([id]) => id)),
    );
  }

  private rejectPendingRequests(error: Error) {
    for (const { reject, cleanup } of this.pending.values()) {
      cleanup?.();
      reject(error);
    }
    this.pending.clear();
  }

  private async sendCloseFrame() {
    let closeFrameTimedOut = false;
    let closeFrameTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.writeFrame(
          encodeMessageFrame(MessageTypeValues.CLOSE, Close, { reason: "Client closed" }, 0),
          true,
        ),
        new Promise<void>((resolve) => {
          closeFrameTimer = setTimeout(() => {
            closeFrameTimedOut = true;
            resolve();
          }, 1_000);
        }),
      ]);
    } catch (error) {
      this.log("close.frame_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (closeFrameTimer) clearTimeout(closeFrameTimer);
    }
    if (closeFrameTimedOut) this.log("close.frame_timeout");
  }

  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.stateTasks);
      return;
    }
    this.closed = true;
    this.closureResolve({ kind: "manual", message: "Session closed by request" });
    this.stopKeepalive();
    this.rejectPendingRequests(this.closeReason ?? new Error("Connection closed"));
    await this.sendCloseFrame();
    await this.socket.close();
    await Promise.allSettled(this.stateTasks);
  }

  isClosed(): boolean {
    return this.closed;
  }
}

async function readRemoteHello(
  socket: SyncpeerTlsSocket,
): Promise<{ hello: BepHello; leftover: Uint8Array }> {
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
    const hello = Hello.decode(helloBuf) as unknown as BepHello;
    return { hello, leftover };
  }
}

async function readBepPeerIdentity(
  adapter: SyncpeerHostAdapter,
  socket: SyncpeerTlsSocket,
  opts: SyncpeerConnectOptions,
  connectedHost: string,
  connectedPort: number,
  direction: "incoming" | "outgoing",
) {
  const localCertDer = certificateDerFromPem(opts.certPem);
  const localDeviceId = await adapter.sha256(localCertDer);
  const localDeviceIdEncoded = encodeDeviceId(localDeviceId);
  const peerCertDer = await socket.peerCertificateDer();
  const remoteDeviceIdBytes = await adapter.sha256(peerCertDer);
  const remoteDeviceId = await deviceIdFromCertificate(adapter, peerCertDer);
  adapter.log?.("core.bep.handshake.peer_cert", {
    direction,
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
  return { localDeviceId, remoteDeviceIdBytes, remoteDeviceId };
}

async function exchangeBepHello(
  adapter: SyncpeerHostAdapter,
  socket: SyncpeerTlsSocket,
  opts: SyncpeerConnectOptions,
  direction: "incoming" | "outgoing",
  connectedHost: string,
  connectedPort: number,
) {
  adapter.log?.("core.bep.handshake.hello_send", { direction, connectedHost, connectedPort });
  const helloFrame = encodeHelloFrame({
    device_name: opts.deviceName,
    client_name: opts.clientName ?? "syncpeer",
    client_version: formatClientVersion(opts.clientVersion),
  });
  await socket.write(helloFrame);
  adapter.log?.("core.bep.handshake.hello_sent", {
    direction, connectedHost, connectedPort, bytes: helloFrame.length,
  });
  adapter.log?.("core.bep.handshake.hello_read.start", { direction, connectedHost, connectedPort });
  const { hello, leftover } = await readRemoteHello(socket);
  adapter.log?.("core.bep.handshake.hello_recv", {
    direction,
    connectedHost,
    connectedPort,
    remoteDeviceName: String(hello.device_name ?? "unknown"),
    remoteClientName: String(hello.client_name ?? "unknown"),
    remoteClientVersion: String(hello.client_version ?? "unknown"),
    leftoverBytes: leftover.length,
  });
  return { hello, leftover };
}

async function createReadyBepSession(
  adapter: SyncpeerHostAdapter,
  socket: SyncpeerTlsSocket,
  opts: SyncpeerConnectOptions,
  localDeviceId: Uint8Array,
  remoteDeviceIdBytes: Uint8Array,
  leftover: Uint8Array,
  incoming: boolean,
) {
  const session = new BepSession(
    socket,
    adapter,
    localDeviceId,
    opts.deviceName,
    opts.folderPasswords,
    opts.sharedFolders,
    remoteDeviceIdBytes,
    opts.keepalive,
    opts.requestTimeoutMs,
  );
  await session.initialize(leftover);
  if (incoming) await session.advertiseSharedFolders();
  return session;
}

async function openBepSessionOnSocketUncancelled(
  adapter: SyncpeerHostAdapter,
  socket: SyncpeerTlsSocket,
  opts: SyncpeerConnectOptions,
  connectedHost: string,
  connectedPort: number,
  connectedVia: string,
  transportKind: "direct-tcp" | "direct-quic" | "relay",
  connectionScope: ConnectionScope,
  incoming = false,
): Promise<SyncpeerSessionHandle> {
  const direction = incoming ? "incoming" : "outgoing";
  adapter.log?.("core.bep.handshake.start", {
    direction, connectedHost, connectedPort, expectedDeviceId: opts.expectedDeviceId,
  });
  const identity = await readBepPeerIdentity(
    adapter, socket, opts, connectedHost, connectedPort, direction,
  );
  const { hello, leftover } = await exchangeBepHello(
    adapter, socket, opts, direction, connectedHost, connectedPort,
  );
  const session = await createReadyBepSession(
    adapter, socket, opts, identity.localDeviceId, identity.remoteDeviceIdBytes, leftover, incoming,
  );
  adapter.log?.("core.bep.cluster_config.wait", { direction, connectedHost, connectedPort });
  await session.waitForReady();
  session.startReplicaSync(opts.replicaScanIntervalMs);
  adapter.log?.("core.bep.handshake.ready", {
    direction, connectedHost, connectedPort, remoteDeviceId: identity.remoteDeviceId,
  });
  return bepSessionHandle(session, identity.remoteDeviceId, hello, connectedVia, transportKind, connectionScope);
}

function bepSessionHandle(
  session: BepSession,
  remoteDeviceId: string,
  hello: BepHello,
  connectedVia: string,
  transportKind: "direct-tcp" | "direct-quic" | "relay",
  connectionScope: ConnectionScope,
): SyncpeerSessionHandle {
  return {
    remoteDeviceId,
    remoteFs: session.buildRemoteFs({
      id: remoteDeviceId,
      deviceName: String(hello.device_name ?? "unknown"),
      clientName: String(hello.client_name ?? "unknown"),
      clientVersion: String(hello.client_version ?? "unknown"),
    }),
    updateFolderPasswords: passwords => session.updateFolderPasswords(passwords),
    connectedVia,
    transportKind,
    connectionScope,
    isClosed: () => session.isClosed(),
    close: () => session.close(),
    closed: session.closurePromise,
  };
}

async function openBepSessionOnSocket(
  adapter: SyncpeerHostAdapter,
  socket: SyncpeerTlsSocket,
  opts: SyncpeerConnectOptions,
  connectedHost: string,
  connectedPort: number,
  connectedVia: string,
  transportKind: "direct-tcp" | "direct-quic" | "relay",
  connectionScope: ConnectionScope,
  signal?: AbortSignal,
): Promise<SyncpeerSessionHandle> {
  throwIfConnectionAborted(signal);
  const closeOnAbort = (): void => {
    void socket.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    return await openBepSessionOnSocketUncancelled(
      adapter,
      socket,
      opts,
      connectedHost,
      connectedPort,
      connectedVia,
      transportKind,
      connectionScope,
    );
  } catch (error) {
    if (!signal?.aborted) throw error;
    const abortError = new Error("Connection attempt was cancelled.", { cause: error });
    abortError.name = "AbortError";
    throw abortError;
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
  }
}

/** Accept only an explicitly trusted certificate identity on an established socket. */
export async function acceptSyncpeerSession(
  adapter: SyncpeerHostAdapter,
  socket: SyncpeerTlsSocket,
  options: SyncpeerConnectOptions & { expectedDeviceId: string },
  transport: Pick<SyncpeerAcceptedTlsSocket, "connectedVia" | "transportKind" | "connectionScope"> = {},
): Promise<SyncpeerSessionHandle> {
  if (!options.expectedDeviceId.trim()) {
    await socket.close();
    throw new Error("Incoming peers require an approved device identity.");
  }
  const timer = setTimeout(() => void socket.close().catch(() => undefined), options.timeoutMs ?? 10000);
  try {
    return await openBepSessionOnSocketUncancelled(adapter, socket, options,
      options.host, options.port, transport.connectedVia ?? "incoming-tcp",
      transport.transportKind ?? "direct-tcp",
      transport.connectionScope ?? connectionScopeForHost(options.host), true);
  } catch (error) {
    await socket.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function openDirectTls(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  host: string,
  port: number,
  timeoutMs?: number,
  signal?: AbortSignal,
) {
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
    timeoutMs,
    signal,
  });
  adapter.log?.("core.direct.connect.tls_ready", { host, port });
  return socket;
}

async function openDirectSession(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  host: string,
  port: number,
  timeoutMs?: number,
  connectionScope = connectionScopeForHost(host),
  signal?: AbortSignal,
): Promise<SyncpeerSessionHandle> {
  const socket = await openDirectTls(adapter, opts, host, port, timeoutMs, signal);
  const session = await openBepSessionOnSocket(
    adapter,
    socket,
    opts,
    host,
    port,
    `tcp://${host}:${port}`,
    "direct-tcp",
    connectionScope,
    signal,
  );
  adapter.log?.("core.direct.connect.ready", { host, port });
  return session;
}

async function openQuicSession(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  host: string,
  port: number,
  timeoutMs?: number,
  connectionScope = connectionScopeForHost(host),
  signal?: AbortSignal,
): Promise<SyncpeerSessionHandle> {
  if (!adapter.connectQuic) throw new Error("QUIC transport is unavailable");
  const socket = await adapter.connectQuic({
    host,
    port,
    certPem: opts.certPem,
    keyPem: opts.keyPem,
    caPem: opts.caPem,
    timeoutMs,
    alpn: "bep/1.0",
    keepaliveMs: 15_000,
    idleTimeoutMs: 30_000,
    signal,
  });
  return openBepSessionOnSocket(
    adapter,
    socket,
    opts,
    host,
    port,
    `quic://${host}:${port}`,
    "direct-quic",
    connectionScope,
    signal,
  );
}

/** Some standard relays reject a fresh join before their session worker is ready.
 * Request a new invitation: its one-use join key cannot be retried. No application bytes have been sent. */
export async function connectRelayWithRetry(adapter: SyncpeerHostAdapter, options: SyncpeerRelayConnectOptions) {
  if (!adapter.connectRelay) throw new Error("Relay transport is not available in this host adapter");
  const deadline = Date.now() + (options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30000);
  for (let attempt = 0; ; attempt++) {
    throwIfConnectionAborted(options.signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Relay connection timeout budget exhausted");
    try { return await adapter.connectRelay({ ...options, timeoutMs: remaining }); }
    catch (error) {
      if (attempt >= 2 || !/Relay join failed \(2\):/.test(String(error))) throw error;
      throwIfConnectionAborted(options.signal);
      adapter.log?.("core.relay.join.retry", { attempt: attempt + 1 });
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
          reject(new Error("Connection attempt was cancelled.")); };
        const timer = setTimeout(done, Math.min(100 * 2 ** attempt, Math.max(0, deadline - Date.now())));
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}

async function openRelayTunnel(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  relayAddress: string,
  timeoutMs?: number,
  signal?: AbortSignal,
) {
  if (!adapter.connectRelay) throw new Error("Relay transport is not available in this host adapter");
  if (!opts.expectedDeviceId) throw new Error("Remote Device ID is required for relay connection");
  adapter.log?.("core.relay.connect.start", {
    relayAddress,
    expectedDeviceId: opts.expectedDeviceId,
  });
  const relay = await connectRelayWithRetry(adapter, {
    relayAddress,
    expectedDeviceId: opts.expectedDeviceId,
    certPem: opts.certPem,
    keyPem: opts.keyPem,
    caPem: opts.caPem,
    timeoutMs,
    signal,
  });
  adapter.log?.("core.relay.connect.tunnel_ready", {
    relayAddress,
    connectedVia: relay.connectedVia,
  });
  return relay;
}

async function openRelaySession(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  relayAddress: string,
  timeoutMs = opts.timeoutMs,
  signal?: AbortSignal,
): Promise<SyncpeerSessionHandle> {
  const relay = await openRelayTunnel(adapter, opts, relayAddress, timeoutMs, signal);
  const session = await openBepSessionOnSocket(
    adapter,
    relay.socket,
    opts,
    relay.connectedVia,
    0,
    relay.connectedVia,
    "relay",
    "wan",
    signal,
  );
  adapter.log?.("core.relay.connect.ready", {
    relayAddress,
    connectedVia: relay.connectedVia,
  });
  return session;
}

type DiscoveryOutcome = {
  global: PromiseSettledResult<SyncpeerGlobalDiscoveryResult>;
  local: PromiseSettledResult<DiscoveredCandidate[]>;
};

class ConnectionAttempt {
  private readonly adapter: SyncpeerHostAdapter;
  private readonly opts: SyncpeerConnectOptions;
  private readonly totalTimeout: number;
  private readonly candidateHealth: Map<string, CandidateHealth>;
  private readonly runtime: CandidateRuntime;
  private readonly signal?: AbortSignal;
  private readonly discoveryMode: NonNullable<SyncpeerConnectOptions["discoveryMode"]>;
  private readonly localDiscoveryTimeoutMs: number;
  private readonly raceController = new AbortController();
  private readonly errors: string[] = [];
  private connectDeadline = 0;
  private perCandidateTimeout = 0;
  private relayStartDelayMs = 0;
  private relayEnabled = false;
  private directCandidates: DiscoveredCandidate[] = [];
  private relayCandidates: DiscoveredCandidate[] = [];
  private winningSession: SyncpeerSessionHandle | null = null;

  constructor(
    adapter: SyncpeerHostAdapter,
    opts: SyncpeerConnectOptions,
    totalTimeout: number,
    candidateHealth: Map<string, CandidateHealth>,
    runtime: CandidateRuntime,
    signal?: AbortSignal,
  ) {
    this.adapter = adapter;
    this.opts = opts;
    this.totalTimeout = totalTimeout;
    this.candidateHealth = candidateHealth;
    this.runtime = runtime;
    this.signal = signal;
    this.discoveryMode = opts.discoveryMode ?? "automatic";
    this.localDiscoveryTimeoutMs = this.discoveryMode === "lan"
      ? totalTimeout
      : Math.max(250, Math.min(2000, Math.floor(totalTimeout * 0.15)));
  }

  private get raceSignal() {
    return this.raceController.signal;
  }

  async run(): Promise<SyncpeerSessionHandle> {
    const ordered = await this.discoverCandidates();
    this.selectCandidates(ordered);
    if (this.opts.relayOnly && this.relayCandidates.length === 0) {
      throw new Error("Relay-only mode requires a relay address from global discovery.");
    }
    if (this.opts.quicOnly && !this.adapter.connectQuic) {
      throw new Error("QUIC is unavailable in this runtime.");
    }
    if (this.relayCandidates.length > 0 && !this.relayEnabled) {
      this.errors.push("Relay fallback is disabled by settings");
    }
    this.prepareRace();
    const attempts = [this.directAttempt(), this.relayAttempt()].filter(
      (attempt): attempt is Promise<SyncpeerSessionHandle> => attempt !== null,
    );
    return this.awaitRace(attempts);
  }

  private async discoverCandidates() {
    const outcome = await this.runDiscovery();
    const globalCandidates = outcome.global.status === "fulfilled"
      ? outcome.global.value.candidates
      : [];
    const localCandidates = outcome.local.status === "fulfilled"
      ? outcome.local.value.map((candidate) => ({
          ...candidate,
          source: "local" as const,
          scope: candidate.scope ?? "lan",
        }))
      : [];
    this.logDiscovery(outcome, localCandidates);
    const merged = dedupeCandidates([
      ...(this.discoveryMode === "automatic" ? this.manualCandidates() : []),
      ...localCandidates,
      ...globalCandidates,
    ]);
    this.assertDiscovery(outcome, merged);
    return normalizeDiscoveredCandidates(merged);
  }

  private async runDiscovery(): Promise<DiscoveryOutcome> {
    const global = this.discoveryMode === "lan"
      ? Promise.resolve({ payload: null, candidates: [] } as SyncpeerGlobalDiscoveryResult)
      : resolveGlobalDiscoveryInternal(this.adapter, {
          expectedDeviceId: this.opts.expectedDeviceId ?? "",
          discoveryServer: this.opts.discoveryServer,
        }, this.signal);
    const local = this.discoveryMode === "global"
      ? Promise.resolve([])
      : this.adapter.discoverLocalCandidates
        ? this.adapter.discoverLocalCandidates({
            expectedDeviceId: this.opts.expectedDeviceId ?? "",
            timeoutMs: this.localDiscoveryTimeoutMs,
            signal: this.signal,
          })
        : Promise.resolve([]);
    const [globalResult, localResult] = await Promise.allSettled([global, local]);
    return { global: globalResult, local: localResult };
  }

  private logDiscovery(outcome: DiscoveryOutcome, localCandidates: DiscoveredCandidate[]) {
    if (outcome.global.status === "rejected") {
      this.adapter.log?.("core.discovery.global_failed", {
        message: outcome.global.reason instanceof Error
          ? outcome.global.reason.message : String(outcome.global.reason),
      });
    }
    if (localCandidates.length > 0) {
      this.adapter.log?.("core.discovery.local_response", {
        timeoutMs: this.localDiscoveryTimeoutMs,
        candidates: localCandidates,
      });
    }
    if (outcome.local.status === "rejected") {
      this.adapter.log?.("core.discovery.local_failed", {
        timeoutMs: this.localDiscoveryTimeoutMs,
        message: outcome.local.reason instanceof Error
          ? outcome.local.reason.message
          : String(outcome.local.reason),
      });
    }
  }

  private manualCandidates(): DiscoveredCandidate[] {
    if (this.opts.host.trim() === "") return [];
    return [
      {
        address: `tcp://${this.opts.host}:${this.opts.port}`,
        protocol: "tcp",
        host: this.opts.host,
        port: this.opts.port,
        scope: connectionScopeForHost(this.opts.host),
        source: "manual",
      },
      ...(this.adapter.connectQuic ? [{
        address: `quic://${this.opts.host}:${this.opts.port}`,
        protocol: "quic" as const,
        host: this.opts.host,
        port: this.opts.port,
        scope: connectionScopeForHost(this.opts.host),
        source: "manual" as const,
      }] : []),
    ];
  }

  private assertDiscovery(outcome: DiscoveryOutcome, merged: DiscoveredCandidate[]) {
    if (this.discoveryMode === "lan" && outcome.local.status === "rejected") {
      throw outcome.local.reason instanceof Error
        ? outcome.local.reason
        : new Error(String(outcome.local.reason));
    }
    if (
      this.discoveryMode === "global" &&
      outcome.global.status === "rejected" &&
      merged.length === 0
    ) {
      throw outcome.global.reason instanceof Error
        ? outcome.global.reason
        : new Error(String(outcome.global.reason));
    }
    if (merged.length === 0) {
      throw new Error(
        this.discoveryMode === "lan"
          ? "No LAN discovery candidates available."
          : "No global discovery candidates available.",
      );
    }
  }

  private selectCandidates(ordered: DiscoveredCandidate[]) {
    const direct = this.opts.relayOnly ? [] : ordered.filter(
      (candidate) =>
        (candidate.protocol === "tcp" || candidate.protocol === "quic") &&
        (!this.opts.quicOnly || candidate.protocol === "quic") &&
        candidate.host &&
        Number.isFinite(candidate.port) &&
        (candidate.protocol !== "quic" || this.adapter.connectQuic !== undefined),
    );
    const relay = this.opts.quicOnly ? [] : ordered.filter(
      (candidate) => candidate.protocol === "relay",
    ).sort((left, right) =>
      (this.candidateHealth.get(candidateKey(left))?.cooldownUntilMs ?? 0) -
      (this.candidateHealth.get(candidateKey(right))?.cooldownUntilMs ?? 0));
    this.adapter.log?.("core.discovery.candidates.ordered", {
      directCandidates: direct,
      relayCandidates: relay,
    });
    this.connectDeadline = this.runtime.now() + this.totalTimeout;
    this.relayEnabled = this.opts.enableRelayFallback !== false;
    this.relayStartDelayMs = this.relayEnabled && relay.length > 0 && !this.opts.relayOnly
      ? Math.min(2500, Math.max(0, Math.floor(this.totalTimeout * 0.25)))
      : 0;
    this.perCandidateTimeout = Math.max(
      8000,
      Math.min(30000, Math.floor(this.totalTimeout / Math.max(direct.length || 1, 1))),
    );
    this.adapter.log?.("core.discovery.connect_strategy", {
      totalTimeout: this.totalTimeout,
      perCandidateTimeout: this.perCandidateTimeout,
      relayStartDelayMs: this.relayStartDelayMs,
      directCandidateCount: direct.length,
      relayCandidateCount: relay.length,
      orderedCandidates: ordered.map((candidate) => describeCandidate(candidate)),
    });
    this.directCandidates = direct;
    this.relayCandidates = relay;
  }

  private prepareRace() {
    if (this.signal?.aborted) this.abortRace();
    else this.signal?.addEventListener("abort", this.abortRace, { once: true });
  }

  private abortRace = () => this.raceController.abort();

  private async waitForCandidate(candidate: DiscoveredCandidate) {
    const until = this.candidateHealth.get(candidateKey(candidate))?.cooldownUntilMs ?? 0;
    const delayMs = Math.max(0, until - this.runtime.now());
    if (delayMs >= this.connectDeadline - this.runtime.now()) {
      throw new Error("Candidate cooldown exceeds connection budget");
    }
    if (delayMs > 0) await this.runtime.sleep(delayMs, this.raceSignal);
    throwIfConnectionAborted(this.raceSignal);
  }

  private async claimSession(session: SyncpeerSessionHandle) {
    if (this.winningSession) {
      await session.close().catch(() => undefined);
      throw new Error("Connection attempt lost the connection race");
    }
    this.winningSession = session;
    this.abortRace();
    return session;
  }

  private directAttempt() {
    if (this.directCandidates.length === 0) return null;
    return Promise.any(this.directCandidates.map((candidate) => this.openDirectCandidate(candidate)));
  }

  private async openDirectCandidate(candidate: DiscoveredCandidate) {
    await this.waitForCandidate(candidate);
    if (this.winningSession) throw new Error("Direct connection race cancelled");
    throwIfConnectionAborted(this.raceSignal);
    const remainingMs = Math.max(0, this.connectDeadline - this.runtime.now());
    if (remainingMs <= 0) throw new Error("Direct connection timeout budget exhausted");
    const candidateTimeoutMs = Math.min(this.perCandidateTimeout, remainingMs);
    try {
      return await this.tryDirectCandidate(candidate, candidateTimeoutMs);
    } catch (error) {
      this.handleDirectFailure(candidate, error);
      throw error;
    }
  }

  private async tryDirectCandidate(candidate: DiscoveredCandidate, candidateTimeoutMs: number) {
    this.adapter.log?.("core.discovery.candidate.try", {
      address: candidate.address,
      host: candidate.host,
      port: candidate.port,
      perCandidateTimeout: candidateTimeoutMs,
      strategy: "parallel-with-relay-fallback",
    });
    const open = candidate.protocol === "quic" ? openQuicSession : openDirectSession;
    const session = await withSessionTimeout(
      open(
        this.adapter,
        this.opts,
        candidate.host!,
        candidate.port!,
        candidateTimeoutMs,
        candidate.scope ?? (candidate.source === "local" ? "lan" : connectionScopeForHost(candidate.host!)),
        this.raceSignal,
      ),
      candidateTimeoutMs,
    );
    trackCandidateSession(this.candidateHealth, candidate, session, this.runtime.now);
    return this.claimSession(session);
  }

  private handleDirectFailure(candidate: DiscoveredCandidate, error: unknown) {
    if (this.raceSignal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    this.adapter.log?.("core.discovery.candidate.failed", {
      address: candidate.address,
      host: candidate.host,
      port: candidate.port,
      message,
    });
    this.errors.push(`${candidate.address}: ${message}`);
    recordCandidateFailure(this.candidateHealth, candidate, this.runtime.now);
  }

  private relayAttempt() {
    if (!this.relayEnabled || this.relayCandidates.length === 0) return null;
    return this.runRelayCandidates();
  }

  private async runRelayCandidates(): Promise<SyncpeerSessionHandle> {
    if (this.relayStartDelayMs > 0) await this.runtime.sleep(this.relayStartDelayMs);
    throwIfConnectionAborted(this.raceSignal);
    if (this.winningSession) throw new Error("Relay connection race cancelled");
    for (const candidate of this.relayCandidates) {
      if ((this.candidateHealth.get(candidateKey(candidate))?.cooldownUntilMs ?? 0) >= this.connectDeadline) {
        continue;
      }
      await this.waitForCandidate(candidate);
      const session = await this.tryRelayCandidate(candidate);
      if (session) return session;
    }
    throw new Error("All relay discovery candidates failed.");
  }

  private relayFailure(
    candidate: DiscoveredCandidate,
    attempt: number,
    relayMaxAttempts: number,
    error: unknown,
  ) {
    if (this.raceSignal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    this.adapter.log?.("core.discovery.relay.failed", {
      address: candidate.address,
      attempt,
      attemptsTotal: relayMaxAttempts,
      message,
    });
    this.errors.push(`${candidate.address} (attempt ${attempt}/${relayMaxAttempts}): ${message}`);
    recordCandidateFailure(this.candidateHealth, candidate, this.runtime.now);
    return attempt < relayMaxAttempts &&
      (isTimeoutLikeError(message) || isTransientRelayError(message));
  }

  private async tryRelaySession(
    candidate: DiscoveredCandidate,
    attempt: number,
    relayMaxAttempts: number,
    attemptTimeoutMs: number,
  ) {
    this.adapter.log?.("core.discovery.relay.try", {
      address: candidate.address,
      attempt,
      attemptsTotal: relayMaxAttempts,
      timeoutMs: attemptTimeoutMs,
      strategy: this.relayStartDelayMs > 0 ? "parallel-fallback" : "preferred",
    });
    const session = await withSessionTimeout(
      openRelaySession(this.adapter, this.opts, candidate.address, attemptTimeoutMs, this.raceSignal),
      attemptTimeoutMs,
    );
    trackCandidateSession(this.candidateHealth, candidate, session, this.runtime.now);
    return this.claimSession(session);
  }

  private async tryRelayCandidate(candidate: DiscoveredCandidate) {
    const relayMaxAttempts = 2;
    for (let attempt = 1; attempt <= relayMaxAttempts; attempt += 1) {
      if (this.winningSession) throw new Error("Relay connection race cancelled");
      const remainingMs = Math.max(0, this.connectDeadline - this.runtime.now());
      if (remainingMs <= 0) return null;
      const attemptTimeoutMs = Math.min(
        remainingMs,
        Math.max(1000, Math.min(10000, Math.floor(remainingMs / (relayMaxAttempts - attempt + 1)))),
      );
      try {
        return await this.tryRelaySession(candidate, attempt, relayMaxAttempts, attemptTimeoutMs);
      } catch (error) {
        if (!this.relayFailure(candidate, attempt, relayMaxAttempts, error)) return null;
        await this.runtime.sleep(250);
      }
    }
    return null;
  }

  private async awaitRace(attempts: Promise<SyncpeerSessionHandle>[]) {
    try {
      if (attempts.length > 0) {
        try {
          return await Promise.any(attempts);
        } catch {
          // The detailed candidate errors below are more useful than AggregateError.
        }
      }
      const hint = maybeConnectionHint(this.opts, this.errors);
      const technical = `Could not connect using discovered candidates. ${this.errors.join(" | ")}`;
      throw new Error(hint ? `${hint} Technical details: ${technical}` : technical);
    } finally {
      this.signal?.removeEventListener("abort", this.abortRace);
      this.abortRace();
    }
  }
}

async function openSessionAttempt(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  totalTimeout: number,
  candidateHealth: Map<string, CandidateHealth>,
  runtime: CandidateRuntime,
  signal?: AbortSignal,
): Promise<SyncpeerSessionHandle> {
  return new ConnectionAttempt(adapter, opts, totalTimeout, candidateHealth, runtime, signal).run();
}

async function openDirectMode(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  signal?: AbortSignal,
) {
  throwIfConnectionAborted(signal);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0 ? opts.timeoutMs! : 15000;
  const attempt = new AbortController();
  const forwardAbort = () => attempt.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(forwardAbort, timeoutMs);
  try {
    const opening = opts.quicOnly
      ? openQuicSession(adapter, opts, opts.host, opts.port, timeoutMs, undefined, attempt.signal)
      : openDirectSession(adapter, opts, opts.host, opts.port, timeoutMs, undefined, attempt.signal);
    return await withSessionTimeout(opening, timeoutMs);
  } catch (error) {
    attempt.abort();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function openWithDiscoveryRetry(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  candidateHealth: Map<string, CandidateHealth>,
  runtime: CandidateRuntime,
  signal?: AbortSignal,
) {
  const totalTimeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs && opts.timeoutMs > 0
    ? opts.timeoutMs
    : 15000;
  const deadline = runtime.now() + totalTimeout;
  let lastError: Error | null = null;
  while (runtime.now() < deadline) {
    throwIfConnectionAborted(signal);
    const remainingMs = deadline - runtime.now();
    try {
      return await openSessionAttempt(
        adapter,
        { ...opts, timeoutMs: remainingMs },
        remainingMs,
        candidateHealth,
        runtime,
        signal,
      );
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      lastError = normalized;
      if (!isTransientDiscoveryError(error)) throw normalized;
      const waitForMs = Math.min(1000, Math.max(0, deadline - runtime.now()));
      if (waitForMs <= 0) break;
      adapter.log?.("core.discovery.retry", {
        remainingMs: deadline - runtime.now(),
        message: normalized.message,
        waitMs: waitForMs,
      });
      await runtime.sleep(waitForMs);
    }
  }
  throw lastError ?? new Error("Connection timed out while discovering the remote device.");
}

async function openSession(
  adapter: SyncpeerHostAdapter,
  opts: SyncpeerConnectOptions,
  candidateHealth: Map<string, CandidateHealth>,
  runtime: CandidateRuntime,
  signal?: AbortSignal,
): Promise<SyncpeerSessionHandle> {
  if ((opts.discoveryMode ?? "automatic") === "direct") {
    return openDirectMode(adapter, opts, signal);
  }
  return openWithDiscoveryRetry(adapter, opts, candidateHealth, runtime, signal);
}

export interface SyncpeerCoreClient {
  openSession: (
    options: SyncpeerConnectOptions,
    signal?: AbortSignal,
  ) => Promise<SyncpeerSessionHandle>;
}

export function createSyncpeerCoreClient(
  adapter: SyncpeerHostAdapter,
  runtimeInput?: { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): SyncpeerCoreClient {
  const candidateHealth = new Map<string, CandidateHealth>();
  const runtime: CandidateRuntime = {
    now: runtimeInput?.now ?? Date.now,
    sleep: runtimeInput?.sleep ?? waitMs,
  };
  return {
    openSession: async (options: SyncpeerConnectOptions, signal?: AbortSignal) => {
      try {
        return await openSession(adapter, options, candidateHealth, runtime, signal);
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
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
}
