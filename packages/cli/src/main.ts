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
  createNodeFolderSyncStorage,
  DownloadInterruptedError,
  downloadRemoteFile,
  getDefaultDiscoveryServer,
  resolveNodeGlobalDiscovery,
} from "@syncpeer/core/node";
import {
  deleteFolderFile,
  defaultFolderSyncPolicy,
  synchronizeFolder,
  unsubscribeFolder,
  type FolderSyncPolicy,
} from "@syncpeer/core";
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
  once?: boolean;
  deleteRemote?: boolean;
  versioning?: "disabled" | "trash" | "simple" | "staggered";
  maxVersions?: number;
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

function generatedFolderPassword(): string {
  return randomBytes(24).toString("base64url");
}

const folderSyncPolicy = (options: ShareFolderCommandOptions): FolderSyncPolicy => ({
  ...defaultFolderSyncPolicy(),
  externalDeletion: options.deleteRemote ? "propagate" : "ignore",
  versioning: options.versioning ?? "staggered",
  ...(Number.isFinite(options.maxVersions) && (options.maxVersions ?? 0) > 0
    ? { maxVersions: Math.floor(options.maxVersions!) }
    : {}),
});

const runFolderSyncService = async (args: {
  folderId: string;
  rootPath: string;
  remoteFs: Awaited<ReturnType<typeof openRemoteFs>>["remoteFs"];
  options: ShareFolderCommandOptions;
}): Promise<void> => {
  const storage = await createNodeFolderSyncStorage(args.rootPath);
  await storage.setSubscribed?.(true);
  const policy = folderSyncPolicy(args.options);
  if (!args.remoteFs.listFiles) throw new Error("This connection does not expose folder listings.");
  const remote = {
    listFiles: (folderId: string) => args.remoteFs.listFiles!(folderId),
    readFileFully: (folderId: string, filePath: string, signal?: AbortSignal) =>
      args.remoteFs.readFileFully(folderId, filePath, undefined, signal),
    writeFileFully: (...writeArgs: Parameters<typeof args.remoteFs.writeFileFully>) =>
      args.remoteFs.writeFileFully(...writeArgs),
    deleteFile: args.remoteFs.deleteFile
      ? (...deleteArgs: Parameters<NonNullable<typeof args.remoteFs.deleteFile>>) =>
        args.remoteFs.deleteFile!(...deleteArgs)
      : undefined,
  };
  let running: Promise<void> | null = null;
  const syncOnce = async (): Promise<void> => {
    if (running) return running;
    running = synchronizeFolder({
      folderId: args.folderId,
      remote,
      storage,
      policy,
      onEvent: (event) => {
        if (event.status === "completed") {
          console.log(`Folder sync ${event.action.kind}: ${event.action.path}`);
        }
      },
    }).then((result) => {
      if (result.actions.length > 0) {
        console.log(
          `Folder sync completed: ${result.completed} action(s), ` +
          `${result.conflicts.length} conflict(s).`,
        );
      }
    }).finally(() => {
      running = null;
    });
    return running;
  };
  await syncOnce();
  if (args.options.once || Number(args.options.serveMs ?? 0) > 0) {
    if (!args.options.once) await sleepMs(Math.max(0, Number(args.options.serveMs ?? 0)));
    return;
  }
  let stop: () => void = () => {};
  console.log("Folder subscription active.");
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let unsubscribed = false;
  const timer = setInterval(() => {
    void (async () => {
      if (await storage.isSubscribed?.() === false) {
        unsubscribed = true;
        stop();
        return;
      }
      await syncOnce();
    })().catch((error) => console.error(String(error)));
  }, 2_000);
  try {
    await stopped;
  } finally {
    clearInterval(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await running;
  }
  if (unsubscribed) console.log("Folder subscription stopped.");
};

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
    .description("Syncthing BEP client with read and folder-sync support")
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
    .option("--once", "Synchronize once and exit", false)
    .option("--delete-remote", "Propagate local deletions to the peer", false)
    .addOption(new Option("--versioning <mode>", "Archive replaced/deleted files").choices(["disabled", "trash", "simple", "staggered"]).default("staggered"))
    .option("--max-versions <count>", "Maximum archived versions per file", (value) => parseInt(value, 10))
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
        console.log(`Shared folder ID: ${normalizedFolderId}`);
        console.log(`Shared folder path: ${rootPath}`);
        console.log(`Encryption: ${password ? "enabled" : "disabled"}`);
        if (password) console.log(`Folder password: ${password}`);
        await runFolderSyncService({
          folderId: normalizedFolderId,
          rootPath,
          remoteFs: session.remoteFs,
          options: shareOpts,
        });
      } finally {
        await session.close();
      }
    });

  program
    .command("sync-folder <folderId> <localPath>")
    .description("Synchronize a local folder with a writable syncpeer folder")
    .option("--once", "Synchronize once and exit", false)
    .option("--delete-remote", "Propagate local deletions to the peer", false)
    .addOption(new Option("--versioning <mode>", "Archive replaced/deleted files").choices(["disabled", "trash", "simple", "staggered"]).default("staggered"))
    .option("--max-versions <count>", "Maximum archived versions per file", (value) => parseInt(value, 10))
    .action(async (folderId: string, localPath: string, syncOpts: ShareFolderCommandOptions) => {
      const opts = program.opts<CliOptions>();
      const normalizedFolderId = folderId.trim();
      if (!normalizedFolderId) throw new Error("folderId must not be empty");
      const rootPath = fs.realpathSync(localPath);
      if (!fs.statSync(rootPath).isDirectory()) throw new Error(`Local sync path is not a directory: ${rootPath}`);
      const session = await openRemoteFs(opts);
      try {
        await runFolderSyncService({ folderId: normalizedFolderId, rootPath, remoteFs: session.remoteFs, options: syncOpts });
      } finally {
        await session.close();
      }
    });

  program
    .command("versions <localPath> [relativePath]")
    .description("List archived folder versions")
    .action(async (localPath: string, relativePath?: string) => {
      const rootPath = fs.realpathSync(localPath);
      const storage = await createNodeFolderSyncStorage(rootPath);
      for (const version of await storage.listVersions(relativePath)) {
        console.log(`${version.archivePath}\t${version.path}\t${new Date(version.modifiedMs).toISOString()}`);
      }
    });

  program
    .command("restore <localPath> <archivePath> [targetPath]")
    .description("Restore an archived folder version")
    .action(async (localPath: string, archivePath: string, targetPath?: string) => {
      const rootPath = fs.realpathSync(localPath);
      const storage = await createNodeFolderSyncStorage(rootPath);
      await storage.restoreVersion(archivePath, targetPath);
      console.log(`Restored ${archivePath}${targetPath ? ` to ${targetPath}` : ""}.`);
    });

  program
    .command("unsubscribe-folder <localPath>")
    .description("Remove local folder contents while leaving the remote folder unchanged")
    .addOption(new Option("--versioning <mode>", "Archive removed files").choices(["disabled", "trash", "simple", "staggered"]).default("staggered"))
    .option("--max-versions <count>", "Maximum archived versions per file", (value) => parseInt(value, 10))
    .action(async (localPath: string, unsubscribeOpts: ShareFolderCommandOptions) => {
      const rootPath = fs.realpathSync(localPath);
      const storage = await createNodeFolderSyncStorage(rootPath);
      const result = await unsubscribeFolder({ storage, policy: folderSyncPolicy(unsubscribeOpts) });
      console.log(`Unsubscribed local folder: removed ${result.removed.length} file(s), archived ${result.archived.length}.`);
    });

  program
    .command("delete-file <folderId> <localPath> <relativePath>")
    .description("Delete one local file and publish a remote tombstone")
    .addOption(new Option("--versioning <mode>", "Archive the local file").choices(["disabled", "trash", "simple", "staggered"]).default("staggered"))
    .option("--max-versions <count>", "Maximum archived versions per file", (value) => parseInt(value, 10))
    .action(async (folderId: string, localPath: string, relativePath: string, deleteOpts: ShareFolderCommandOptions) => {
      const opts = program.opts<CliOptions>();
      const normalizedFolderId = folderId.trim();
      if (!normalizedFolderId) throw new Error("folderId must not be empty");
      const rootPath = fs.realpathSync(localPath);
      if (!fs.statSync(rootPath).isDirectory()) throw new Error(`Local sync path is not a directory: ${rootPath}`);
      const storage = await createNodeFolderSyncStorage(rootPath);
      const session = await openRemoteFs(opts);
      try {
        const result = await deleteFolderFile({
          folderId: normalizedFolderId,
          path: relativePath,
          remote: {
            deleteFile: session.remoteFs.deleteFile
              ? (...deleteArgs: Parameters<NonNullable<typeof session.remoteFs.deleteFile>>) =>
                session.remoteFs.deleteFile!(...deleteArgs)
              : undefined,
          },
          storage,
          policy: folderSyncPolicy(deleteOpts),
        });
        console.log(`Deleted ${result.path}; remote tombstone published.`);
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
