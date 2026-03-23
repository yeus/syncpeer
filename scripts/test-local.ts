import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/*
 * Local fully-automated Syncthing integration test.
 * It creates two isolated homes, wires devices/folders without GUI usage,
 * waits for sync, then validates the syncpeer CLI against peer B.
 */

const keep = process.argv.includes('--keep');
const root = path.resolve('.tmp/syncpeer-test');
const aHome = path.join(root, 'st-a');
const bHome = path.join(root, 'st-b');
const folderId = 'syncpeer-test';
const bShareDir = path.join(root, 'share-b');
const aRecvDir = path.join(root, 'share-a');
const toolsDir = path.resolve('.tools');
const version = process.env.SYNCTHING_VERSION ?? 'v1.27.8';
const A_SYNC_ADDR = 'tcp://127.0.0.1:58300';
const B_SYNC_ADDR = 'tcp://127.0.0.1:58301';
const A_GUI_ADDR = '127.0.0.1:58384';
const B_GUI_ADDR = '127.0.0.1:58385';

const platformMap: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
};
const archMap: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
};

const platform = platformMap[process.platform];
const arch = archMap[process.arch];
if (!platform || !arch) {
  console.error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
  process.exit(1);
}
const syncthingDir = path.join(toolsDir, `syncthing-${platform}-${arch}-${version}`);
const syncthingBin = path.join(syncthingDir, 'syncthing');
const tsxBin = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string | Buffer) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content);
}

function randomBuffer(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

function startSyncthing(home: string) {
  const args = [
    'serve',
    '--home', home,
    '--no-browser',
    '--no-restart',
    '--no-upgrade',
  ];
  const child = spawn(syncthingBin, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      STNOUPGRADE: '1',
    },
  });
  return child;
}

function readDeviceId(home: string): string {
  const out = execFileSync(syncthingBin, ['device-id', '--home', home], {
    encoding: 'utf8',
  });
  const match = out.match(/([A-Z2-7]{7}(?:-[A-Z2-7]{7}){7})/);
  if (!match) {
    throw new Error(`Could not parse device ID from:\n${out}`);
  }
  return match[1].trim();
}

function escapeXml(v: string): string {
  return v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;');
}

function replaceGuiAddress(xml: string, guiAddress: string): string {
  return xml.replace(
    /(<gui\b[^>]*>[\s\S]*?<address>)([^<]*)(<\/address>)/,
    `$1${escapeXml(guiAddress)}$3`,
  );
}

function setSingleListenAddress(xml: string, address: string): string {
  return xml.replace(
    /<options>[\s\S]*?<\/options>/,
    (optsBlock) => {
      let out = optsBlock.replace(/^\s*<listenAddress>.*<\/listenAddress>\s*\n/gm, '');
      out = out.replace(
        /(<options>\s*\n)/,
        `$1        <listenAddress>${escapeXml(address)}</listenAddress>\n`,
      );
      return out;
    },
  );
}

function addTopLevelDevice(xml: string, deviceId: string, name: string, address: string): string {
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
        <untrusted>false</untrusted>
        <remoteGUIPort>0</remoteGUIPort>
        <numConnections>0</numConnections>
    </device>
`;
  return xml.replace(/(\s*<gui\b[\s\S]*$)/, `${block}$1`);
}

function addFolder(xml: string, id: string, label: string, folderPath: string, type: 'sendreceive' | 'sendonly', localDeviceId: string, remoteDeviceId: string): string {
  if (xml.includes(`<folder id="${id}"`)) {
    return xml;
  }
  const block = `    <folder id="${escapeXml(id)}" label="${escapeXml(label)}" path="${escapeXml(folderPath)}" type="${escapeXml(type)}" rescanIntervalS="30" fsWatcherEnabled="false" fsWatcherDelayS="10" fsWatcherTimeoutS="0" ignorePerms="false" autoNormalize="true">
        <filesystemType>basic</filesystemType>
        <device id="${escapeXml(localDeviceId)}" introducedBy="">
            <encryptionPassword></encryptionPassword>
        </device>
        <device id="${escapeXml(remoteDeviceId)}" introducedBy="">
            <encryptionPassword></encryptionPassword>
        </device>
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

function configureHome(
  home: string,
  opts: {
    guiAddress: string;
    listenAddress: string;
    localDeviceId: string;
    remoteDeviceId: string;
    remoteName: string;
    remoteAddress: string;
    folderPath: string;
    folderType: 'sendreceive' | 'sendonly';
  },
) {
  const configPath = path.join(home, 'config.xml');
  let xml = fs.readFileSync(configPath, 'utf8');
  xml = replaceGuiAddress(xml, opts.guiAddress);
  xml = setSingleListenAddress(xml, opts.listenAddress);
  xml = addTopLevelDevice(xml, opts.remoteDeviceId, opts.remoteName, opts.remoteAddress);
  xml = addFolder(xml, folderId, folderId, opts.folderPath, opts.folderType, opts.localDeviceId, opts.remoteDeviceId);
  fs.writeFileSync(configPath, xml);
}

async function waitForSync(filePath: string, expected: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content === expected) {
        return;
      }
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for synced file: ${filePath}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!fs.existsSync(syncthingBin)) {
    console.error(`Missing Syncthing binary: ${syncthingBin}`);
    console.error('Run: npm run download:syncthing');
    process.exit(1);
  }

  if (!keep) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  ensureDir(aHome);
  ensureDir(bHome);
  ensureDir(aRecvDir);
  ensureDir(bShareDir);

  const expectedA = 'hello from syncthing test\n';
  writeFile(path.join(bShareDir, 'a.txt'), expectedA);
  writeFile(path.join(bShareDir, 'subdir', 'nested.txt'), 'nested file\n');
  writeFile(path.join(bShareDir, 'blob.bin'), randomBuffer(300 * 1024));

  console.log('Bootstrapping Syncthing homes...');
  execFileSync(syncthingBin, ['generate', '--home', aHome, '--no-port-probing'], { stdio: 'inherit' });
  execFileSync(syncthingBin, ['generate', '--home', bHome, '--no-port-probing'], { stdio: 'inherit' });

  const aId = readDeviceId(aHome);
  const bId = readDeviceId(bHome);

  configureHome(aHome, {
    guiAddress: A_GUI_ADDR,
    listenAddress: A_SYNC_ADDR,
    localDeviceId: aId,
    remoteDeviceId: bId,
    remoteName: 'syncpeer-b',
    remoteAddress: B_SYNC_ADDR,
    folderPath: aRecvDir,
    folderType: 'sendreceive',
  });
  configureHome(bHome, {
    guiAddress: B_GUI_ADDR,
    listenAddress: B_SYNC_ADDR,
    localDeviceId: bId,
    remoteDeviceId: aId,
    remoteName: 'syncpeer-a',
    remoteAddress: A_SYNC_ADDR,
    folderPath: bShareDir,
    folderType: 'sendonly',
  });

  let a;
  let b;
  try {
    a = startSyncthing(aHome);
    b = startSyncthing(bHome);

    await sleep(3000);
    await waitForSync(path.join(aRecvDir, 'a.txt'), expectedA, 90_000);
    await waitForSync(path.join(aRecvDir, 'subdir', 'nested.txt'), 'nested file\n', 90_000);

    console.log('');
    console.log('=== Running syncpeer CLI checks ===');
    // Disconnect Syncthing A before using A's cert in the CLI client.
    if (a) {
      a.kill('SIGTERM');
      await sleep(1500);
    }
    const baseArgs = [
      'src/cli/main.ts',
      '--host', '127.0.0.1',
      '--port', '58301',
      '--cert', path.join(aHome, 'cert.pem'),
      '--key', path.join(aHome, 'key.pem'),
      '--remote-id', bId,
      '--timeout-ms', '20000',
    ];
    const listOutput = execFileSync(tsxBin, [...baseArgs, 'list'], {
      encoding: 'utf8',
    });
    if (!listOutput.includes(`${folderId}\t`)) {
      throw new Error(`CLI list output did not contain expected folder "${folderId}":\n${listOutput}`);
    }

    console.log('');
    console.log('=== Automated local integration test passed ===');
    console.log(`A home:      ${aHome}`);
    console.log(`B home:      ${bHome}`);
    console.log(`A folder:    ${aRecvDir}`);
    console.log(`B folder:    ${bShareDir}`);
    console.log(`A GUI:       http://${A_GUI_ADDR}`);
    console.log(`B GUI:       http://${B_GUI_ADDR}`);
    console.log(`A device ID: ${aId}`);
    console.log(`B device ID: ${bId}`);
    console.log('');
    if (keep) {
      console.log('--keep flag used; leaving temp files in place.');
      console.log('Syncthing processes are still running. Press Ctrl+C to stop.');
      return;
    }
  } finally {
    if (a) a.kill('SIGTERM');
    if (b) b.kill('SIGTERM');
    await sleep(1000);
    if (!keep) {
      fs.rmSync(root, { recursive: true, force: true });
      console.log('Cleaned up test files and stopped Syncthing processes.');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
