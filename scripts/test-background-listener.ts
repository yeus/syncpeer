import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";
import { createSyncpeerBrowserClient } from "../packages/core/dist/ui/browserClient.js";
import { createSyncpeerCoreClient } from "../packages/core/dist/client.js";
import { useTemporaryMetadataRoot } from "./node-storage-fixture.ts";

useTemporaryMetadataRoot();

const identity = async (root: string, name: string) => {
  const cert = path.join(root, `${name}.pem`), key = path.join(root, `${name}.key`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-days", "1", "-subj", "/CN=synthetic-background-listener", "-keyout", key, "-out", cert],
  { stdio: "ignore" });
  const certPem = await readFile(cert, "utf8");
  return { certPem, keyPem: await readFile(key, "utf8"),
    deviceId: computeDeviceId(new X509Certificate(certPem).raw) };
};

const comparable = (value: string) => value.replace(/[^A-Z2-7]/gi, "").toUpperCase();

test("an idle background listener stays open and adopts an approved incoming session", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-background-listener-"));
  const adapter = createNodeHostAdapter();
  const [ownerIdentity, joiningIdentity] = (await Promise.all([
    identity(root, "owner"), identity(root, "joiner"),
  ])).sort((a, b) => b.deviceId.localeCompare(a.deviceId));
  let listenerPort = 0;
  const adopted: string[] = [];
  const owner = createSyncpeerBrowserClient({
    hostAdapter: { ...adapter,
      listenTls: async options => {
        const listener = await adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 });
        listenerPort = listener.port;
        return listener;
      },
    },
    platformAdapter: {
      readDefaultIdentity: async () => ownerIdentity,
      ownedDevices: async () => [
        { id: "owner-slot", syncthingId: ownerIdentity.deviceId, state: "active" as const, signingKey: "owner-key" },
        { id: "joiner-slot", syncthingId: joiningIdentity.deviceId, state: "active" as const, signingKey: "joiner-key" },
      ],
      sessionSharedFolders: async () => [{ id: "shared-folder", encryption: { mode: "plaintext" } }],
    },
    onIncomingSession: event => { adopted.push(event.remoteDeviceId); },
  });
  let outgoing: Awaited<ReturnType<ReturnType<typeof createSyncpeerCoreClient>["openSession"]>> | undefined;
  try {
    const status = await owner.startBackgroundListener({ listenPort: 22999 });
    assert.equal(status.active, true);
    assert.ok(status.port && status.port > 0, "listener reports its bound port");
    assert.equal(status.ephemeral, false);
    outgoing = await createSyncpeerCoreClient(adapter).openSession({ ...joiningIdentity,
      host: "127.0.0.1", port: listenerPort, expectedDeviceId: ownerIdentity.deviceId,
      deviceName: "synthetic-joiner", discoveryMode: "direct", timeoutMs: 3000,
      sharedFolders: [{ id: "shared-folder", encryption: { mode: "plaintext" } }],
    });
    const deadline = Date.now() + 5000;
    while (adopted.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(adopted.map(comparable), [comparable(joiningIdentity.deviceId)]);
    assert.equal(owner.backgroundListenerStatus().active, true);
  } finally {
    await outgoing?.close();
    await owner.stopBackgroundListener();
    assert.equal(owner.backgroundListenerStatus().active, false);
    await rm(root, { recursive: true, force: true });
  }
});

test("a busy configured port falls back to an ephemeral listener port", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-background-ephemeral-"));
  const adapter = createNodeHostAdapter();
  const ownerIdentity = await identity(root, "owner");
  const attempts: number[] = [];
  const owner = createSyncpeerBrowserClient({
    hostAdapter: { ...adapter,
      listenTls: async options => {
        attempts.push(options.port);
        if (attempts.length === 1) {
          throw new Error(`Syncpeer could not listen on ${options.host}:${options.port}: ` +
            "Address already in use (os error 98)");
        }
        return adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 });
      },
    },
    platformAdapter: { readDefaultIdentity: async () => ownerIdentity },
  });
  try {
    const status = await owner.startBackgroundListener({ listenPort: 22000 });
    assert.deepEqual(attempts, [22000, 0]);
    assert.equal(status.active, true);
    assert.equal(status.ephemeral, true);
    assert.ok(status.port && status.port > 0);
  } finally {
    await owner.stopBackgroundListener();
    await rm(root, { recursive: true, force: true });
  }
});
