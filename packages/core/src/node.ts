import crypto from "node:crypto";
import tls from "node:tls";
import {
  createSyncpeerCoreClient,
  resolveGlobalDiscovery,
  type SyncpeerGlobalDiscoveryOptions,
  type SyncpeerHostAdapter,
  type SyncpeerTlsConnectOptions,
  type SyncpeerTlsSocket,
} from "./client.js";

class NodeTlsSocket implements SyncpeerTlsSocket {
  private queue: Uint8Array[] = [];
  private waiters: Array<{ resolve: (chunk: Uint8Array) => void; reject: (error: Error) => void }> = [];
  private closed = false;
  private closeError: Error | null = null;

  constructor(private socket: tls.TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
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

export function createNodeHostAdapter(): SyncpeerHostAdapter {
  return {
    connectTls: connectNodeTls,
    async sha256(data: Uint8Array): Promise<Uint8Array> {
      const digest = crypto.createHash("sha256").update(Buffer.from(data)).digest();
      return new Uint8Array(digest);
    },
    randomBytes(length: number): Uint8Array {
      return new Uint8Array(crypto.randomBytes(length));
    },
    fetch: (input, init) => fetch(input, init),
  };
}

export async function resolveNodeGlobalDiscovery(
  options: SyncpeerGlobalDiscoveryOptions,
): Promise<{ host: string; port: number }> {
  return resolveGlobalDiscovery(createNodeHostAdapter(), options);
}

export const createNodeSyncpeerClient = () => createSyncpeerCoreClient(createNodeHostAdapter());
