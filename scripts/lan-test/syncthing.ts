import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import type { LanFixture } from "./protocol.ts";

export const SYNCTHING_GLOBAL_DISCOVERY_SERVER = "https://discovery.syncthing.net/v2/";
const SYNCTHING_RELAY_POOL = "dynamic+https://relays.syncthing.net/endpoint";

const version = process.env.SYNCTHING_VERSION ?? "v1.27.8";
const relayVersion = process.env.SYNCTHING_RELAY_VERSION ?? "v2.1.3";
const platform = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "macos" : "";
const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
const toolsRoot = path.resolve(".tools");

if (!platform || !arch) {
  throw new Error("LAN Syncthing tests support Linux and macOS x64/arm64 only.");
}

const binaryPath = (name: string): string => {
  const selectedVersion = name === "strelaysrv" ? relayVersion : version;
  return path.join(toolsRoot, name + "-" + platform + "-" + arch + "-" + selectedVersion, name);
};

const ensureDir = (directory: string): void => {
  fs.mkdirSync(directory, { recursive: true });
};

export const ensureSyncthingTools = (): void => {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "download:syncthing"], {
    stdio: "inherit",
  });
};

export const generateSyncthingIdentity = (home: string): {
  deviceId: string;
  certPath: string;
  keyPath: string;
} => {
  ensureSyncthingTools();
  ensureDir(home);
  execFileSync(binaryPath("syncthing"), ["generate", "--home", home], { stdio: "ignore" });
  return {
    deviceId: readDeviceId(home),
    certPath: path.join(home, "cert.pem"),
    keyPath: path.join(home, "key.pem"),
  };
};

export const readDeviceId = (home: string): string => {
  const certPem = fs.readFileSync(path.join(home, "cert.pem"), "utf8");
  const match = certPem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!match) throw new Error("Could not parse Syncthing certificate in " + home + ".");
  const digest = createHash("sha256")
    .update(Buffer.from(match[1].replace(/\s+/g, ""), "base64"))
    .digest();
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

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const freePort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a TCP port.");
  return address.port;
};

const waitFor = async (
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for " + label + ".");
};

const waitForFile = (filePath: string, timeoutMs: number, label: string): Promise<void> =>
  waitFor(async () => fs.existsSync(filePath), timeoutMs, label);

const waitForTcp = (host: string, port: number, timeoutMs: number, label: string): Promise<void> =>
  waitFor(() => new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  }), timeoutMs, label);

const replaceTag = (xml: string, tag: string, value: string): string => {
  const pattern = new RegExp("(<" + tag + ">)[\\s\\S]*?(</" + tag + ">)");
  if (pattern.test(xml)) return xml.replace(pattern, "$1" + escapeXml(value) + "$2");
  return xml.replace(/(<options>\s*\n)/, "$1        <" + tag + ">" + escapeXml(value) + "</" + tag + ">\n");
};

const replaceRepeatedTag = (xml: string, tag: string, values: string[]): string => {
  const block = values.map((value) =>
    "        <" + tag + ">" + escapeXml(value) + "</" + tag + ">").join("\n");
  const pattern = new RegExp("\\s*<" + tag + ">[\\s\\S]*?</" + tag + ">", "g");
  return xml.replace(pattern, "").replace(/(<options>\s*\n)/, "$1" + block + "\n");
};

const removeDefaultFolder = (xml: string): string =>
  xml.replace(/\s*<folder id="default"[\s\S]*?<\/folder>/, "");

const addDevice = (xml: string, deviceId: string, name: string, untrusted = false): string => {
  if (xml.includes('<device id="' + deviceId + '"')) return xml;
  const block = [
    '    <device id="' + escapeXml(deviceId) + '" name="' + escapeXml(name) + '" compression="metadata" introducer="false" skipIntroductionRemovals="false" introducedBy="">',
    "        <address>dynamic</address>",
    "        <paused>false</paused>",
    "        <autoAcceptFolders>false</autoAcceptFolders>",
    "        <maxSendKbps>0</maxSendKbps>",
    "        <maxRecvKbps>0</maxRecvKbps>",
    "        <maxRequestKiB>0</maxRequestKiB>",
    "        <untrusted>" + String(untrusted) + "</untrusted>",
    "        <remoteGUIPort>0</remoteGUIPort>",
    "        <numConnections>0</numConnections>",
    "    </device>",
    "",
  ].join("\n");
  return xml.replace(/(\s*<gui\b[\s\S]*$)/, block + "$1");
};

const addFolder = (xml: string, args: {
  id: string;
  folderPath: string;
  deviceIds: string[];
  encryptionPasswords?: Record<string, string>;
  type?: "sendreceive" | "sendonly";
}): string => {
  if (xml.includes('<folder id="' + args.id + '"')) return xml;
  const devices = [...new Set(args.deviceIds)].map((deviceId) => [
    '        <device id="' + escapeXml(deviceId) + '" introducedBy="">',
    "            <encryptionPassword>" + escapeXml(args.encryptionPasswords?.[deviceId] ?? "") + "</encryptionPassword>",
    "        </device>",
  ].join("\n")).join("\n");
  const block = [
    '    <folder id="' + escapeXml(args.id) + '" label="' + escapeXml(args.id) + '" path="' + escapeXml(args.folderPath) + '" type="' + (args.type ?? "sendreceive") + '" rescanIntervalS="1" fsWatcherEnabled="true" fsWatcherDelayS="1" fsWatcherTimeoutS="0" ignorePerms="false" autoNormalize="true">',
    "        <filesystemType>basic</filesystemType>",
    devices,
    '        <minDiskFree unit="%">1</minDiskFree>',
    "        <versioning><cleanupIntervalS>3600</cleanupIntervalS><fsPath></fsPath><fsType>basic</fsType></versioning>",
    "        <copiers>0</copiers><pullerMaxPendingKiB>0</pullerMaxPendingKiB><hashers>0</hashers>",
    "        <order>random</order><ignoreDelete>false</ignoreDelete><scanProgressIntervalS>0</scanProgressIntervalS>",
    "        <pullerPauseS>0</pullerPauseS><pullerDelayS>1</pullerDelayS><maxConflicts>10</maxConflicts>",
    "        <disableSparseFiles>false</disableSparseFiles><paused>false</paused><markerName>.stfolder</markerName>",
    "        <copyOwnershipFromParent>false</copyOwnershipFromParent><modTimeWindowS>0</modTimeWindowS>",
    "        <maxConcurrentWrites>16</maxConcurrentWrites><disableFsync>false</disableFsync>",
    "        <blockPullOrder>standard</blockPullOrder><copyRangeMethod>standard</copyRangeMethod>",
    "        <caseSensitiveFS>false</caseSensitiveFS><junctionsAsDirs>false</junctionsAsDirs>",
    "        <syncOwnership>false</syncOwnership><sendOwnership>false</sendOwnership><syncXattrs>false</syncXattrs>",
    "    </folder>",
    "",
  ].join("\n");
  return xml.replace(/(\s*<gui\b[\s\S]*$)/, block + "$1");
};

const configureHome = (home: string, args: {
  guiPort: number;
  syncPort: number;
  discoveryServer: string;
  direct: boolean;
  localAnnounce: boolean;
  trustedDeviceId: string;
  untrustedDeviceId?: string;
  sharePath: string;
  encryptedSharePath: string;
  folderId: string;
  encryptedFolderId: string;
  password: string;
}): void => {
  const configPath = path.join(home, "config.xml");
  let xml = removeDefaultFolder(fs.readFileSync(configPath, "utf8"));
  xml = xml.replace(
    /(<gui\b[\s\S]*?<address>)[^<]*(<\/address>)/,
    (_match, prefix, suffix) => prefix + "127.0.0.1:" + args.guiPort + suffix,
  );
  const addresses = args.direct
    ? ["tcp4://0.0.0.0:" + args.syncPort]
    : [SYNCTHING_RELAY_POOL];
  xml = replaceRepeatedTag(xml, "listenAddress", addresses);
  xml = replaceRepeatedTag(xml, "globalAnnounceServer", [args.discoveryServer]);
  xml = replaceTag(xml, "globalAnnounceEnabled", "true");
  xml = replaceTag(xml, "localAnnounceEnabled", String(args.localAnnounce));
  xml = replaceTag(xml, "relaysEnabled", "true");
  xml = replaceTag(xml, "natEnabled", "true");
  xml = addDevice(xml, args.trustedDeviceId, "syncpeer-lan-client");
  if (args.untrustedDeviceId) xml = addDevice(xml, args.untrustedDeviceId, "syncpeer-lan-untrusted", true);
  xml = addFolder(xml, {
    id: args.folderId,
    folderPath: args.sharePath,
    deviceIds: [readDeviceId(home), args.trustedDeviceId],
  });
  if (args.untrustedDeviceId) xml = addFolder(xml, {
    id: args.encryptedFolderId,
    folderPath: args.encryptedSharePath,
    deviceIds: [readDeviceId(home), args.untrustedDeviceId],
    encryptionPasswords: { [args.untrustedDeviceId]: args.password },
    type: "sendonly",
  });
  fs.writeFileSync(configPath, xml);
};

const startProcess = (
  binary: string,
  args: string[],
  cwd: string,
  logPath: string,
): ChildProcess => {
  ensureDir(path.dirname(logPath));
  const log = fs.openSync(logPath, "a");
  const child = spawn(binary, args, {
    cwd,
    env: { ...process.env, STNOUPGRADE: "1", STNORESTART: "1" },
    stdio: ["ignore", log, log],
  });
  child.once("exit", () => fs.closeSync(log));
  return child;
};

const stopProcess = async (child: ChildProcess | null): Promise<void> => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const apiKeyFor = (home: string): string => {
  const xml = fs.readFileSync(path.join(home, "config.xml"), "utf8");
  const match = xml.match(/<apikey>([^<]+)<\/apikey>/);
  if (!match) throw new Error("Syncthing API key missing from " + home + ".");
  return match[1];
};

const apiRequest = async (
  baseUrl: string,
  apiKey: string,
  pathname: string,
  method = "GET",
): Promise<unknown> => {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: { "X-API-Key": apiKey },
  });
  if (!response.ok) throw new Error("Syncthing API " + method + " " + pathname + " failed: " + response.status);
  return response.json();
};

const hashFile = (filePath: string): { sha256: string; size: number } => {
  const bytes = fs.readFileSync(filePath);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
};

export interface RunningLanFixture {
  fixture: LanFixture;
  root: string;
  sharePath: string;
  encryptedSharePath: string;
  home: string;
  apiKey: string;
  syncGuiUrl: string;
  switchToRelayOnly: () => Promise<void>;
  addUntrustedProfile: (deviceId: string) => Promise<void>;
  verifyUploadedFile: () => Promise<{ sha256: string; size: number }>;
  churn: (durationMs: number) => Promise<number>;
  stop: () => Promise<void>;
}

export const createLanFixture = async (args: {
  root: string;
  serverHost: string;
  trustedDeviceId: string;
  untrustedDeviceId?: string;
  home?: string;
}): Promise<RunningLanFixture> => {
  ensureSyncthingTools();
  const root = args.root;
  const home = args.home ?? path.join(root, "syncthing");
  const sharePath = path.join(root, "share");
  const encryptedSharePath = path.join(root, "encrypted-share");
  ensureDir(root);
  ensureDir(sharePath);
  ensureDir(encryptedSharePath);
  if (!fs.existsSync(path.join(home, "cert.pem"))) {
    execFileSync(binaryPath("syncthing"), ["generate", "--home", home], { stdio: "ignore" });
  }
  const serverDeviceId = readDeviceId(home);
  const syncPort = await freePort();
  const guiPort = await freePort();
  const discoveryServer = SYNCTHING_GLOBAL_DISCOVERY_SERVER;
  const folderId = "syncpeer-lan";
  const encryptedFolderId = "syncpeer-lan-encrypted";
  const encryptedPassword = "correct horse battery staple";
  fs.writeFileSync(path.join(sharePath, "hello.txt"), "hello from the LAN fixture\n");
  fs.mkdirSync(path.join(sharePath, "nested"), { recursive: true });
  fs.writeFileSync(path.join(sharePath, "nested", "file.txt"), "nested LAN file\n");
  const blob = Buffer.alloc(12 * 1024 * 1024);
  for (let index = 0; index < blob.length; index += 1) blob[index] = index % 251;
  fs.writeFileSync(path.join(sharePath, "blob.bin"), blob);
  fs.writeFileSync(path.join(encryptedSharePath, "secret.txt"), "encrypted LAN secret\n");
  const encryptedExpected = {
    path: "secret.txt",
    ...hashFile(path.join(encryptedSharePath, "secret.txt")),
  };
  const configure = (direct: boolean, localAnnounce: boolean, untrustedDeviceId?: string) => configureHome(home, {
    guiPort,
    syncPort,
    discoveryServer,
    direct,
    localAnnounce,
    trustedDeviceId: args.trustedDeviceId,
    untrustedDeviceId,
    sharePath,
    encryptedSharePath,
    folderId,
    encryptedFolderId,
    password: encryptedPassword,
  });
  let syncthingProcess: ChildProcess | null = null;
  const start = async () => {
    syncthingProcess = startProcess(binaryPath("syncthing"), [
      "serve", "--home", home, "--no-browser", "--no-restart", "--no-upgrade",
    ], root, path.join(root, "syncthing.log"));
    await waitForTcp("127.0.0.1", guiPort, 30000, "Syncthing GUI");
  };
  configure(true, true, args.untrustedDeviceId);
  await start();
  const apiKey = apiKeyFor(home);
  const syncGuiUrl = "http://127.0.0.1:" + guiPort;
  const expectedFiles = ["hello.txt", "nested/file.txt", "blob.bin"].map((relativePath) => ({
    path: relativePath,
    ...hashFile(path.join(sharePath, relativePath)),
  }));
  const fixture: LanFixture = {
    runId: path.basename(root),
    serverHost: args.serverHost,
    directPort: syncPort,
    discoveryServer,
    remoteDeviceId: serverDeviceId,
    folderId,
    expectedFiles,
    encryptedFolderId,
    encryptedPassword,
    encryptedExpected,
  };
  await apiRequest(syncGuiUrl, apiKey, "/rest/system/status");
  return {
    fixture,
    root,
    sharePath,
    encryptedSharePath,
    home,
    apiKey,
    syncGuiUrl,
    switchToRelayOnly: async () => {
      await stopProcess(syncthingProcess);
      syncthingProcess = null;
      configure(false, false);
      await start();
    },
    addUntrustedProfile: async (deviceId: string) => {
      await stopProcess(syncthingProcess);
      syncthingProcess = null;
      configure(true, false, deviceId);
      await start();
    },
    verifyUploadedFile: async () => {
      const uploadPath = path.join(sharePath, "upload.txt");
      await waitForFile(uploadPath, 60000, "uploaded file");
      return hashFile(uploadPath);
    },
    churn: async (durationMs: number) => {
      const deadline = Date.now() + durationMs;
      let ticks = 0;
      while (Date.now() < deadline) {
        const relativePath = "churn-" + (ticks % 4) + ".txt";
        fs.writeFileSync(path.join(sharePath, relativePath), String(ticks) + "\n");
        await apiRequest(syncGuiUrl, apiKey, "/rest/db/scan?folder=" + encodeURIComponent(folderId), "POST");
        ticks += 1;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return ticks;
    },
    stop: async () => {
      await stopProcess(syncthingProcess);
    },
  };
};
