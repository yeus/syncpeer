import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";
import { createSyncpeerBrowserClient } from "../packages/core/dist/ui/browserClient.js";
import { createOwnedDeviceIdentity, openOwnedDeviceSigningKey, signSpaceMembershipUpdate } from
  "../packages/core/dist/sync/personalSpaceSharing.js";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { binaryPath, ensureSyncthingTools, generateSyncthingIdentity } from "./lan-test/syncthing.ts";

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("No test port."));
    server.close(() => resolve(address.port));
  });
});

const waitForPort = async (port: number) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>(resolve => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Local relay did not start.");
};

test("two Syncpeer peers exchange bytes and pair through a local Syncthing relay",
  { timeout: 30000 }, async () => {
    ensureSyncthingTools();
    const root = await mkdtemp(path.join(tmpdir(), "syncpeer-relay-service-"));
    await mkdir(path.join(root, "relay"));
    const port = await freePort();
    const relay = spawn(binaryPath("strelaysrv"), [
      `-listen=127.0.0.1:${port}`, `-keys=${path.join(root, "relay")}`,
      "-pools=", "-status-srv=", "-ping-interval=2s",
    ], { stdio: "ignore" });
    let listener: Awaited<ReturnType<NonNullable<ReturnType<typeof createNodeHostAdapter>["listenRelay"]>>> | undefined;
    let pairing: Awaited<ReturnType<ReturnType<typeof createSyncpeerBrowserClient>["startPairingInvitation"]>> | undefined;
    try {
      await waitForPort(port);
      const relayCert = await readFile(path.join(root, "relay", "cert.pem"), "utf8");
      const relayId = computeDeviceId(new X509Certificate(relayCert).raw);
      const relayAddress = `relay://127.0.0.1:${port}/?id=${relayId}`;
      const a = generateSyncthingIdentity(path.join(root, "a"));
      const b = generateSyncthingIdentity(path.join(root, "b"));
      const adapter = createNodeHostAdapter();
      listener = await adapter.listenRelay!({ relayAddress,
        certPem: await readFile(a.certPath, "utf8"), keyPem: await readFile(a.keyPath, "utf8"),
        alpnProtocols: ["bep/1.0"] });
      const accepted = listener.accept();
      const connected = await adapter.connectRelay!({ relayAddress, expectedDeviceId: a.deviceId,
        certPem: await readFile(b.certPath, "utf8"), keyPem: await readFile(b.keyPath, "utf8") });
      const incoming = await accepted;
      assert.equal(computeDeviceId(await incoming.socket.peerCertificateDer()), b.deviceId);
      assert.equal(computeDeviceId(await connected.socket.peerCertificateDer()), a.deviceId);
      assert.equal(incoming.alpn, "bep/1.0");
      await connected.socket.write(Uint8Array.of(1, 2, 3));
      assert.deepEqual((await incoming.socket.read()).slice(0, 3), Uint8Array.of(1, 2, 3));
      await Promise.all([incoming.socket.close(), connected.socket.close()]);
      await listener.close();
      listener = undefined;

      const ownerIdentity = { certPem: await readFile(a.certPath, "utf8"),
        keyPem: await readFile(a.keyPath, "utf8"), deviceId: a.deviceId };
      const joiningIdentity = { certPem: await readFile(b.certPath, "utf8"),
        keyPem: await readFile(b.keyPath, "utf8"), deviceId: b.deviceId };
      const signing = await createOwnedDeviceIdentity(crypto.subtle, randomBytes, a.deviceId);
      let imported = false;
      const owner = createSyncpeerBrowserClient({ hostAdapter: adapter, platformAdapter: {
        readDefaultIdentity: async () => ownerIdentity,
        exportPairingTransfer: async (_id, joiningDevice) => {
          const key = await openOwnedDeviceSigningKey(crypto.subtle, signing);
          const ownerDevice = { id: signing.id, syncthingId: signing.syncthingId,
            state: signing.state, signingKey: signing.signingKey };
          const genesis = await signSpaceMembershipUpdate(crypto.subtle, key,
            { sequence: 1, previous: null, signer: ownerDevice.id, devices: [ownerDevice] });
          const update = await signSpaceMembershipUpdate(crypto.subtle, key, { sequence: 2,
            previous: genesis.hash, signer: ownerDevice.id, devices: [ownerDevice, joiningDevice] });
          return { spaceId: "a".repeat(32), settingsFolderId: "b".repeat(32), rootKey: "c".repeat(64),
            trust: { genesisKey: ownerDevice.signingKey, knownHead: update.hash,
              updates: [genesis, update] } };
        },
      } });
      const joining = createSyncpeerBrowserClient({ hostAdapter: adapter, platformAdapter: {
        readDefaultIdentity: async () => joiningIdentity,
        importPairingTransfer: async () => { imported = true; },
      } });
      try {
        pairing = await owner.startPairingInvitation({ advertisedHost: relayAddress,
          confirm: async () => true });
        assert.equal(pairing.invitation.endpoint, relayAddress);
        await joining.joinPairingInvitation({ invitation: pairing.invitation,
          password: "synthetic-local-password", remember: false, confirm: async () => true });
        assert.equal((await pairing.completed).remoteDeviceId, b.deviceId.replaceAll("-", ""));
        assert.equal(imported, true);
      } finally {
        await pairing?.cancel().catch(() => undefined);
        await Promise.all([owner.disconnect(), joining.disconnect()]);
      }
    } finally {
      await listener?.close().catch(() => undefined);
      if (relay.exitCode === null) {
        const exited = new Promise(resolve => relay.once("exit", resolve));
        relay.kill("SIGTERM");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
