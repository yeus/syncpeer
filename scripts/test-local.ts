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
const skipEncryptedChecks = process.argv.includes("--skip-encrypted");
const parseDownloadIterations = (): number => {
  const index = process.argv.indexOf("--download-iterations");
  if (index < 0) return 1;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
};
const downloadIterations = parseDownloadIterations();
const root = path.resolve(".tmp/syncpeer-test");
const aHome = path.join(root, "st-a");
const bHome = path.join(root, "st-b");
const folderId = "syncpeer-test";
const noiseFolderAId = "syncpeer-noise-a";
const noiseFolderBId = "syncpeer-noise-b";
const encryptedFolderId = "syncpeer-encrypted";
const lockedEncryptedFolderId = "syncpeer-encrypted-locked";
const bShareDir = path.join(root, "share-b");
const aRecvDir = path.join(root, "share-a");
const bNoiseShareADir = path.join(root, "share-b-noise-a");
const aNoiseRecvADir = path.join(root, "share-a-noise-a");
const bNoiseShareBDir = path.join(root, "share-b-noise-b");
const aNoiseRecvBDir = path.join(root, "share-a-noise-b");
const bEncryptedShareDir = path.join(root, "share-b-encrypted");
const bLockedEncryptedShareDir = path.join(root, "share-b-encrypted-locked");
const cliConfigHome = path.join(root, "xdg-config");
const cliNodeHome = path.join(cliConfigHome, "syncpeer", "cli-node");
const cliUntrustedHome = path.join(root, "cli-untrusted-node");
const cliObserverHome = path.join(root, "cli-observer-node");
const encryptedFolderPassword = "correct horse battery staple";
const lockedEncryptedFolderPassword = "a different folder password";
const toolsDir = path.resolve(".tools");
const version = process.env.SYNCTHING_VERSION ?? "v2.1.2";
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
  const block = `    <folder id="${escapeXml(id)}" label="${escapeXml(label)}" path="${escapeXml(folderPath)}" type="${escapeXml(type)}" rescanIntervalS="1" fsWatcherEnabled="false" fsWatcherDelayS="10" fsWatcherTimeoutS="0" ignorePerms="false" autoNormalize="true">
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

function execCliAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliEntry, ...args], {
      stdio: "inherit",
      env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `CLI exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}`,
        ),
      );
    });
  });
}

function normalizeDeviceId(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
}

async function waitForFolderDeviceAdvertisement(options) {
  const {
    introducerHost,
    introducerPort,
    introducerDeviceId,
    localCertPath,
    localKeyPath,
    localDeviceName,
    expectedFolderId,
    expectedDeviceId,
    expectedAdvertised,
    timeoutMs,
  } = options;
  const expectedDevice = normalizeDeviceId(expectedDeviceId);
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    let session = null;
    try {
      const nodeModule = await import("../packages/core/dist/node.js").catch(() =>
        import("../packages/core/src/node.ts")
      );
      const { createNodeSyncpeerClient } = nodeModule;
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
        const matched = advertised.find((device) => device.id === expectedDevice);
        if (expectedAdvertised && matched) {
          return {
            deviceId: matched.id,
            deviceName: matched.name,
          };
        }
        if (!expectedAdvertised && !matched) return null;
        lastErr = new Error(
          `Folder "${expectedFolderId}" ${expectedAdvertised ? "did not advertise" : "unexpectedly advertised"} device ${expectedDevice}. Advertised: ${advertised.map((item) => item.id).join(", ")}`,
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
    `Timed out waiting for folder device advertisement: ${String(lastErr)}`,
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

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function runBackgroundFolderChurn(options) {
  const { dirs, durationMs, intervalMs, shouldContinue } = options;
  const startMs = Date.now();
  let tick = 0;
  while (Date.now() - startMs < durationMs && shouldContinue()) {
    for (const dir of dirs) {
      const base = `noise-${tick}-${Math.floor(Math.random() * 100000)}`;
      writeFile(path.join(dir, `${base}.txt`), `tick=${tick}\nnow=${Date.now()}\n`);
      if (tick % 3 === 0) {
        const entries = fs.readdirSync(dir).filter((name) => name.startsWith(`noise-${Math.max(0, tick - 3)}-`));
        for (const entry of entries) {
          try {
            fs.rmSync(path.join(dir, entry), { force: true });
          } catch {
            // best effort
          }
        }
      }
    }
    tick += 1;
    await sleep(intervalMs);
  }
  return tick;
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

function assertSyncthingAvailable() {
  if (!fs.existsSync(syncthingBin)) {
    console.error(`Missing Syncthing binary: ${syncthingBin}`);
    console.error("Run: npm run download:syncthing");
    process.exit(1);
  }
}

function prepareDirectories() {
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  for (const directory of [
    aHome,
    bHome,
    aRecvDir,
    bShareDir,
    aNoiseRecvADir,
    bNoiseShareADir,
    aNoiseRecvBDir,
    bNoiseShareBDir,
    bEncryptedShareDir,
    bLockedEncryptedShareDir,
    cliNodeHome,
    cliUntrustedHome,
    cliObserverHome,
  ])
    ensureDir(directory);
}

function seedTestFiles() {
  const expectedA = "hello from syncthing test\n";
  const expectedEncrypted = "super secret from encrypted folder\n";
  writeFile(path.join(bShareDir, "a.txt"), expectedA);
  writeFile(path.join(bShareDir, "subdir", "nested.txt"), "nested file\n");
  writeFile(path.join(bShareDir, "blob.bin"), randomBuffer(300 * 1024));
  writeFile(path.join(bNoiseShareADir, "seed.txt"), "seed noise a\n");
  writeFile(path.join(bNoiseShareBDir, "seed.txt"), "seed noise b\n");
  writeFile(path.join(bEncryptedShareDir, "secret.txt"), expectedEncrypted);
  writeFile(
    path.join(bLockedEncryptedShareDir, "hidden.txt"),
    "locked folder secret\n",
  );
  return { expectedA, expectedEncrypted };
}

function generateHome(home) {
  execFileSync(
    syncthingBin,
    ["generate", "--home", home, "--no-port-probing"],
    {
      stdio: "inherit",
    },
  );
}

function createTestIdentities() {
  console.log("Bootstrapping Syncthing homes...");
  generateHome(aHome);
  generateHome(bHome);
  const aId = readDeviceId(aHome);
  const bId = readDeviceId(bHome);

  console.log("Preparing persisted cli-node identity...");
  generateHome(cliNodeHome);
  const cliNodeId = readDeviceId(cliNodeHome);
  generateHome(cliUntrustedHome);
  const cliUntrustedId = readDeviceId(cliUntrustedHome);
  generateHome(cliObserverHome);
  const cliObserverId = readDeviceId(cliObserverHome);
  return { aId, bId, cliNodeId, cliUntrustedId, cliObserverId };
}

function folderConfig(id, folderPath, type, deviceIds, encryptionPasswords) {
  return {
    id,
    label: id,
    path: folderPath,
    type,
    deviceIds,
    ...(encryptionPasswords ? { encryptionPasswords } : {}),
  };
}

function encryptedPasswords(ids, password) {
  return {
    [ids.cliUntrustedId]: password,
    [ids.cliObserverId]: password,
  };
}

function createAHomeOptions(ids) {
  return {
    guiAddress: A_GUI_ADDR,
    listenAddress: A_SYNC_ADDR,
    remoteDevices: [
      { id: ids.bId, name: "syncpeer-b", address: B_SYNC_ADDR },
      { id: ids.cliNodeId, name: "syncpeer-cli-node", address: "dynamic" },
    ],
    folders: [
      folderConfig(folderId, aRecvDir, "sendreceive", [
        ids.aId,
        ids.bId,
        ids.cliNodeId,
      ]),
      folderConfig(noiseFolderAId, aNoiseRecvADir, "sendreceive", [
        ids.aId,
        ids.bId,
        ids.cliNodeId,
      ]),
      folderConfig(noiseFolderBId, aNoiseRecvBDir, "sendreceive", [
        ids.aId,
        ids.bId,
        ids.cliNodeId,
      ]),
    ],
  };
}

function createBHomeOptions(ids) {
  return {
    guiAddress: B_GUI_ADDR,
    listenAddress: B_SYNC_ADDR,
    remoteDevices: [
      { id: ids.aId, name: "syncpeer-a", address: A_SYNC_ADDR },
      { id: ids.cliNodeId, name: "syncpeer-cli-node", address: "dynamic" },
      {
        id: ids.cliUntrustedId,
        name: "syncpeer-cli-untrusted",
        address: "dynamic",
        untrusted: true,
      },
      {
        id: ids.cliObserverId,
        name: "syncpeer-cli-observer",
        address: "dynamic",
        untrusted: true,
      },
    ],
    folders: [
      folderConfig(folderId, bShareDir, "sendonly", [
        ids.bId,
        ids.aId,
        ids.cliNodeId,
      ]),
      folderConfig(noiseFolderAId, bNoiseShareADir, "sendonly", [
        ids.bId,
        ids.aId,
        ids.cliNodeId,
      ]),
      folderConfig(noiseFolderBId, bNoiseShareBDir, "sendonly", [
        ids.bId,
        ids.aId,
        ids.cliNodeId,
      ]),
      folderConfig(
        encryptedFolderId,
        bEncryptedShareDir,
        "sendonly",
        [ids.bId, ids.cliUntrustedId, ids.cliObserverId],
        encryptedPasswords(ids, encryptedFolderPassword),
      ),
      folderConfig(
        lockedEncryptedFolderId,
        bLockedEncryptedShareDir,
        "sendonly",
        [ids.bId, ids.cliUntrustedId, ids.cliObserverId],
        encryptedPasswords(ids, lockedEncryptedFolderPassword),
      ),
    ],
  };
}

function configureTestHomes(ids) {
  configureHome(aHome, createAHomeOptions(ids));
  configureHome(bHome, createBHomeOptions(ids));
}

function prepareFixture() {
  assertSyncthingAvailable();
  prepareDirectories();
  const files = seedTestFiles();
  console.log("Building CLI packages...");
  execFileSync(npmCmd, ["run", "build:cli"], { stdio: "inherit" });
  const identities = createTestIdentities();
  configureTestHomes(identities);
  return { ...files, ...identities };
}

function stopProcess(child) {
  if (child) child.kill("SIGTERM");
}

async function waitForInitialSync({ expectedA }) {
  await sleep(3000);
  await waitForSync(path.join(aRecvDir, "a.txt"), expectedA, 90_000);
  await waitForSync(
    path.join(aRecvDir, "subdir", "nested.txt"),
    "nested file\n",
    90_000,
  );
  await waitForSync(
    path.join(aNoiseRecvADir, "seed.txt"),
    "seed noise a\n",
    90_000,
  );
  await waitForSync(
    path.join(aNoiseRecvBDir, "seed.txt"),
    "seed noise b\n",
    90_000,
  );
}

function cliArgs({ port = 58301, remoteId, certHome, folderPassword }) {
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--discovery-mode",
    "direct",
    ...(certHome
      ? [
          "--cert",
          path.join(certHome, "cert.pem"),
          "--key",
          path.join(certHome, "key.pem"),
        ]
      : []),
    "--remote-id",
    remoteId,
    "--timeout-ms",
    "20000",
    ...(folderPassword ? ["--folder-password", folderPassword] : []),
  ];
}

function cliEnvironment() {
  return {
    ...process.env,
    XDG_CONFIG_HOME: cliConfigHome,
    SYNCTHING_BIN: syncthingBin,
  };
}

async function runUploadCheck({ aId }) {
  const payload = `hello_from_syncpeer ${new Date().toISOString()}\n`;
  const uploadSourcePath = path.join(root, "hello_from_syncpeer.txt");
  writeFile(uploadSourcePath, payload);
  const args = cliArgs({ port: 58300, remoteId: aId, certHome: cliNodeHome });
  execCli(
    [
      ...args,
      "upload",
      "--serve-ms",
      "45000",
      folderId,
      uploadSourcePath,
      "cli-upload/hello_from_syncpeer.txt",
    ],
    { stdio: "inherit" },
  );
  await waitForSync(
    path.join(aRecvDir, "cli-upload", "hello_from_syncpeer.txt"),
    payload,
    90_000,
  );

  const roundtripPath = path.join(root, "roundtrip-upload.txt");
  execCli(
    [
      ...args,
      "download",
      folderId,
      "cli-upload/hello_from_syncpeer.txt",
      roundtripPath,
    ],
    { stdio: "inherit" },
  );
  const roundtrip = fs.readFileSync(roundtripPath, "utf8");
  if (roundtrip !== payload)
    throw new Error(`Uploaded roundtrip mismatch: got "${roundtrip}"`);
  console.log("Remote upload smoke check passed.");
}

async function runIntroducerAdvertisementCheck({ aId, bId }) {
  const result = await waitForFolderDeviceAdvertisement({
    introducerHost: "127.0.0.1",
    introducerPort: 58300,
    introducerDeviceId: aId,
    localCertPath: path.join(cliNodeHome, "cert.pem"),
    localKeyPath: path.join(cliNodeHome, "key.pem"),
    localDeviceName: "syncpeer-cli-introducer-check",
    expectedFolderId: folderId,
    expectedDeviceId: bId,
    expectedAdvertised: true,
    timeoutMs: 60_000,
  });
  if (result?.deviceId !== normalizeDeviceId(bId))
    throw new Error(
      `Introducer advertisement device ID mismatch: expected ${normalizeDeviceId(bId)}, got ${result?.deviceId}`,
    );
  console.log("Introducer advertisement check passed.");
}

async function runUntrustedAdvertisementCheck({ bId, cliUntrustedId }) {
  await waitForFolderDeviceAdvertisement({
    introducerHost: "127.0.0.1",
    introducerPort: 58301,
    introducerDeviceId: bId,
    localCertPath: path.join(cliObserverHome, "cert.pem"),
    localKeyPath: path.join(cliObserverHome, "key.pem"),
    localDeviceName: "syncpeer-cli-untrusted-probe",
    expectedFolderId: encryptedFolderId,
    expectedDeviceId: cliUntrustedId,
    expectedAdvertised: false,
    timeoutMs: 60_000,
  });
  console.log("Untrusted device redaction check passed.");
}

async function runAdvertisementChecks(ids) {
  await runIntroducerAdvertisementCheck(ids);
  await runUntrustedAdvertisementCheck(ids);
}

async function createSessionStore() {
  const nodeModule = await import("../packages/core/dist/index.js").catch(
    () => import("../packages/core/src/index.ts"),
  );
  const sessionTraceEvents = [];
  const sessionStore = nodeModule.createSyncpeerSessionStore({
    transport: nodeModule.createNodeSessionTransport(),
    onTrace: (entry) => sessionTraceEvents.push(entry),
  });
  return { sessionStore, sessionTraceEvents };
}

function createSessionOptions(bId) {
  return {
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
}

async function openSessionFolder(sessionStore, options) {
  await sessionStore.actions.connect(options);
  await sessionStore.actions.openFolder(folderId, options);
  return sessionStore.getState();
}

function assertSessionEntries(state, names, message) {
  const entries = new Set(state.entries.map((entry) => entry.path));
  for (const name of names)
    if (!entries.has(name))
      throw new Error(`${message}: ${[...entries].join(", ")}`);
}

async function waitForSessionEntry(sessionStore, options, name) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sessionStore.actions.reloadCurrentDirectory(options);
    const state = sessionStore.getState();
    if (
      state.directory.status === "ready" &&
      state.entries.some((entry) => entry.path === name)
    )
      return;
    await sleep(300);
  }
  throw new Error(
    "Session-store stale->ready flow did not settle with new file visible.",
  );
}

async function runSessionStoreChecks({ bId }) {
  console.log("\n=== Running core session-store parity checks ===");
  const { sessionStore, sessionTraceEvents } = await createSessionStore();
  const options = createSessionOptions(bId);
  let state = await openSessionFolder(sessionStore, options);
  if (!state.folders.some((folder) => folder.id === folderId))
    throw new Error(`Session-store folder list missing ${folderId}.`);
  assertSessionEntries(
    state,
    ["a.txt", "subdir"],
    "Session-store root listing missing entry",
  );

  await sessionStore.actions.disconnect();
  state = await openSessionFolder(sessionStore, options);
  assertSessionEntries(
    state,
    ["a.txt"],
    "Session-store reconnect listing missing entry",
  );

  const staleProbeName = `stale-probe-${Date.now()}.txt`;
  writeFile(
    path.join(bShareDir, staleProbeName),
    `probe ${new Date().toISOString()}\n`,
  );
  await sessionStore.actions.refreshOverview(options);
  await waitForSessionEntry(sessionStore, options, staleProbeName);
  await sessionStore.actions.disconnect();
  console.log(
    `Core session-store parity check passed (${sessionTraceEvents.length} trace events).`,
  );
}

function createCliContext({ bId }) {
  const trustedArgs = cliArgs({ remoteId: bId, certHome: cliNodeHome });
  const persistedArgs = cliArgs({ remoteId: bId });
  const encryptedArgs = cliArgs({
    remoteId: bId,
    certHome: cliUntrustedHome,
    folderPassword: `${encryptedFolderId}=${encryptedFolderPassword}`,
  });
  const encryptedProbeArgs = cliArgs({
    remoteId: bId,
    certHome: cliUntrustedHome,
  });
  return {
    trustedArgs,
    persistedArgs,
    encryptedArgs,
    encryptedProbeArgs,
    env: cliEnvironment(),
  };
}

function assertTrustedFolderList(output, label) {
  if (!output.includes(`${folderId}\t`))
    throw new Error(`${label} missing folder "${folderId}":\n${output}`);
  if (output.includes(`${encryptedFolderId}\t`))
    throw new Error(
      `${label} saw encrypted-only folder "${encryptedFolderId}":\n${output}`,
    );
}

async function runListChecks({ trustedArgs, persistedArgs, env }) {
  const listOutput = execCli([...trustedArgs, "list"], { encoding: "utf8" });
  assertTrustedFolderList(listOutput, "CLI list output");
  console.log("Legacy list check passed.");
  const persistedOutput = execCli([...persistedArgs, "list"], {
    encoding: "utf8",
    env,
  });
  assertTrustedFolderList(persistedOutput, "Persisted cli-node list output");
  console.log("Persisted cli-node list check passed.");
}

function downloadArgs(baseArgs, relativePath, outputPath) {
  return [...baseArgs, "download", folderId, relativePath, outputPath];
}

async function runRepeatedDownloads({ trustedArgs, env, expectedA }) {
  for (let iteration = 1; iteration <= downloadIterations; iteration += 1) {
    const outputPath = path.join(root, `downloaded-nested-${iteration}.txt`);
    execCli(downloadArgs(trustedArgs, "a.txt", outputPath), {
      stdio: "inherit",
      env,
    });
    const downloaded = fs.readFileSync(outputPath, "utf8");
    if (downloaded !== expectedA)
      throw new Error(
        `Downloaded content mismatch on iteration ${iteration}: got "${downloaded}"`,
      );
  }
}

async function runStressedDownload({ trustedArgs, env }) {
  const outputPath = path.join(root, "downloaded-stress-blob.bin");
  const stressStartedAt = Date.now();
  let downloadInFlight = true;
  const downloadPromise = execCliAsync(
    downloadArgs(trustedArgs, "blob.bin", outputPath),
    env,
  ).finally(() => {
    downloadInFlight = false;
  });
  const [, churnTicks] = await Promise.all([
    downloadPromise,
    runBackgroundFolderChurn({
      dirs: [bNoiseShareADir, bNoiseShareBDir],
      durationMs: 18_000,
      intervalMs: 120,
      shouldContinue: () => downloadInFlight,
    }),
  ]);
  if (churnTicks < 2)
    throw new Error(
      "Metadata churn did not continue while the download process ran.",
    );
  if (sha256File(path.join(bShareDir, "blob.bin")) !== sha256File(outputPath))
    throw new Error("Stressed download integrity mismatch for blob.bin.");
  console.log(
    `Download-under-index-churn check passed (${Date.now() - stressStartedAt} ms).`,
  );
}

function assertPersistedIdentity({ cliNodeId }) {
  const identityPath = path.join(cliNodeHome, "device-id.txt");
  if (!fs.existsSync(identityPath))
    throw new Error(`Persisted device-id file missing: ${identityPath}`);
  const persistedId = fs.readFileSync(identityPath, "utf8").trim();
  if (persistedId !== cliNodeId)
    throw new Error(
      `Persisted device ID mismatch: expected ${cliNodeId}, got ${persistedId}`,
    );
  console.log("Download check passed.");
  console.log("Persisted cli-node ID check passed.");
}

async function runDownloadChecks(context) {
  await runRepeatedDownloads(context);
  await runStressedDownload(context);
  assertPersistedIdentity(context);
}

function assertEncryptedDownloadBlocked({ encryptedProbeArgs, env }) {
  try {
    execCli(
      [
        ...encryptedProbeArgs,
        "download",
        encryptedFolderId,
        "secret.txt",
        path.join(root, "encrypted-without-password.txt"),
      ],
      {
        stdio: "pipe",
        env,
      },
    );
  } catch {
    return;
  }
  throw new Error(
    "Encrypted folder download unexpectedly succeeded without a folder password.",
  );
}

function verifyEncryptedDownload({ encryptedArgs, env, expectedEncrypted }) {
  const filesOutput = execCli([...encryptedArgs, "files", encryptedFolderId], {
    encoding: "utf8",
    env,
  });
  if (!filesOutput.includes("\tsecret.txt"))
    throw new Error(
      `Encrypted folder listing missing decrypted file name:\n${filesOutput}`,
    );
  const outputPath = path.join(root, "downloaded-encrypted-secret.txt");
  execCli(
    [...encryptedArgs, "download", encryptedFolderId, "secret.txt", outputPath],
    { stdio: "inherit", env },
  );
  const downloaded = fs.readFileSync(outputPath, "utf8");
  if (downloaded !== expectedEncrypted)
    throw new Error(
      `Encrypted downloaded content mismatch: got "${downloaded}"`,
    );
  console.log("Encrypted folder password gating check passed.");
  console.log("Encrypted folder download check passed.");
}

async function runEncryptedBrowseChecks({ encryptedArgs, env }) {
  await waitForCliOutputContains(
    [...encryptedArgs, "files", encryptedFolderId],
    "\tsecret.txt",
    60_000,
    { env },
  );
  await waitForCliOutputContains(
    [...encryptedArgs, "tree", encryptedFolderId],
    "secret.txt",
    60_000,
    { env },
  );
  console.log("Encrypted folder browse regression check passed.");
}

async function runEncryptedChecks({
  encryptedArgs,
  encryptedProbeArgs,
  env,
  expectedEncrypted,
}) {
  if (skipEncryptedChecks) {
    console.log("Skipping encrypted-folder checks (--skip-encrypted).");
    return;
  }
  try {
    assertEncryptedDownloadBlocked({ encryptedProbeArgs, env });
    verifyEncryptedDownload({ encryptedArgs, env, expectedEncrypted });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("Encrypted folder compatibility probe did not pass.");
    console.log(`Known limitation: ${message}`);
  }
  await runEncryptedBrowseChecks({ encryptedArgs, env });
}

function runLocalFileListingCheck() {
  const output = execCli(["files-local", bShareDir], { encoding: "utf8" });
  if (
    !output.includes("\tblob.bin") ||
    !output.includes("\ta.txt") ||
    !output.includes("\tsubdir/")
  )
    throw new Error(`CLI files output missing expected entries:\n${output}`);
  console.log("Peer folder file listing check passed.");
}

async function runLocalUploadCheck({ trustedArgs }) {
  const relativePath = "cli-upload/smoke.txt";
  const expected = "hello from cli upload test\n";
  execCli(["upload-test", bShareDir, relativePath, expected], {
    stdio: "inherit",
  });
  const localPath = path.join(bShareDir, relativePath);
  if (!fs.existsSync(localPath))
    throw new Error(`Uploaded local test file missing at ${localPath}`);
  if (fs.readFileSync(localPath, "utf8") !== expected)
    throw new Error(
      `Uploaded local test file contents mismatch at ${localPath}`,
    );
  await waitForCliDownload(
    downloadArgs(
      trustedArgs,
      relativePath,
      path.join(root, "downloaded-upload-smoke.txt"),
    ),
    path.join(root, "downloaded-upload-smoke.txt"),
    expected,
    90_000,
  );
  console.log("CLI upload test file check passed.");
}

async function runCliChecks(fixture, services) {
  console.log("\n=== Running syncpeer CLI checks ===");
  stopProcess(services.a);
  await sleep(1500);
  const context = { ...createCliContext(fixture), ...fixture };
  await runListChecks(context);
  await runDownloadChecks(context);
  await runEncryptedChecks(context);
  runLocalFileListingCheck();
  await runLocalUploadCheck(context);
}

function logSuccess({ aId, bId, cliNodeId, cliUntrustedId, cliObserverId }) {
  console.log("\n=== Automated local integration test passed ===");
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
  console.log(`CLI observer ID: ${cliObserverId}`);
  if (keep) {
    console.log("--keep flag used; leaving temp files in place.");
    console.log("Syncthing processes are still running. Press Ctrl+C to stop.");
  }
}

async function cleanupServices(services) {
  stopProcess(services?.a);
  stopProcess(services?.b);
  await sleep(1000);
  if (!keep) {
    fs.rmSync(root, { recursive: true, force: true });
    console.log("Cleaned up test files and stopped Syncthing processes.");
  }
}

async function main() {
  const fixture = prepareFixture();
  const services = { a: null, b: null };
  try {
    services.a = startSyncthing(aHome);
    services.b = startSyncthing(bHome);
    await waitForInitialSync(fixture);
    await runUploadCheck(fixture);
    await runAdvertisementChecks(fixture);
    await runSessionStoreChecks(fixture);
    await runCliChecks(fixture, services);
    logSuccess(fixture);
  } finally {
    await cleanupServices(services);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
