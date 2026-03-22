import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

/*
 * Local Syncthing test harness
 *
 * This script sets up two isolated Syncthing homes under .tmp/syncpeer-test,
 * generates device certificates, creates a shared folder with some files,
 * starts both Syncthing instances and prints instructions for the next
 * manual steps and the CLI commands to run. It does not perform any
 * interaction with the syncpeer CLI itself; you must use the printed
 * instructions after starting the instances.
 */

const keep = process.argv.includes('--keep');
const root = path.resolve('.tmp/syncpeer-test');
const aHome = path.join(root, 'st-a');
const bHome = path.join(root, 'st-b');
const shareDir = path.join(root, 'share-b');
const toolsDir = path.resolve('.tools');
const version = process.env.SYNCTHING_VERSION ?? 'v1.27.8';

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

function startSyncthing(home: string, gui: string) {
  const args = [
    '-home', home,
    '-gui-address', gui,
    '-no-default-folder',
    '-no-browser',
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
  const out = execFileSync(syncthingBin, ['cli', '--home', home, 'show', 'system'], {
    encoding: 'utf8',
  });
  const match = out.match(/Device ID:\s*(.+)/);
  if (!match) {
    throw new Error(`Could not parse device ID from:\n${out}`);
  }
  return match[1].trim();
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

  fs.rmSync(root, { recursive: true, force: true });
  ensureDir(aHome);
  ensureDir(bHome);
  ensureDir(shareDir);

  writeFile(path.join(shareDir, 'a.txt'), 'hello from syncthing test\n');
  writeFile(path.join(shareDir, 'subdir', 'nested.txt'), 'nested file\n');
  writeFile(path.join(shareDir, 'blob.bin'), randomBuffer(300 * 1024));

  console.log('Bootstrapping Syncthing homes...');
  execFileSync(syncthingBin, ['generate', '--home', aHome], { stdio: 'inherit' });
  execFileSync(syncthingBin, ['generate', '--home', bHome], { stdio: 'inherit' });

  const a = startSyncthing(aHome, '127.0.0.1:8384');
  const b = startSyncthing(bHome, '127.0.0.1:8385');

  // Wait a few seconds for Syncthing to start up and write device IDs
  await sleep(4000);

  const aId = readDeviceId(aHome);
  const bId = readDeviceId(bHome);

  console.log('');
  console.log('=== Local test environment ready ===');
  console.log(`A home:      ${aHome}`);
  console.log(`B home:      ${bHome}`);
  console.log(`Share dir:   ${shareDir}`);
  console.log(`A GUI:       http://127.0.0.1:8384`);
  console.log(`B GUI:       http://127.0.0.1:8385`);
  console.log(`A device ID: ${aId}`);
  console.log(`B device ID: ${bId}`);
  console.log('');
  console.log('Next manual steps:');
  console.log('1. Open the GUIs and add device B to A, and device A to B.');
  console.log('2. In B, add/share the folder:');
  console.log(`   path = ${shareDir}`);
  console.log('3. Share it to device A.');
  console.log('4. Note the folder ID.');
  console.log('');
  console.log('Then test your CLI like this:');
  console.log('');
  console.log(`npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert ${path.join(aHome, 'cert.pem')} --key ${path.join(aHome, 'key.pem')} --remote-id "${bId}" list`);
  console.log(`npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert ${path.join(aHome, 'cert.pem')} --key ${path.join(aHome, 'key.pem')} --remote-id "${bId}" tree <folder-id>`);
  console.log(`npx tsx src/cli/main.ts --host 127.0.0.1 --port 22000 --cert ${path.join(aHome, 'cert.pem')} --key ${path.join(aHome, 'key.pem')} --remote-id "${bId}" download <folder-id> a.txt ./out.txt`);
  console.log('');
  if (!keep) {
    console.log('Processes are running. Press Ctrl+C to stop.');
  } else {
    console.log('--keep flag used; leaving temp files in place.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});