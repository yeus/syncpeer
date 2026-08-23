import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { createHash } from "node:crypto";
import type { Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

interface DiscoveryRecord {
  addresses: string[];
  updatedAtMs: number;
}

const deviceIdFromDer = (der: Buffer): string => {
  const digest = createHash("sha256").update(der).digest();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
};

const normalizeDeviceId = (value: string): string => value.replace(/-/g, "").toUpperCase();

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const writeJson = (response: ServerResponse, status: number, body: unknown): void => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
};

const ensureCertificate = (directory: string): { keyPath: string; certPath: string } => {
  fs.mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-subj", "/CN=syncpeer-lan-discovery", "-days", "2",
    ], { stdio: "ignore" });
  }
  return { keyPath, certPath };
};

export class PrivateDiscoveryServer {
  readonly deviceId: string;
  private readonly server: Server;
  private readonly records = new Map<string, DiscoveryRecord>();
  private readonly port: number;

  private constructor(
    server: Server,
    port: number,
    deviceId: string,
    records: Map<string, DiscoveryRecord>,
  ) {
    this.server = server;
    this.port = port;
    this.deviceId = deviceId;
    this.records = records;
  }

  static async start(args: { host: string; port: number; root: string }): Promise<PrivateDiscoveryServer> {
    const certificate = ensureCertificate(args.root);
    const certPem = fs.readFileSync(certificate.certPath);
    const deviceId = deviceIdFromDer(
      Buffer.from(certPem.toString().match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)?.[1]?.replace(/\s+/g, "") ?? "", "base64"),
    );
    const records = new Map<string, DiscoveryRecord>();
    const server = https.createServer({
      key: fs.readFileSync(certificate.keyPath),
      cert: certPem,
      requestCert: true,
      rejectUnauthorized: false,
    }, async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "https://discovery");
        if (request.method === "POST") {
          const peerCertificate = (request.socket as import("node:tls").TLSSocket).getPeerCertificate();
          if (!peerCertificate.raw) {
            writeJson(response, 403, { error: "Client certificate required." });
            return;
          }
          const payload = await readJsonBody(request) as { addresses?: unknown };
          const addresses = Array.isArray(payload.addresses)
            ? payload.addresses.filter((address): address is string => typeof address === "string")
            : [];
          records.set(deviceIdFromDer(peerCertificate.raw), {
            addresses,
            updatedAtMs: Date.now(),
          });
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === "GET") {
          const requested = url.searchParams.get("device")?.replace(/-/g, "").toUpperCase() ?? "";
          const record = records.get(normalizeDeviceId(requested));
          if (!record) {
            writeJson(response, 404, { error: "Device not found." });
            return;
          }
          writeJson(response, 200, { addresses: record.addresses });
          return;
        }
        writeJson(response, 405, { error: "Method not allowed." });
      } catch (error) {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(args.port, args.host, () => resolve());
    });
    return new PrivateDiscoveryServer(server, args.port, deviceId, records);
  }

  get url(): string {
    return "https://" + this.hostForUrl + ":" + this.port + "/v2/?id=" + this.deviceId;
  }

  hostForUrl = "127.0.0.1";

  hasAddress(deviceId: string, expectedAddress: string): boolean {
    return this.records.get(deviceId)?.addresses.includes(expectedAddress) ?? false;
  }

  publish(deviceId: string, addresses: string[]): void {
    this.records.set(normalizeDeviceId(deviceId), {
      addresses,
      updatedAtMs: Date.now(),
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
