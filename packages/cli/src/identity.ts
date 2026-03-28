import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SYNCTHING_VERSION = process.env.SYNCTHING_VERSION ?? "v1.27.8";
const DEVICE_ID_RE = /([A-Z2-7-]{52,56})/;

export interface CliNodeIdentity {
  cert: string;
  key: string;
  deviceId: string | null;
  configDir: string;
}

function configHome(): string {
  const fromEnv = process.env.XDG_CONFIG_HOME;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(os.homedir(), ".config");
}

function resolveSyncthingBin(): string | null {
  const candidates: string[] = [];
  if (process.env.SYNCTHING_BIN) candidates.push(process.env.SYNCTHING_BIN);

  const platformMap: Record<string, string> = { linux: "linux", darwin: "macos" };
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (platform && arch) {
    candidates.push(path.resolve(".tools", `syncthing-${platform}-${arch}-${DEFAULT_SYNCTHING_VERSION}`, "syncthing"));
  }
  candidates.push("syncthing");

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--help"], { stdio: "ignore" });
      return candidate;
    } catch {}
  }
  return null;
}

function readDeviceIdFile(deviceIdPath: string): string | null {
  if (!fs.existsSync(deviceIdPath)) return null;
  const content = fs.readFileSync(deviceIdPath, "utf8");
  const match = content.match(DEVICE_ID_RE);
  return match ? match[1] : null;
}

function parseFirstCertificateDer(pem: string): Buffer {
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!match) {
    throw new Error("Could not parse certificate PEM block");
  }
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
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

function readDeviceIdFromCert(certPath: string): string {
  const certPem = fs.readFileSync(certPath, "utf8");
  const certDer = parseFirstCertificateDer(certPem);
  const digest = createHash("sha256").update(certDer).digest();
  return base32NoPadding(digest);
}

export function ensureCliNodeIdentity(): CliNodeIdentity {
  const cliNodeDir = path.join(configHome(), "syncpeer", "cli-node");
  const certPath = path.join(cliNodeDir, "cert.pem");
  const keyPath = path.join(cliNodeDir, "key.pem");
  const deviceIdPath = path.join(cliNodeDir, "device-id.txt");

  fs.mkdirSync(cliNodeDir, { recursive: true });

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    const syncthingBin = resolveSyncthingBin();
    if (!syncthingBin) {
      throw new Error([
        "No --cert/--key provided and no persisted cli-node identity found.",
        `Expected cert/key at ${cliNodeDir}`,
        "To auto-create the identity, install Syncthing or set SYNCTHING_BIN.",
        "Or pass --cert and --key explicitly.",
      ].join("\n"));
    }
    execFileSync(syncthingBin, ["generate", "--home", cliNodeDir], { stdio: "ignore" });
  }

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(`Failed to initialize cli-node identity in ${cliNodeDir}`);
  }

  let deviceId = readDeviceIdFile(deviceIdPath);
  if (!deviceId) {
    deviceId = readDeviceIdFromCert(certPath);
    fs.writeFileSync(deviceIdPath, `${deviceId}\n`);
  }

  return { cert: certPath, key: keyPath, deviceId: deviceId ?? null, configDir: cliNodeDir };
}
