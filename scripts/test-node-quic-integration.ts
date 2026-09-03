import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureCliNodeIdentity } from "../packages/cli/src/identity.ts";
import { createLanFixture } from "./lan-test/syncthing.ts";

const required = process.env.SYNCPEER_REQUIRE_EXTERNAL_CHECKS === "1";
const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<unknown>;
const available = await dynamicImport("node:quic")
  .then((module) => !!module && typeof module === "object" && "connect" in module)
  .catch(() => false);

if (!available) {
  if (required) throw new Error("Node QUIC integration is required but node:quic is unavailable.");
  console.log("Node QUIC integration skipped: node:quic is unavailable.");
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-node-quic-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    const identity = ensureCliNodeIdentity();
    if (!identity.deviceId) throw new Error("CLI identity did not provide a device ID.");
    const fixture = await createLanFixture({
      root: path.join(root, "server"),
      serverHost: "127.0.0.1",
      trustedDeviceId: identity.deviceId,
      mode: "quic",
    });
    try {
      const result = spawnSync(process.execPath, [
        "--experimental-quic",
        path.resolve("packages/cli/dist/main.js"),
        "--host", "127.0.0.1",
        "--port", String(fixture.fixture.directPort),
        "--remote-id", fixture.fixture.remoteDeviceId,
        "--discovery-mode", "direct",
        "--quic-only",
        "list",
      ], {
        cwd: process.cwd(),
        env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") },
        encoding: "utf8",
      });
      if (result.status !== 0) {
        throw new Error(`CLI QUIC integration failed: ${result.stderr || result.stdout}`);
      }
      if (!result.stdout.includes(fixture.fixture.folderId)) {
        throw new Error("CLI QUIC integration did not list the fixture folder.");
      }
      console.log("Node QUIC integration passed against a real Syncthing listener.");
    } finally {
      await fixture.stop();
    }
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
