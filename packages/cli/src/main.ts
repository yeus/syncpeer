#!/usr/bin/env node
import { Command, Option } from "commander";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SharedFolder } from "@syncpeer/core";
import {
  createNodeSessionTransport,
  createNodeFileDownloadSink,
  DownloadInterruptedError,
  downloadRemoteFile,
  getDefaultDiscoveryServer,
  resolveNodeGlobalDiscovery,
} from "@syncpeer/core/node";
import { ensureCliNodeIdentity } from "./identity.js";
import { formatAppBuildInfo, getCliBuildInfo } from "./appInfo.js";

interface CliOptions {
  host: string;
  port: number;
  discoveryMode: "automatic" | "global" | "lan" | "direct";
  relayOnly: boolean;
  quicOnly: boolean;
  cert?: string;
  key?: string;
  remoteId?: string;
  discoveryServer?: string;
  deviceName: string;
  timeoutMs: number;
  folderPassword?: string[];
}

interface UploadCommandOptions {
  serveMs?: number;
}

interface ShareFolderCommandOptions {
  label?: string;
  password?: string;
  plaintext?: boolean;
  serveMs?: number;
}

const reexecuteWithNativeQuicIfAvailable = (): void => {
  const flag = "--experimental-quic";
  if (process.execArgv.includes(flag) || process.env.SYNCPEER_QUIC_REEXEC === "1") return;
  const probe = spawnSync(process.execPath, [
    flag,
    "--input-type=module",
    "--eval",
    "await import('node:quic')",
  ], { stdio: "ignore" });
  if (probe.status !== 0) return;
  const child = spawnSync(process.execPath, [flag, ...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, SYNCPEER_QUIC_REEXEC: "1" },
  });
  process.exit(child.status ?? 1);
};

function normalizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === ".."))
    throw new Error(`Invalid relative path: ${input}`);
  return parts.join("/");
}

function listLocalDir(
  baseDir: string,
  dir: string,
): Array<{ type: string; path: string }> {
  const relative = normalizeRelativePath(dir);
  const rootPath = fs.realpathSync(baseDir);
  const targetPath = path.resolve(rootPath, relative);
  const relativeToRoot = path.relative(rootPath, targetPath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot))
    throw new Error(`Directory escapes peerFolderPath: ${dir}`);
  if (!fs.existsSync(targetPath))
    throw new Error(`Directory does not exist: ${targetPath}`);
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  const out = entries.map((entry) => {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    return {
      type: entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : "file",
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

function parseFolderPasswords(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawValue of values ?? []) {
    const value = rawValue.trim();
    if (!value) continue;
    const separatorIndex = value.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(
        `Invalid --folder-password value "${rawValue}". Expected <folderId>=<password>.`,
      );
    }
    const folderId = value.slice(0, separatorIndex).trim();
    const password = value.slice(separatorIndex + 1).trim();
    if (!folderId || !password) {
      throw new Error(
        `Invalid --folder-password value "${rawValue}". Expected <folderId>=<password>.`,
      );
    }
    out[folderId] = password;
  }
  return out;
}

async function openRemoteFs(
  opts: CliOptions,
  sharedFolders?: SharedFolder[],
) {
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

  const transport = createNodeSessionTransport();
  const remoteFs = await transport.connectAndSync({
    host: opts.host,
    port: opts.port,
    cert,
    key,
    remoteId: opts.remoteId,
    deviceName: opts.deviceName,
    timeoutMs: opts.timeoutMs,
    discoveryMode: opts.discoveryMode,
    discoveryServer: opts.discoveryServer,
    enableRelayFallback: true,
    relayOnly: opts.relayOnly,
    quicOnly: opts.quicOnly,
    folderPasswords: parseFolderPasswords(opts.folderPassword),
    sharedFolders,
  });
  return {
    remoteFs,
    close: () => transport.disconnect?.(),
  };
}

function collectLocalFiles(
  rootPath: string,
  relativePath = "",
): Array<{ path: string; bytes: Uint8Array; modifiedMs: number }> {
  const directoryPath = path.join(rootPath, relativePath);
  const files: Array<{ path: string; bytes: Uint8Array; modifiedMs: number }> = [];
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const filePath = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectLocalFiles(rootPath, filePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = path.join(rootPath, filePath);
    files.push({
      path: filePath,
      bytes: new Uint8Array(fs.readFileSync(absolutePath)),
      modifiedMs: fs.statSync(absolutePath).mtimeMs,
    });
  }
  return files;
}

function generatedFolderPassword(): string {
  return randomBytes(24).toString("base64url");
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function renderTree(
  readDir: (
    path: string,
  ) => Promise<Array<{ name: string; path: string; type: string }>>,
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

function sleepMs(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, Math.floor(ms)));
}

async function main() {
  reexecuteWithNativeQuicIfAvailable();
  const program = new Command();
  const appInfo = getCliBuildInfo();
  program
    .name("syncpeer")
    .description("Read-only Syncthing BEP client")
    .version(appInfo.appVersion, "-V, --version", "Show Syncpeer version")
    .option("--host <host>", "Remote host", "127.0.0.1")
    .option(
      "--port <port>",
      "Remote port",
      (value) => parseInt(value, 10),
      22000,
    )
    .option(
      "--cert <file>",
      "Path to TLS certificate (defaults to persisted cli-node identity)",
    )
    .option(
      "--key <file>",
      "Path to TLS private key (defaults to persisted cli-node identity)",
    )
    .option("--remote-id <id>", "Expected remote device ID")
    .option(
      "--discovery-server <url>",
      "Global discovery server",
      getDefaultDiscoveryServer(),
    )
    .addOption(
      new Option("--discovery-mode <mode>", "Connection discovery mode")
        .choices(["automatic", "global", "lan", "direct"])
        .default("automatic"),
    )
    .option(
      "--relay-only",
      "Use only the relay candidate returned by global discovery",
      false,
    )
    .option(
      "--quic-only",
      "Require QUIC (diagnostics; fails when unavailable)",
      false,
    )
    .option("--device-name <name>", "Client device name", "syncpeer-cli")
    .option(
      "--folder-password <folderId=password>",
      "Folder decryption password for Syncthing receive-encrypted shares; repeat for multiple folders",
      (value, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--timeout-ms <ms>",
      "Connection timeout in milliseconds",
      (value) => parseInt(value, 10),
      15000,
    );

  program
    .command("about")
    .description("Show build and runtime information")
    .action(() => {
      console.log(formatAppBuildInfo(appInfo));
    });

  const withSession = async (
    run: (
      remoteFs: Awaited<ReturnType<typeof openRemoteFs>>["remoteFs"],
    ) => Promise<void>,
  ) => {
    const opts = program.opts<CliOptions>();
    const session = await openRemoteFs(opts);
    try {
      await run(session.remoteFs);
    } finally {
      await session.close();
    }
  };

  program
    .command("share-folder <folderId> <localPath>")
    .description(
      "Advertise and serve a local folder; encryption is enabled by default",
    )
    .option("--label <label>", "Human-readable folder label")
    .option(
      "--password <password>",
      "Encryption password (generated when omitted)",
    )
    .option(
      "--plaintext",
      "Explicitly share plaintext with a trusted peer",
      false,
    )
    .option(
      "--serve-ms <ms>",
      "Stop after this many milliseconds; zero waits for Ctrl-C",
      (value) => parseInt(value, 10),
      0,
    )
    .action(async (
      folderId: string,
      localPath: string,
      shareOpts: ShareFolderCommandOptions,
    ) => {
      const opts = program.opts<CliOptions>();
      const normalizedFolderId = folderId.trim();
      if (!normalizedFolderId) throw new Error("folderId must not be empty");
      const rootPath = fs.realpathSync(localPath);
      if (!fs.statSync(rootPath).isDirectory()) {
        throw new Error(`Local share path is not a directory: ${rootPath}`);
      }
      const password = shareOpts.plaintext
        ? null
        : shareOpts.password?.trim() || generatedFolderPassword();
      const sharedFolder: SharedFolder = {
        id: normalizedFolderId,
        label: shareOpts.label?.trim() || normalizedFolderId,
        encryption: password
          ? { mode: "encrypted", password }
          : { mode: "plaintext" },
      };
      const session = await openRemoteFs(opts, [sharedFolder]);
      try {
        const files = collectLocalFiles(rootPath);
        for (const file of files) {
          await session.remoteFs.writeFileFully(
            normalizedFolderId,
            file.path,
            file.bytes,
            { modifiedMs: file.modifiedMs },
          );
        }
        console.log(`Shared folder ID: ${normalizedFolderId}`);
        console.log(`Shared folder path: ${rootPath}`);
        console.log(`Files advertised: ${files.length}`);
        console.log(`Encryption: ${password ? "enabled" : "disabled"}`);
        if (password) console.log(`Folder password: ${password}`);
        console.log("Waiting for the peer to accept and synchronize. Press Ctrl-C to stop.");
        const serveMs = Math.max(0, Number(shareOpts.serveMs ?? 0));
        if (serveMs > 0) await sleepMs(serveMs);
        else await waitForSignal();
      } finally {
        await session.close();
      }
    });

  program
    .command("list")
    .description("List available folders on the remote peer")
    .action(async () =>
      withSession(async (remoteFs) => {
        const folders = await remoteFs.listFolders();
        for (const folder of folders) {
          const mode = folder.readOnly ? "ro" : "rw";
          console.log(`${folder.id}\t${mode}\t${folder.label}`);
        }
      }),
    );

  program
    .command("tree <folderId>")
    .description("Show a tree of files in the specified folder")
    .action(async (folderId: string) =>
      withSession(async (remoteFs) => {
        await remoteFs.waitForFolderIndex(folderId, 7000, 100);
        console.log(`${folderId}/`);
        const lines = await renderTree(
          async (targetPath) => remoteFs.readDir(folderId, targetPath),
          "",
          "",
        );
        for (const line of lines) console.log(line);
      }),
    );

  program
    .command("files <folderId> [dir]")
    .description("List files from a peer folder directory")
    .action(async (folderId: string, dir = "") =>
      withSession(async (remoteFs) => {
        await remoteFs.waitForFolderIndex(folderId, 7000, 100);
        const entries = await remoteFs.readDir(folderId, dir);
        for (const entry of entries) {
          const suffix = entry.type === "directory" ? "/" : "";
          const type = entry.type.padEnd(9, " ");
          console.log(`${type}\t${entry.path}${suffix}`);
        }
      }),
    );

  program
    .command("download <folderId> <remotePath> <localPath>")
    .description("Download a file from the remote peer")
    .action(async (folderId: string, remotePath: string, localPath: string) =>
      withSession(async (remoteFs) => {
        let transportKind = "direct";
        const startedAt = Date.now();
        const onProgress = (progress: { transportKind?: "direct-tcp" | "direct-quic" | "relay" }) => {
          const nextTransportKind = progress.transportKind === "relay" ? "relay" : "direct";
          if (nextTransportKind === transportKind) return;
          transportKind = nextTransportKind;
          console.log(`Transfer transport: ${transportKind}`);
        };
        const sink = remoteFs.readFileToSink
          ? await createNodeFileDownloadSink(localPath)
          : null;
        try {
          const result = remoteFs.readFileToSink
            ? await remoteFs.readFileToSink(folderId, remotePath, sink!, onProgress)
            : await (async () => {
                const bytes = await downloadRemoteFile(remoteFs, {
                  folderId,
                  path: remotePath,
                  onProgress,
                });
                fs.writeFileSync(localPath, Buffer.from(bytes));
                return { bytesWritten: bytes.length };
              })();
          const elapsedMs = Math.max(1, Date.now() - startedAt);
          const mibPerSecond = result.bytesWritten / 1024 / 1024 * 1000 / elapsedMs;
          console.log(
            `Wrote ${result.bytesWritten} bytes to ${localPath} via ${transportKind} ` +
            `in ${elapsedMs} ms (${mibPerSecond.toFixed(2)} MiB/s)`,
          );
        } catch (error) {
          if (!(error instanceof DownloadInterruptedError)) await sink?.abort(error);
          throw error;
        }
      }),
    );

  program
    .command("upload <folderId> <localPath> [remotePath]")
    .description("Upload a local file to the remote peer folder")
    .option(
      "--serve-ms <ms>",
      "Keep connection open after upload so remote peers can request blocks",
      (value) => parseInt(value, 10),
      0,
    )
    .action(async (folderId: string, localPath: string, remotePath: string | undefined, uploadOpts: UploadCommandOptions) =>
      withSession(async (remoteFs) => {
        const payload = fs.readFileSync(localPath);
        const fileName = path.basename(localPath);
        const targetPath = normalizeRelativePath(remotePath ?? fileName);
        if (!targetPath) throw new Error("remotePath must not be empty");
        await remoteFs.writeFileFully(folderId, targetPath, new Uint8Array(payload), {
          modifiedMs: fs.statSync(localPath).mtimeMs,
        });
        console.log(`Uploaded ${payload.length} bytes to ${folderId}/${targetPath}`);
        const serveMs = Number.isFinite(uploadOpts.serveMs)
          ? Math.max(0, Number(uploadOpts.serveMs))
          : 0;
        if (serveMs > 0) {
          console.log(`Serving upload blocks for ${serveMs} ms...`);
          await sleepMs(serveMs);
        }
      }),
    );

  program
    .command("global-discovery-test")
    .description(
      "Resolve a Syncthing device ID through global discovery and dump all candidates",
    )
    .action(async () => {
      const opts = program.opts<CliOptions>();

      if (!opts.remoteId) {
        throw new Error("Missing required option --remote-id");
      }

      const result = await resolveNodeGlobalDiscovery({
        expectedDeviceId: opts.remoteId,
        discoveryServer: opts.discoveryServer ?? getDefaultDiscoveryServer(),
      });

      console.log(`deviceId\t${opts.remoteId}`);
      const payload = result.payload;
      const addresses =
        typeof payload === "object" && payload !== null && "addresses" in payload &&
        Array.isArray(payload.addresses)
          ? payload.addresses
          : [];
      console.log(`rawAddresses\t${JSON.stringify(addresses)}`);
      for (const candidate of result.candidates) {
        console.log(
          `candidate\t${candidate.protocol}\t${candidate.host ?? ""}\t${candidate.port ?? ""}\t${candidate.address}`,
        );
      }
    });

  program
    .command("upload-test <peerFolderPath> <remotePath> [content]")
    .description(
      "Write a small test file directly into a local peer folder path",
    )
    .action((peerFolderPath: string, remotePath: string, content?: string) => {
      const relative = normalizeRelativePath(remotePath);
      if (!relative) throw new Error("remotePath must not be empty");
      const targetPath = fs.realpathSync(peerFolderPath);
      const outPath = path.resolve(targetPath, relative);
      const relativeToRoot = path.relative(targetPath, outPath);
      if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot))
        throw new Error(`remotePath escapes peerFolderPath: ${remotePath}`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const payload = content ?? "small upload from syncpeer cli\n";
      fs.writeFileSync(outPath, payload, "utf8");
      console.log(
        `Wrote ${Buffer.byteLength(payload, "utf8")} bytes to ${outPath}`,
      );
    });

  program
    .command("files-local <peerFolderPath> [dir]")
    .description("List files from a local peer folder path")
    .action((peerFolderPath: string, dir = "") => {
      const entries = listLocalDir(peerFolderPath, dir);
      for (const entry of entries) {
        const suffix = entry.type === "directory" ? "/" : "";
        const type = entry.type.padEnd(9, " ");
        console.log(`${type}\t${entry.path}${suffix}`);
      }
    });

  program
    .command("local-id")
    .description("Show the persisted local cli-node identity information")
    .action(() => {
      const identity = ensureCliNodeIdentity();
      console.log(`configDir\t${identity.configDir}`);
      console.log(`cert\t${identity.cert}`);
      console.log(`key\t${identity.key}`);
      if (identity.deviceId) console.log(`deviceId\t${identity.deviceId}`);
      else
        console.log(
          "deviceId\t(unavailable - Syncthing binary not found to resolve it)",
        );
    });

  await program.parseAsync(process.argv);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
