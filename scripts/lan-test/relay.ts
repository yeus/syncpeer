import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeDeviceId } from "../../packages/core/dist/core/transport/node.js";
import { binaryPath, ensureSyncthingTools } from "./syncthing.ts";

async function stopRelay(relay: ChildProcess) {
  if (relay.exitCode !== null || relay.pid === undefined) return;
  const exited = new Promise(resolve => relay.once("exit", resolve));
  relay.kill("SIGTERM"); await exited;
}

async function launchRelay(root: string, port: number) {
  const relay = spawn(binaryPath("strelaysrv"), [
    `-listen=127.0.0.1:${port}`, `-keys=${path.join(root, "relay")}`,
    "-pools=", "-status-srv=", "-ping-interval=2s",
  ], { stdio: "ignore" });
  let startupError: Error | undefined;
  relay.once("error", error => { startupError = error; });
  try {
    const deadline = Date.now() + 10000;
    while (true) {
      const ready = await new Promise<boolean>(resolve => {
        const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      if (ready) return relay;
      assert.ok(!startupError && relay.exitCode === null && Date.now() < deadline, "Local relay did not start");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (error) { await stopRelay(relay); throw error; }
}

export async function startLocalRelay() {
  ensureSyncthingTools();
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-local-relay-"));
  await mkdir(path.join(root, "relay"));
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => reservation.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const port = address.port;
  let relay: ChildProcess | undefined;
  const close = async () => {
    if (relay) await stopRelay(relay);
    await rm(root, { recursive: true, force: true });
  };
  try {
    relay = await launchRelay(root, port);
    const relayCert = await readFile(path.join(root, "relay", "cert.pem"), "utf8");
    const relayId = computeDeviceId(new X509Certificate(relayCert).raw);
    return { root, relayAddress: `relay://127.0.0.1:${port}/?id=${relayId}`, close,
      restart: async () => { await stopRelay(relay!); relay = await launchRelay(root, port); } };
  } catch (error) { await close(); throw error; }
}
