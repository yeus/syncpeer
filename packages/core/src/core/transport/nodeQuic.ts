import { createPrivateKey, X509Certificate } from "node:crypto";
import type { SyncpeerQuicConnectOptions, SyncpeerTlsSocket } from "../../client.js";

interface NodeQuicWriter {
  write: (bytes: Uint8Array) => Promise<void>;
  end: () => Promise<void>;
}

interface NodeQuicStream extends AsyncIterable<Uint8Array[]> {
  writer: NodeQuicWriter;
}

interface NodeQuicSession {
  peerCertificate?: X509Certificate;
  opened: Promise<{ protocol: string }>;
  createBidirectionalStream: () => Promise<NodeQuicStream>;
  close: () => Promise<void>;
  destroy?: (error?: Error) => void;
}

interface NodeQuicModule {
  connect: (address: string, options: Record<string, unknown>) => Promise<NodeQuicSession>;
}

const loadNodeQuic = async (): Promise<NodeQuicModule> => {
  const dynamicImport = new Function("specifier", "return import(specifier)") as
    (specifier: string) => Promise<unknown>;
  const loaded = await dynamicImport("node:quic").catch((error: unknown) => {
    throw new Error(
      "Native node:quic is unavailable. Use a Node build with QUIC support and --experimental-quic.",
      { cause: error },
    );
  });
  if (!loaded || typeof loaded !== "object" || !("connect" in loaded) || typeof loaded.connect !== "function") {
    throw new Error("The native node:quic module does not expose connect().");
  }
  return loaded as NodeQuicModule;
};

export const connectNodeQuic = async (
  options: SyncpeerQuicConnectOptions,
): Promise<SyncpeerTlsSocket> => {
  const quic = await loadNodeQuic();
  const certificate = new X509Certificate(options.certPem);
  const session = await quic.connect(`${options.host}:${options.port}`, {
    alpn: options.alpn,
    certs: [certificate.raw],
    keys: [createPrivateKey(options.keyPem)],
    servername: options.host,
    verifyPeer: "manual",
    rejectUnauthorized: false,
    handshakeTimeout: options.timeoutMs ?? 15_000,
    keepAlive: options.keepaliveMs,
    transportParams: { maxIdleTimeout: options.idleTimeoutMs },
  });
  const onAbort = () => session.destroy?.(new Error("Connection attempt was cancelled."));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const opened = await session.opened;
  if (opened.protocol !== options.alpn) {
    await session.close().catch(() => undefined);
    throw new Error(`QUIC negotiated unexpected ALPN '${opened.protocol}'.`);
  }
  const peerCertificate = session.peerCertificate;
  if (!peerCertificate) {
    await session.close().catch(() => undefined);
    throw new Error("QUIC peer did not provide a certificate.");
  }
  const stream = await session.createBidirectionalStream();
  const iterator = stream[Symbol.asyncIterator]();
  let buffered = new Uint8Array(0);

  return {
    peerCertificateDer: async () => new Uint8Array(peerCertificate.raw),
    read: async (maxBytes = 64 * 1024) => {
      while (buffered.length === 0) {
        const next = await iterator.next();
        if (next.done) throw new Error("Connection closed");
        const length = next.value.reduce((sum, chunk) => sum + chunk.length, 0);
        buffered = new Uint8Array(length);
        let offset = 0;
        for (const chunk of next.value) {
          buffered.set(chunk, offset);
          offset += chunk.length;
        }
      }
      const output = buffered.slice(0, maxBytes);
      buffered = buffered.slice(output.length);
      return output;
    },
    write: (bytes) => stream.writer.write(bytes),
    close: async () => {
      options.signal?.removeEventListener("abort", onAbort);
      await stream.writer.end().catch(() => undefined);
      await session.close().catch(() => undefined);
    },
  };
};
