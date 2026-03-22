#!/usr/bin/env node
/*
 * syncpeer CLI entrypoint (minimal)
 *
 * This CLI is intentionally minimal. It parses command-line flags and
 * delegates to stubs for list, tree and download operations. For a full
 * implementation, integrate the transport, protocol and model modules to
 * connect to a Syncthing peer using BEP, negotiate TLS, receive the index
 * and request blocks for downloads. See README.md for details.
 */

import { Command } from "commander";

async function main() {
  const program = new Command();
  program
    .name("syncpeer")
    .description("Minimal read‑only Syncthing BEP client")
    .option("--host <host>", "Remote host", "127.0.0.1")
    .option("--port <port>", "Remote port", (value) => parseInt(value, 10), 22000)
    .option("--cert <file>", "Path to TLS certificate")
    .option("--key <file>", "Path to TLS private key")
    .option("--remote-id <id>", "Expected remote device ID")
    .hook("preAction", (thisCommand, actionCommand) => {
      // In a full implementation, you would perform connection and handshake here
    });

  program
    .command("list")
    .description("List available folders on the remote peer")
    .action(async () => {
      console.error("The 'list' command is not implemented in this minimal scaffold.");
    });

  program
    .command("tree <folderId>")
    .description("Show a tree of files in the specified folder")
    .action(async (folderId: string) => {
      console.error("The 'tree' command is not implemented in this minimal scaffold.");
    });

  program
    .command("download <folderId> <remotePath> <localPath>")
    .description("Download a file from the remote peer")
    .action(async (folderId: string, remotePath: string, localPath: string) => {
      console.error("The 'download' command is not implemented in this minimal scaffold.");
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});