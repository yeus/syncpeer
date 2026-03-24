#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { connectAndSync } from "@syncpeer/core";
import { ensureCliNodeIdentity } from "./identity.js";

interface CliOptions {
  host: string;
  port: number;
  cert?: string;
  key?: string;
  remoteId?: string;
  deviceName: string;
  timeoutMs: number;
}

function normalizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) throw new Error(`Invalid relative path: ${input}`);
  return parts.join("/");
}

function listLocalDir(baseDir: string, dir: string): Array<{ type: string; path: string }> {
  const relative = normalizeRelativePath(dir);
  const rootPath = fs.realpathSync(baseDir);
  const targetPath = path.resolve(rootPath, relative);
  const relativeToRoot = path.relative(rootPath, targetPath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) throw new Error(`Directory escapes peerFolderPath: ${dir}`);
  if (!fs.existsSync(targetPath)) throw new Error(`Directory does not exist: ${targetPath}`);
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  const out = entries.map((entry) => {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    return {
      type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      path: entryRelative.replaceAll("\\", "/"),
    };
  });
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return out;
}

function requiredPath(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

async function openRemoteFs(opts: CliOptions) {
  let cert: string;
  let key: string;
  if (opts.cert || opts.key) {
    cert = requiredPath("cert", opts.cert);
    key = requiredPath("key", opts.key);
  } else {
    const identity = ensureCliNodeIdentity();
    cert = identity.cert;
    key = identity.key;
  }

  const connectPromise = connectAndSync({
    host: opts.host,
    port: opts.port,
    cert,
    key,
    expectedDeviceId: opts.remoteId,
    deviceName: opts.deviceName,
  } as any);

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
    .option("--cert <file>", "Path to TLS certificate (defaults to persisted cli-node identity)")
    .option("--key <file>", "Path to TLS private key (defaults to persisted cli-node identity)")
    .option("--remote-id <id>", "Expected remote device ID")
    .option("--device-name <name>", "Client device name", "syncpeer-cli")
    .option("--timeout-ms <ms>", "Connection timeout in milliseconds", (value) => parseInt(value, 10), 15000);

  program.command("list").description("List available folders on the remote peer").action(async () => {
    const opts = program.opts<CliOptions>();
    const remoteFs: any = await openRemoteFs(opts);
    const folders = await remoteFs.listFolders();
    for (const folder of folders) {
      const mode = folder.readOnly ? "ro" : "rw";
      console.log(`${folder.id}\t${mode}\t${folder.label}`);
    }
  });

  program.command("tree <folderId>").description("Show a tree of files in the specified folder").action(async (folderId: string) => {
    const opts = program.opts<CliOptions>();
    const remoteFs: any = await openRemoteFs(opts);
    console.log(`${folderId}/`);
    const lines = await renderTree(async (targetPath) => remoteFs.readDir(folderId, targetPath), "", "");
    for (const line of lines) console.log(line);
  });

  program.command("files <folderId> [dir]").description("List files from a peer folder directory").action(async (folderId: string, dir = "") => {
    const opts = program.opts<CliOptions>();
    const remoteFs: any = await openRemoteFs(opts);
    const entries = await remoteFs.readDir(folderId, dir);
    for (const entry of entries) {
      const suffix = entry.type === "directory" ? "/" : "";
      const type = entry.type.padEnd(9, " ");
      console.log(`${type}\t${entry.path}${suffix}`);
    }
  });

  program.command("download <folderId> <remotePath> <localPath>").description("Download a file from the remote peer").action(async (folderId: string, remotePath: string, localPath: string) => {
    const opts = program.opts<CliOptions>();
    const remoteFs: any = await openRemoteFs(opts);
    const bytes = await remoteFs.readFileFully(folderId, remotePath);
    fs.writeFileSync(localPath, Buffer.from(bytes));
    console.log(`Wrote ${bytes.length} bytes to ${localPath}`);
  });

  program.command("upload-test <peerFolderPath> <remotePath> [content]").description("Write a small test file directly into a local peer folder path").action((peerFolderPath: string, remotePath: string, content?: string) => {
    const relative = normalizeRelativePath(remotePath);
    if (!relative) throw new Error("remotePath must not be empty");
    const targetPath = fs.realpathSync(peerFolderPath);
    const outPath = path.resolve(targetPath, relative);
    const relativeToRoot = path.relative(targetPath, outPath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) throw new Error(`remotePath escapes peerFolderPath: ${remotePath}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const payload = content ?? "small upload from syncpeer cli\n";
    fs.writeFileSync(outPath, payload, "utf8");
    console.log(`Wrote ${Buffer.byteLength(payload, "utf8")} bytes to ${outPath}`);
  });

  program.command("files-local <peerFolderPath> [dir]").description("List files from a local peer folder path").action((peerFolderPath: string, dir = "") => {
    const entries = listLocalDir(peerFolderPath, dir);
    for (const entry of entries) {
      const suffix = entry.type === "directory" ? "/" : "";
      const type = entry.type.padEnd(9, " ");
      console.log(`${type}\t${entry.path}${suffix}`);
    }
  });

  program.command("local-id").description("Show the persisted local cli-node identity information").action(() => {
    const identity = ensureCliNodeIdentity();
    console.log(`configDir\t${identity.configDir}`);
    console.log(`cert\t${identity.cert}`);
    console.log(`key\t${identity.key}`);
    if (identity.deviceId) console.log(`deviceId\t${identity.deviceId}`);
    else console.log("deviceId\t(unavailable - Syncthing binary not found to resolve it)");
  });

  await program.parseAsync(process.argv);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
