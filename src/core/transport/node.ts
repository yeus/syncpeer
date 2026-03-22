import crypto from "node:crypto";
import fs from "node:fs";
import tls from "node:tls";

export interface NodeTransportOptions {
  host: string;
  port: number;
  cert: string | Buffer;
  key: string | Buffer;
  ca?: string | Buffer;
  expectedDeviceId?: string;
}

function base32NoPadding(input: Buffer): string {
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

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}

function normalizeDeviceId(id: string): string {
  return id.replace(/[^A-Z2-7]/gi, "").toUpperCase();
}

export function computeDeviceId(rawCert: Buffer): string {
  const digest = crypto.createHash("sha256").update(rawCert).digest();
  return base32NoPadding(digest);
}

export async function connectTLS(opts: NodeTransportOptions): Promise<tls.TLSSocket> {
  const socket = tls.connect({
    host: opts.host,
    port: opts.port,
    cert: typeof opts.cert === "string" ? fs.readFileSync(opts.cert) : opts.cert,
    key: typeof opts.key === "string" ? fs.readFileSync(opts.key) : opts.key,
    ca: opts.ca ? (typeof opts.ca === "string" ? fs.readFileSync(opts.ca) : opts.ca) : undefined,
    rejectUnauthorized: false,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });

  const peer = socket.getPeerCertificate(true);
  if (!peer?.raw) {
    socket.destroy();
    throw new Error("Peer certificate missing");
  }

  if (opts.expectedDeviceId) {
    const got = normalizeDeviceId(computeDeviceId(peer.raw));
    const want = normalizeDeviceId(opts.expectedDeviceId);
    if (got != want) {
      socket.destroy();
      throw new Error(`Remote device ID mismatch: expected ${opts.expectedDeviceId}, got ${got}`);
    }
  }

  return socket;
}
