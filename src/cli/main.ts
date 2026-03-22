#!/usr/bin/env node
import { Command } from 'commander';
import { connectAndSync } from '../client.js';
import type RemoteFs from '../core/model/remoteFs.js';
import fs from 'fs';

const program = new Command();

program
  .name('syncpeer')
  .description('Minimal Syncthing BEP client')
  .option('-H, --host <host>', 'remote host', '127.0.0.1')
  .option('-p, --port <port>', 'remote port', (v) => parseInt(v, 10), 22000)
  .option('--cert <path>', 'path to client certificate (PEM)', process.env.SYNCTHING_CERT)
  .option('--key <path>', 'path to client key (PEM)', process.env.SYNCTHING_KEY)
  .option('--ca <path>', 'path to CA certificate (PEM)')
  .option('--remote-id <id>', 'expected remote device ID')
  .option('--device-name <name>', 'our device name', 'syncpeer')
  .option('--client-name <name>', 'client name sent in hello', 'syncpeer')
  .option('--client-version <version>', 'client version sent in hello', '0.1.0');

program
  .command('list')
  .description('List remote folders')
  .action(async () => {
    const opts = program.opts();
    const fsremote = await createRemoteFs(opts);
    const folders = await fsremote.listFolders();
    for (const f of folders) {
      console.log(`${f.id}\t${f.label}${f.readOnly ? ' (read‑only)' : ''}`);
    }
    process.exit(0);
  });

program
  .command('tree <folder>')
  .description('Display a directory tree for a folder')
  .option('-d, --dir <dir>', 'subdirectory within the folder', '')
  .action(async (folder: string, cmdObj: any) => {
    const opts = program.opts();
    const dir = cmdObj.dir ?? '';
    const fsremote = await createRemoteFs(opts);
    await printTree(fsremote, folder, dir, '');
    process.exit(0);
  });

program
  .command('download <folder> <path> <output>')
  .description('Download a file from the remote device')
  .action(async (folder: string, filePath: string, output: string) => {
    const opts = program.opts();
    const fsremote = await createRemoteFs(opts);
    const data = await fsremote.readFileFully(folder, filePath);
    fs.writeFileSync(output, Buffer.from(data));
    console.log(`Downloaded ${filePath} to ${output}`);
    process.exit(0);
  });

/**
 * Connect to the remote peer using command line options and return a RemoteFs.
 */
async function createRemoteFs(opts: any): Promise<RemoteFs> {
    if (!opts.cert || !opts.key) {
      console.error('Both --cert and --key must be provided');
      process.exit(1);
    }
    const remoteFs = await connectAndSync({
      host: opts.host,
      port: opts.port,
      cert: opts.cert,
      key: opts.key,
      ca: opts.ca,
      expectedDeviceId: opts.remoteId,
      deviceName: opts.deviceName,
      clientName: opts.clientName,
      clientVersion: opts.clientVersion,
    });
    return remoteFs;
}

/**
 * Recursively print a directory tree.  The prefix parameter controls the
 * indentation for nested directories.
 */
async function printTree(fsremote: RemoteFs, folder: string, dir: string, prefix: string): Promise<void> {
  const entries = await fsremote.readDir(folder, dir);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    console.log(`${prefix}${branch}${entry.name}${entry.type === 'directory' ? '/' : ''}`);
    if (entry.type === 'directory') {
      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      const subPath = dir ? `${dir}/${entry.name}` : entry.name;
      await printTree(fsremote, folder, subPath, newPrefix);
    }
  }
}

program.parseAsync(process.argv);