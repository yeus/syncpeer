import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";
import {
  createSyncpeerCoreClient,
  resolveGlobalDiscovery,
  type SyncpeerDiscoveryFetchInit,
  type SyncpeerDiscoveryResponse,
  type SyncpeerGlobalDiscoveryOptions,
  type SyncpeerHostAdapter,
  type SyncpeerTlsConnectOptions,
  type SyncpeerTlsSocket,
} from "./client.js";

type ByteBuffer = Buffer<ArrayBufferLike>;

class NodeTlsSocket implements SyncpeerTlsSocket {
  private queue: Uint8Array[] = [];
  private waiters: Array<{ resolve: (chunk: Uint8Array) => void; reject: (error: Error) => void }> = [];
  private closed = false;
  private closeError: Error | null = null;

  constructor(private socket: tls.TLSSocket) {
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
    ALPNProtocols: ["bep/1.0"],
    cert: options.certPem,
    key: options.keyPem,
    ca: options.caPem,
    rejectUnauthorized: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });
  return new NodeTlsSocket(socket);
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
    async sha256(data: Uint8Array): Promise<Uint8Array> {
      const digest = crypto.createHash("sha256").update(Buffer.from(data)).digest();
      return new Uint8Array(digest);
    },
    randomBytes(length: number): Uint8Array {
      return new Uint8Array(crypto.randomBytes(length));
    },
    discoveryFetch: nodeDiscoveryFetch,
    log: enableLogs
      ? (event, details) => {
          if (details === undefined) {
            console.error(`[syncpeer-core] ${event}`);
            return;
          }
          console.error(`[syncpeer-core] ${event}`, details);
        }
      : undefined,
  };
}

export async function resolveNodeGlobalDiscovery(
  options: SyncpeerGlobalDiscoveryOptions,
): Promise<Awaited<ReturnType<typeof resolveGlobalDiscovery>>> {
  return resolveGlobalDiscovery(createNodeHostAdapter(), options);
}

export const createNodeSyncpeerClient = () => createSyncpeerCoreClient(createNodeHostAdapter());
