#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import { connectAndSync } from "../client.js";

interface CliOptions {
  host: string;
  port: number;
  cert?: string;
  key?: string;
  remoteId?: string;
  deviceName: string;
  timeoutMs: number;
}

function requiredPath(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

async function openRemoteFs(opts: CliOptions) {
  const cert = requiredPath("cert", opts.cert);
  const key = requiredPath("key", opts.key);
  const connectPromise = connectAndSync({
    host: opts.host,
    port: opts.port,
    cert,
    key,
    expectedDeviceId: opts.remoteId,
    deviceName: opts.deviceName,
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Connection timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
  });
  return Promise.race([connectPromise, timeoutPromise]);
}

async function renderTree(
  readDir: (path: string) => Promise<Array<{ name: string; path: string; type: string }>>,
  base: string,
  prefix: string,
): Promise<string[]> {
  const entries = await readDir(base);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const nextPrefix = prefix + (isLast ? "    " : "│   ");
    const label = entry.type === "directory" ? `${entry.name}/` : entry.name;
    out.push(prefix + branch + label);
    if (entry.type === "directory") {
      const childLines = await renderTree(readDir, entry.path, nextPrefix);
      out.push(...childLines);
    }
  }
  return out;
}

async function main() {
  const program = new Command();
  program
    .name("syncpeer")
    .description("Read-only Syncthing BEP client")
    .option("--host <host>", "Remote host", "127.0.0.1")
    .option("--port <port>", "Remote port", (value) => parseInt(value, 10), 22000)
    .option("--cert <file>", "Path to TLS certificate")
    .option("--key <file>", "Path to TLS private key")
    .option("--remote-id <id>", "Expected remote device ID")
    .option("--device-name <name>", "Client device name", "syncpeer-cli")
    .option("--timeout-ms <ms>", "Connection timeout in milliseconds", (value) => parseInt(value, 10), 15000);

  program
    .command("list")
    .description("List available folders on the remote peer")
    .action(async () => {
      const opts = program.opts<CliOptions>();
      const remoteFs = await openRemoteFs(opts);
      const folders = await remoteFs.listFolders();
      for (const folder of folders) {
        const mode = folder.readOnly ? "ro" : "rw";
        console.log(`${folder.id}\t${mode}\t${folder.label}`);
      }
    });

  program
    .command("tree <folderId>")
    .description("Show a tree of files in the specified folder")
    .action(async (folderId: string) => {
      const opts = program.opts<CliOptions>();
      const remoteFs = await openRemoteFs(opts);
      console.log(`${folderId}/`);
      const lines = await renderTree(
        async (targetPath) => remoteFs.readDir(folderId, targetPath),
        "",
        "",
      );
      for (const line of lines) {
        console.log(line);
      }
    });

  program
    .command("download <folderId> <remotePath> <localPath>")
    .description("Download a file from the remote peer")
    .action(async (folderId: string, remotePath: string, localPath: string) => {
      const opts = program.opts<CliOptions>();
      const remoteFs = await openRemoteFs(opts);
      const bytes = await remoteFs.readFileFully(folderId, remotePath);
      fs.writeFileSync(localPath, Buffer.from(bytes));
      console.log(`Wrote ${bytes.length} bytes to ${localPath}`);
    });

  await program.parseAsync(process.argv);
  // The current client keeps an active BEP socket open. Explicitly exit for CLI usage.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
