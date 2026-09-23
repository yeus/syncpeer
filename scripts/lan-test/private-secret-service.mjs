import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const finished = child => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});

export async function runWithPrivateSecretService(command, args, extraEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-keyring-"));
  try {
    await mkdir(path.join(root, "control"), { mode: 0o700 });
    const child = spawn("dbus-run-session", ["--config-file",
      fileURLToPath(new URL("./private-session-bus.conf", import.meta.url)), "--",
      process.execPath, fileURLToPath(import.meta.url), "--private-bus-child", command, ...args], {
      stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...extraEnv,
        XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
        GNOME_KEYRING_CONTROL: path.join(root, "control"), SYNCPEER_PRIVATE_KEYRING_ROOT: root,
        DBUS_SESSION_BUS_ADDRESS: "",
      },
    });
    return await finished(child);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function runPrivateBusChild() {
  const root = process.env.SYNCPEER_PRIVATE_KEYRING_ROOT;
  assert.ok(root && path.dirname(root) === tmpdir() && path.basename(root).startsWith("syncpeer-keyring-"));
  const daemon = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets",
    "--control-directory", path.join(root, "control")], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env,
      ...(process.env.SYNCPEER_KEYRING_LIBRARY_PATH !== undefined
        ? { LD_LIBRARY_PATH: process.env.SYNCPEER_KEYRING_LIBRARY_PATH } : {}),
    } });
  const stopped = finished(daemon);
  daemon.stdin.end("synthetic-keyring-password");
  try {
    const deadline = Date.now() + 10000;
    while (true) {
      const ready = spawnSync("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner",
        "string:org.freedesktop.secrets"], { encoding: "utf8", timeout: 1000 });
      if (ready.status === 0 && ready.stdout.includes("boolean true")) break;
      assert.ok(Date.now() < deadline && daemon.exitCode === null, "Private Secret Service did not become ready");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const command = process.argv[3];
    assert.ok(command, "Private Secret Service target is missing");
    return await finished(spawn(command, process.argv.slice(4), { stdio: "inherit" }));
  } finally {
    daemon.kill("SIGTERM");
    await stopped;
  }
}

if (process.argv[2] === "--private-bus-child") {
  runPrivateBusChild().then(code => { process.exitCode = code; }).catch(error => {
    console.error("Private Secret Service fixture failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
