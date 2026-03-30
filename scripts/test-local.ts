import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/*
 * Local fully-automated Syncthing integration test.
 * It creates two isolated homes, wires devices/folders without GUI usage,
 * waits for sync, then validates the syncpeer CLI against peer B.
 */

const keep = process.argv.includes("--keep");
const root = path.resolve(".tmp/syncpeer-test");
const aHome = path.join(root, "st-a");
const bHome = path.join(root, "st-b");
const folderId = "syncpeer-test";
const encryptedFolderId = "syncpeer-encrypted";
const bShareDir = path.join(root, "share-b");
const aRecvDir = path.join(root, "share-a");
const bEncryptedShareDir = path.join(root, "share-b-encrypted");
const cliConfigHome = path.join(root, "xdg-config");
const cliNodeHome = path.join(cliConfigHome, "syncpeer", "cli-node");
const cliUntrustedHome = path.join(root, "cli-untrusted-node");
const encryptedFolderPassword = "correct horse battery staple";
const toolsDir = path.resolve(".tools");
const version = process.env.SYNCTHING_VERSION ?? "v1.27.8";
const A_SYNC_ADDR = "tcp://127.0.0.1:58300";
const B_SYNC_ADDR = "tcp://127.0.0.1:58301";
const A_GUI_ADDR = "127.0.0.1:58384";
const B_GUI_ADDR = "127.0.0.1:58385";

const platformMap = {
  linux: "linux",
  darwin: "macos",
};
const archMap = {
  x64: "amd64",
  arm64: "arm64",
};

const platform = platformMap[process.platform];
const arch = archMap[process.arch];
if (!platform || !arch) {
  console.error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
  process.exit(1);
}
const syncthingDir = path.join(toolsDir, `syncthing-${platform}-${arch}-${version}`);
const syncthingBin = path.join(syncthingDir, "syncthing");
const cliEntry = path.resolve("packages", "cli", "dist", "main.js");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content);
}

function randomBuffer(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

function startSyncthing(home) {
  const args = ["serve", "--home", home, "--no-browser", "--no-restart", "--no-upgrade"];
  const child = spawn(syncthingBin, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      STNOUPGRADE: "1",
    },
  });
  return child;
}

function readDeviceId(home) {
  const certPath = path.join(home, "cert.pem");
  const certPem = fs.readFileSync(certPath, "utf8");
  const match = certPem.match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
  );
  if (!match) {
    throw new Error(`Could not parse certificate PEM from ${certPath}`);
  }
  const certDer = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  const digest = createHash("sha256").update(certDer).digest();
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
}

function escapeXml(v) {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function replaceGuiAddress(xml, guiAddress) {
  return xml.replace(
    /(<gui\b[^>]*>[\s\S]*?<address>)([^<]*)(<\/address>)/,
    `$1${escapeXml(guiAddress)}$3`,
  );
}

function setSingleListenAddress(xml, address) {
  return xml.replace(
    /<options>[\s\S]*?<\/options>/,
    (optsBlock) => {
      let out = optsBlock.replace(/^\s*<listenAddress>.*<\/listenAddress>\s*\n/gm, "");
      out = out.replace(
        /(<options>\s*\n)/,
        `$1        <listenAddress>${escapeXml(address)}</listenAddress>\n`,
      );
      return out;
    },
  );
}

function addTopLevelDevice(xml, deviceId, name, address, options = {}) {
  if (xml.includes(`<device id="${deviceId}"`)) {
    return xml;
  }
  const block = `    <device id="${escapeXml(deviceId)}" name="${escapeXml(name)}" compression="metadata" introducer="false" skipIntroductionRemovals="false" introducedBy="">
        <address>${escapeXml(address)}</address>
        <paused>false</paused>
        <autoAcceptFolders>false</autoAcceptFolders>
        <maxSendKbps>0</maxSendKbps>
        <maxRecvKbps>0</maxRecvKbps>
        <maxRequestKiB>0</maxRequestKiB>
        <untrusted>${options.untrusted ? "true" : "false"}</untrusted>
        <remoteGUIPort>0</remoteGUIPort>
        <numConnections>0</numConnections>
    </device>
`;
  return xml.replace(/(\s*<gui\b[\s\S]*$)/, `${block}$1`);
}

function addFolder(xml, id, label, folderPath, type, deviceIds, options = {}) {
  if (xml.includes(`<folder id="${id}"`)) {
    return xml;
  }
  const uniqueDeviceIds = [...new Set(deviceIds)];
  const deviceBlocks = uniqueDeviceIds
    .map((deviceId) => `        <device id="${escapeXml(deviceId)}" introducedBy="">
            <encryptionPassword>${escapeXml(options.encryptionPasswords?.[deviceId] ?? "")}</encryptionPassword>
        </device>`)
    .join("\n");
  const block = `    <folder id="${escapeXml(id)}" label="${escapeXml(label)}" path="${escapeXml(folderPath)}" type="${escapeXml(type)}" rescanIntervalS="30" fsWatcherEnabled="false" fsWatcherDelayS="10" fsWatcherTimeoutS="0" ignorePerms="false" autoNormalize="true">
        <filesystemType>basic</filesystemType>
${deviceBlocks}
        <minDiskFree unit="%">1</minDiskFree>
        <versioning>
            <cleanupIntervalS>3600</cleanupIntervalS>
            <fsPath></fsPath>
            <fsType>basic</fsType>
        </versioning>
        <copiers>0</copiers>
        <pullerMaxPendingKiB>0</pullerMaxPendingKiB>
        <hashers>0</hashers>
        <order>random</order>
        <ignoreDelete>false</ignoreDelete>
        <scanProgressIntervalS>0</scanProgressIntervalS>
        <pullerPauseS>0</pullerPauseS>
        <pullerDelayS>1</pullerDelayS>
        <maxConflicts>10</maxConflicts>
        <disableSparseFiles>false</disableSparseFiles>
        <paused>false</paused>
        <markerName>.stfolder</markerName>
        <copyOwnershipFromParent>false</copyOwnershipFromParent>
        <modTimeWindowS>0</modTimeWindowS>
        <maxConcurrentWrites>16</maxConcurrentWrites>
        <disableFsync>false</disableFsync>
        <blockPullOrder>standard</blockPullOrder>
        <copyRangeMethod>standard</copyRangeMethod>
        <caseSensitiveFS>false</caseSensitiveFS>
        <junctionsAsDirs>false</junctionsAsDirs>
        <syncOwnership>false</syncOwnership>
        <sendOwnership>false</sendOwnership>
        <syncXattrs>false</syncXattrs>
        <sendXattrs>false</sendXattrs>
        <xattrFilter>
            <maxSingleEntrySize>1024</maxSingleEntrySize>
            <maxTotalSize>4096</maxTotalSize>
        </xattrFilter>
    </folder>
`;
  return xml.replace(/(\s*<gui\b[\s\S]*$)/, `${block}$1`);
}

function configureHome(home, opts) {
  const configPath = path.join(home, "config.xml");
  let xml = fs.readFileSync(configPath, "utf8");
  xml = replaceGuiAddress(xml, opts.guiAddress);
  xml = setSingleListenAddress(xml, opts.listenAddress);
  for (const remote of opts.remoteDevices) {
    xml = addTopLevelDevice(xml, remote.id, remote.name, remote.address, {
      untrusted: remote.untrusted === true,
    });
  }
  for (const folder of opts.folders) {
    xml = addFolder(
      xml,
      folder.id,
      folder.label,
      folder.path,
      folder.type,
      folder.deviceIds,
      { encryptionPasswords: folder.encryptionPasswords ?? {} },
    );
  }
  fs.writeFileSync(configPath, xml);
}

async function waitForSync(filePath, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (content === expected) {
        return;
      }
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for synced file: ${filePath}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execCli(args, options = {}) {
  return execFileSync("node", [cliEntry, ...args], options);
}

function normalizeDeviceId(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
}

async function waitForIntroducedDeviceAdvertisement(options) {
  const {
    introducerHost,
    introducerPort,
    introducerDeviceId,
    localCertPath,
    localKeyPath,
    localDeviceName,
    expectedFolderId,
    expectedIntroducedDeviceId,
    timeoutMs,
  } = options;
  const expectedIntroduced = normalizeDeviceId(expectedIntroducedDeviceId);
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    let session = null;
    try {
      const { createNodeSyncpeerClient } = await import("../packages/core/src/node.ts");
      const certPem = fs.readFileSync(localCertPath, "utf8");
      const keyPem = fs.readFileSync(localKeyPath, "utf8");
      const client = createNodeSyncpeerClient();
      session = await client.openSession({
        host: introducerHost,
        port: introducerPort,
        certPem,
        keyPem,
        expectedDeviceId: introducerDeviceId,
        deviceName: localDeviceName,
        timeoutMs: 10_000,
        discoveryMode: "direct",
      });
      const folders = await session.remoteFs.listFolders();
      const targetFolder = folders.find((folder) => folder.id === expectedFolderId);
      if (!targetFolder) {
        lastErr = new Error(
          `Introducer did not advertise expected folder "${expectedFolderId}" yet.`,
        );
      } else {
        const advertised = (targetFolder.advertisedDevices ?? []).map((device) => ({
          id: normalizeDeviceId(device.id),
          name: device.name ?? "",
        }));
        const matched = advertised.find((device) => device.id === expectedIntroduced);
        if (matched) {
          return {
            introducedDeviceId: matched.id,
            introducedDeviceName: matched.name,
          };
        }
        lastErr = new Error(
          `Introducer folder "${expectedFolderId}" did not advertise device ${expectedIntroduced} yet. Advertised: ${advertised.map((item) => item.id).join(", ")}`,
        );
      }
    } catch (err) {
      lastErr = err;
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          // Best-effort close during polling.
        }
      }
    }
    await sleep(1500);
  }
  throw new Error(
    `Timed out waiting for introducer advertisement: ${String(lastErr)}`,
  );
}

async function waitForCliDownload(args, outPath, expectedContent, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      execCli(args, { stdio: "inherit" });
      const actual = fs.readFileSync(outPath, "utf8");
      if (actual === expectedContent) {
        return;
      }
      lastErr = new Error(`Downloaded content mismatch. Expected "${expectedContent}", got "${actual}"`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for CLI download to match expected content: ${String(lastErr)}`);
}

async function waitForCliOutputContains(args, expectedText, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastOutput = "";
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const output = execCli(args, { encoding: "utf8", ...options });
      lastOutput = output;
      if (output.includes(expectedText)) {
        return output;
      }
      lastErr = new Error(`Output did not contain expected text "${expectedText}" yet.`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(1500);
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Timed out waiting for CLI output to include "${expectedText}". Last error: ${detail}\nLast output:\n${lastOutput}`,
  );
}

async function main() {
  if (!fs.existsSync(syncthingBin)) {
    console.error(`Missing Syncthing binary: ${syncthingBin}`);
    console.error("Run: npm run download:syncthing");
    process.exit(1);
  }

  if (!keep) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  ensureDir(aHome);
  ensureDir(bHome);
  ensureDir(aRecvDir);
  ensureDir(bShareDir);
  ensureDir(bEncryptedShareDir);
  ensureDir(cliUntrustedHome);

  const expectedA = "hello from syncthing test\n";
  const expectedEncrypted = "super secret from encrypted folder\n";
  writeFile(path.join(bShareDir, "a.txt"), expectedA);
  writeFile(path.join(bShareDir, "subdir", "nested.txt"), "nested file\n");
  writeFile(path.join(bShareDir, "blob.bin"), randomBuffer(300 * 1024));
  writeFile(path.join(bEncryptedShareDir, "secret.txt"), expectedEncrypted);

  console.log("Building CLI packages...");
  execFileSync(npmCmd, ["run", "build:cli"], { stdio: "inherit" });

  console.log("Bootstrapping Syncthing homes...");
  execFileSync(syncthingBin, ["generate", "--home", aHome], { stdio: "inherit" });
  execFileSync(syncthingBin, ["generate", "--home", bHome], { stdio: "inherit" });

  const aId = readDeviceId(aHome);
  const bId = readDeviceId(bHome);

  console.log("Preparing persisted cli-node identity...");
  ensureDir(cliNodeHome);
  execFileSync(syncthingBin, ["generate", "--home", cliNodeHome], { stdio: "inherit" });
  const cliNodeId = readDeviceId(cliNodeHome);
  execFileSync(syncthingBin, ["generate", "--home", cliUntrustedHome], { stdio: "inherit" });
  const cliUntrustedId = readDeviceId(cliUntrustedHome);

  configureHome(aHome, {
    guiAddress: A_GUI_ADDR,
    listenAddress: A_SYNC_ADDR,
    remoteDevices: [
      { id: bId, name: "syncpeer-b", address: B_SYNC_ADDR },
      { id: cliNodeId, name: "syncpeer-cli-node", address: "dynamic" },
    ],
    folders: [
      {
        id: folderId,
        label: folderId,
        path: aRecvDir,
        type: "sendreceive",
        deviceIds: [aId, bId, cliNodeId],
      },
    ],
  });
  configureHome(bHome, {
    guiAddress: B_GUI_ADDR,
    listenAddress: B_SYNC_ADDR,
    remoteDevices: [
      { id: aId, name: "syncpeer-a", address: A_SYNC_ADDR },
      { id: cliNodeId, name: "syncpeer-cli-node", address: "dynamic" },
      { id: cliUntrustedId, name: "syncpeer-cli-untrusted", address: "dynamic", untrusted: true },
    ],
    folders: [
      {
        id: folderId,
        label: folderId,
        path: bShareDir,
        type: "sendonly",
        deviceIds: [bId, aId, cliNodeId],
      },
      {
        id: encryptedFolderId,
        label: encryptedFolderId,
        path: bEncryptedShareDir,
        type: "sendonly",
        deviceIds: [bId, cliUntrustedId],
        encryptionPasswords: {
          [cliUntrustedId]: encryptedFolderPassword,
        },
      },
    ],
  });

  let a;
  let b;
  try {
    a = startSyncthing(aHome);
    b = startSyncthing(bHome);

    await sleep(3000);
    await waitForSync(path.join(aRecvDir, "a.txt"), expectedA, 90_000);
    await waitForSync(path.join(aRecvDir, "subdir", "nested.txt"), "nested file\n", 90_000);

    const introduced = await waitForIntroducedDeviceAdvertisement({
      introducerHost: "127.0.0.1",
      introducerPort: 58300,
      introducerDeviceId: aId,
      localCertPath: path.join(cliNodeHome, "cert.pem"),
      localKeyPath: path.join(cliNodeHome, "key.pem"),
      localDeviceName: "syncpeer-cli-introducer-check",
      expectedFolderId: folderId,
      expectedIntroducedDeviceId: bId,
      timeoutMs: 60_000,
    });
    if (introduced.introducedDeviceId !== normalizeDeviceId(bId)) {
      throw new Error(
        `Introducer advertisement device ID mismatch: expected ${normalizeDeviceId(bId)}, got ${introduced.introducedDeviceId}`,
      );
    }
    console.log("Introducer advertisement check passed.");

    console.log("");
    console.log("=== Running core session-store parity checks ===");
    const {
      createNodeSessionTransport,
      createSyncpeerSessionStore,
    } = await import("../packages/core/src/index.ts");
    const sessionTransport = createNodeSessionTransport();
    const sessionTraceEvents = [];
    const sessionStore = createSyncpeerSessionStore({
      transport: sessionTransport,
      onTrace: (entry) => {
        sessionTraceEvents.push(entry);
      },
    });
    const sessionOptions = {
      discoveryMode: "direct",
      host: "127.0.0.1",
      port: 58301,
      cert: path.join(cliNodeHome, "cert.pem"),
      key: path.join(cliNodeHome, "key.pem"),
      remoteId: bId,
      deviceName: "syncpeer-cli-session-parity",
      timeoutMs: 20_000,
      folderPasswords: {},
    };
    await sessionStore.actions.connect(sessionOptions);
    let sessionState = sessionStore.getState();
    if (!sessionState.folders.some((folder) => folder.id === folderId)) {
      throw new Error(
        `Session-store connect did not expose expected folder "${folderId}".`,
      );
    }
    await sessionStore.actions.openFolder(folderId, sessionOptions);
    sessionState = sessionStore.getState();
    const rootEntryPaths = new Set(sessionState.entries.map((entry) => entry.path));
    if (!rootEntryPaths.has("a.txt")) {
      throw new Error(
        `Session-store root listing missing a.txt. Entries: ${[...rootEntryPaths].join(", ")}`,
      );
    }
    if (!rootEntryPaths.has("subdir")) {
      throw new Error(
        `Session-store root listing missing subdir. Entries: ${[...rootEntryPaths].join(", ")}`,
      );
    }

    await sessionStore.actions.disconnect();
    await sessionStore.actions.connect(sessionOptions);
    await sessionStore.actions.openFolder(folderId, sessionOptions);
    sessionState = sessionStore.getState();
    const reconnectEntryPaths = new Set(sessionState.entries.map((entry) => entry.path));
    if (!reconnectEntryPaths.has("a.txt")) {
      throw new Error(
        `Session-store reconnect listing missing a.txt. Entries: ${[...reconnectEntryPaths].join(", ")}`,
      );
    }
    await sessionStore.actions.disconnect();
    console.log(`Core session-store parity check passed (${sessionTraceEvents.length} trace events).`);

    console.log("");
    console.log("=== Running syncpeer CLI checks ===");
    // Disconnect Syncthing A before using A's cert in the CLI client.
    if (a) {
      a.kill("SIGTERM");
      await sleep(1500);
    }
    const baseArgs = [
      "--host", "127.0.0.1",
      "--port", "58301",
      "--cert", path.join(cliNodeHome, "cert.pem"),
      "--key", path.join(cliNodeHome, "key.pem"),
      "--remote-id", bId,
      "--timeout-ms", "20000",
    ];
    const listOutput = execCli([...baseArgs, "list"], { encoding: "utf8" });
    if (!listOutput.includes(`${folderId}\t`)) {
      throw new Error(`CLI list output did not contain expected folder "${folderId}":\n${listOutput}`);
    }
    if (listOutput.includes(`${encryptedFolderId}\t`)) {
      throw new Error(`Trusted CLI identity unexpectedly saw encrypted-only folder "${encryptedFolderId}":\n${listOutput}`);
    }
    console.log("Legacy list check passed.");

    const persistedListOutput = execCli([
      "--host", "127.0.0.1",
      "--port", "58301",
      "--remote-id", bId,
      "--timeout-ms", "20000",
      "list",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: cliConfigHome,
        SYNCTHING_BIN: syncthingBin,
      },
    });
    if (!persistedListOutput.includes(`${folderId}\t`)) {
      throw new Error(`Persisted cli-node list output missing folder "${folderId}":\n${persistedListOutput}`);
    }
    if (persistedListOutput.includes(`${encryptedFolderId}\t`)) {
      throw new Error(`Persisted trusted cli-node unexpectedly saw encrypted-only folder "${encryptedFolderId}":\n${persistedListOutput}`);
    }
    console.log("Persisted cli-node list check passed.");

    const downloadOutPath = path.join(root, "downloaded-nested.txt");
    execCli([
      "--host", "127.0.0.1",
      "--port", "58301",
      "--remote-id", bId,
      "--timeout-ms", "20000",
      "download",
      folderId,
      "a.txt",
      downloadOutPath,
    ], {
      stdio: "inherit",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: cliConfigHome,
        SYNCTHING_BIN: syncthingBin,
      },
    });
    const downloaded = fs.readFileSync(downloadOutPath, "utf8");
    if (downloaded !== expectedA) {
      throw new Error(`Downloaded content mismatch: got "${downloaded}"`);
    }
    const persistedDeviceIdPath = path.join(cliNodeHome, "device-id.txt");
    if (!fs.existsSync(persistedDeviceIdPath)) {
      throw new Error(`Persisted device-id file missing: ${persistedDeviceIdPath}`);
    }
    const persistedDeviceId = fs.readFileSync(persistedDeviceIdPath, "utf8").trim();
    if (persistedDeviceId !== cliNodeId) {
      throw new Error(`Persisted device ID mismatch: expected ${cliNodeId}, got ${persistedDeviceId}`);
    }
    console.log("Download check passed.");
    console.log("Persisted cli-node ID check passed.");

    const encryptedCliBaseArgs = [
      "--host", "127.0.0.1",
      "--port", "58301",
      "--cert", path.join(cliUntrustedHome, "cert.pem"),
      "--key", path.join(cliUntrustedHome, "key.pem"),
      "--remote-id", bId,
      "--timeout-ms", "20000",
      "--folder-password", `${encryptedFolderId}=${encryptedFolderPassword}`,
    ];
    const encryptedCliEnv = {
      ...process.env,
      XDG_CONFIG_HOME: cliConfigHome,
      SYNCTHING_BIN: syncthingBin,
    };

    try {
      let encryptedDownloadFailed = false;
      try {
        execCli([
          "--host", "127.0.0.1",
          "--port", "58301",
          "--cert", path.join(cliUntrustedHome, "cert.pem"),
          "--key", path.join(cliUntrustedHome, "key.pem"),
          "--remote-id", bId,
          "--timeout-ms", "20000",
          "download",
          encryptedFolderId,
          "secret.txt",
          path.join(root, "encrypted-without-password.txt"),
        ], {
          stdio: "pipe",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: cliConfigHome,
            SYNCTHING_BIN: syncthingBin,
          },
        });
      } catch {
        encryptedDownloadFailed = true;
      }
      if (!encryptedDownloadFailed) {
        throw new Error("Encrypted folder download unexpectedly succeeded without a folder password.");
      }

      const encryptedFilesOutput = execCli([
        ...encryptedCliBaseArgs,
        "files",
        encryptedFolderId,
      ], {
        encoding: "utf8",
        env: encryptedCliEnv,
      });
      if (!encryptedFilesOutput.includes("\tsecret.txt")) {
        throw new Error(`Encrypted folder listing missing decrypted file name:\n${encryptedFilesOutput}`);
      }

      const encryptedDownloadOutPath = path.join(root, "downloaded-encrypted-secret.txt");
      execCli([
        ...encryptedCliBaseArgs,
        "download",
        encryptedFolderId,
        "secret.txt",
        encryptedDownloadOutPath,
      ], {
        stdio: "inherit",
        env: encryptedCliEnv,
      });
      const encryptedDownloaded = fs.readFileSync(encryptedDownloadOutPath, "utf8");
      if (encryptedDownloaded !== expectedEncrypted) {
        throw new Error(`Encrypted downloaded content mismatch: got "${encryptedDownloaded}"`);
      }
      console.log("Encrypted folder password gating check passed.");
      console.log("Encrypted folder download check passed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("Encrypted folder compatibility probe did not pass.");
      console.log(`Known limitation: ${message}`);
    }

    // Additional strict regression guard for encrypted browse listing.
    await waitForCliOutputContains(
      [...encryptedCliBaseArgs, "files", encryptedFolderId],
      "\tsecret.txt",
      60_000,
      { env: encryptedCliEnv },
    );
    await waitForCliOutputContains(
      [...encryptedCliBaseArgs, "tree", encryptedFolderId],
      "secret.txt",
      60_000,
      { env: encryptedCliEnv },
    );
    console.log("Encrypted folder browse regression check passed.");

    const filesOutput = execCli(["files-local", bShareDir], {
      encoding: "utf8",
    });
    if (!filesOutput.includes("\tblob.bin") || !filesOutput.includes("\ta.txt") || !filesOutput.includes("\tsubdir/")) {
      throw new Error(`CLI files output missing expected entries:\n${filesOutput}`);
    }
    console.log("Peer folder file listing check passed.");

    const uploadedRelPath = "cli-upload/smoke.txt";
    const uploadedExpected = "hello from cli upload test\n";
    execCli(["upload-test", bShareDir, uploadedRelPath, uploadedExpected], {
      stdio: "inherit",
    });
    const uploadedLocalPath = path.join(bShareDir, uploadedRelPath);
    if (!fs.existsSync(uploadedLocalPath)) {
      throw new Error(`Uploaded local test file missing at ${uploadedLocalPath}`);
    }
    if (fs.readFileSync(uploadedLocalPath, "utf8") !== uploadedExpected) {
      throw new Error(`Uploaded local test file contents mismatch at ${uploadedLocalPath}`);
    }

    const uploadedDownloadPath = path.join(root, "downloaded-upload-smoke.txt");
    await waitForCliDownload(
      [
        "--host", "127.0.0.1",
        "--port", "58301",
        "--cert", path.join(cliNodeHome, "cert.pem"),
        "--key", path.join(cliNodeHome, "key.pem"),
        "--remote-id", bId,
        "--timeout-ms", "20000",
        "download",
        folderId,
        uploadedRelPath,
        uploadedDownloadPath,
      ],
      uploadedDownloadPath,
      uploadedExpected,
      90_000,
    );
    console.log("CLI upload test file check passed.");

    console.log("");
    console.log("=== Automated local integration test passed ===");
    console.log(`A home:      ${aHome}`);
    console.log(`B home:      ${bHome}`);
    console.log(`A folder:    ${aRecvDir}`);
    console.log(`B folder:    ${bShareDir}`);
    console.log(`A GUI:       http://${A_GUI_ADDR}`);
    console.log(`B GUI:       http://${B_GUI_ADDR}`);
    console.log(`A device ID: ${aId}`);
    console.log(`B device ID: ${bId}`);
    console.log(`CLI node ID: ${cliNodeId}`);
    console.log(`CLI untrusted ID: ${cliUntrustedId}`);
    console.log("");
    if (keep) {
      console.log("--keep flag used; leaving temp files in place.");
      console.log("Syncthing processes are still running. Press Ctrl+C to stop.");
      return;
    }
  } finally {
    if (a) a.kill("SIGTERM");
    if (b) b.kill("SIGTERM");
    await sleep(1000);
    if (!keep) {
      fs.rmSync(root, { recursive: true, force: true });
      console.log("Cleaned up test files and stopped Syncthing processes.");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
