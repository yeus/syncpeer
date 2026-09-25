import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";
import { createSyncpeerBrowserClient } from "../packages/core/dist/ui/browserClient.js";
import { createSyncpeerCoreClient, type SyncpeerSessionHandle } from "../packages/core/dist/client.js";
import { useTemporaryMetadataRoot } from "./node-storage-fixture.ts";
import { createOwnedDeviceIdentity, openOwnedDeviceSigningKey, signSpaceMembershipUpdate } from
  "../packages/core/dist/sync/personalSpaceSharing.js";

useTemporaryMetadataRoot();

const identity = async (root: string, name: string) => {
  const cert = path.join(root, `${name}.pem`), key = path.join(root, `${name}.key`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-days", "1", "-subj", "/CN=synthetic-browser-pair", "-keyout", key, "-out", cert],
  { stdio: "ignore" });
  const certPem = await readFile(cert, "utf8");
  return { certPem, keyPem: await readFile(key, "utf8"),
    deviceId: computeDeviceId(new X509Certificate(certPem).raw) };
};

test("invalid invitation setup never leaks an incoming listener", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-pairing-failure-"));
  let listening = false;
  const accepting = Promise.withResolvers<never>();
  const ownerIdentity = await identity(root, "owner");
  const owner = createSyncpeerBrowserClient({ hostAdapter: {
    ...createNodeHostAdapter(),
    listenTls: async () => { listening = true; return {
      port: 22000, accept: () => accepting.promise,
      close: async () => { listening = false; accepting.reject(new Error("Listener closed")); },
    }; },
  }, platformAdapter: { readDefaultIdentity: async () => ownerIdentity,
    exportPairingTransfer: async () => { throw new Error("Not reached"); },
  } });
  try {
    await assert.rejects(owner.startPairingInvitation({ advertisedHost: "https://invalid.example",
      confirm: async () => true }), /advertised pairing address/);
    assert.equal(listening, false);
    await assert.rejects(owner.startPairingInvitation({ advertisedHost: "127.0.0.1",
      expiresInMs: -1, confirm: async () => true }));
    assert.equal(listening, false);
  } finally {
    await owner.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reused browser listener advertises current folders and adopts current connection options", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-listener-refresh-"));
  const adapter = createNodeHostAdapter();
  let port = 0;
  let listenCount = 0;
  let outgoingAttempts = 0;
  const requestedPorts: number[] = [];
  let outgoing: SyncpeerSessionHandle | undefined;
  const [ownerIdentity, joiningIdentity] = (await Promise.all([
    identity(root, "one"), identity(root, "two"),
  ])).sort((a, b) => b.deviceId.replaceAll("-", "").localeCompare(a.deviceId.replaceAll("-", "")));
  const owner = createSyncpeerBrowserClient({ hostAdapter: { ...adapter,
    connectTls: async () => { outgoingAttempts++; throw new Error("Synthetic outbound failure"); },
    listenTls: async options => {
      listenCount++;
      requestedPorts.push(options.port);
      const listener = await adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 });
      port = listener.port;
      return listener;
    },
  }, platformAdapter: { readDefaultIdentity: async () => ownerIdentity } });
  const connected = Promise.withResolvers<void>();
  const unsubscribe = owner.subscribeLifecycle(state => {
    if (state.phase === "connected") connected.resolve();
  });
  try {
    const options = { host: "127.0.0.1", port: 1, listenPort: 22999, remoteId: joiningIdentity.deviceId,
      deviceName: "synthetic-owner", discoveryMode: "direct" as const, timeoutMs: 1000 };
    for (const id of ["old-folder", "new-folder"]) {
      await assert.rejects(owner.connectAndSync({ ...options,
        folderPasswords: { [id]: "synthetic-password" },
        sharedFolders: [{ id, encryption: { mode: "plaintext" } }],
      }));
    }
    assert.equal(listenCount, 1);
    assert.equal(outgoingAttempts, 0, "The higher-ID peer should wait for its preferred incoming session.");
    assert.deepEqual(requestedPorts, [22999]);
    outgoing = await createSyncpeerCoreClient(adapter).openSession({ ...joiningIdentity,
      host: "127.0.0.1", port, expectedDeviceId: ownerIdentity.deviceId,
      deviceName: "synthetic-joiner", discoveryMode: "direct", timeoutMs: 1000,
      sharedFolders: [{ id: "new-folder", encryption: { mode: "plaintext" } }],
    });
    await connected.promise;
    assert.deepEqual((await outgoing.remoteFs.listFolders()).map(folder => folder.id), ["new-folder"]);
  } finally {
    unsubscribe();
    await outgoing?.close();
    await owner.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser clients pair over the production LAN TLS adapters and persist only after confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-browser-pairing-"));
  let handle: Awaited<ReturnType<ReturnType<typeof createSyncpeerBrowserClient>["startPairingInvitation"]>> | undefined;
  try {
    const [ownerIdentity, joiningIdentity] = await Promise.all([
      identity(root, "owner"), identity(root, "joining"),
    ]);
    const ownerSigning = await createOwnedDeviceIdentity(crypto.subtle, randomBytes, ownerIdentity.deviceId);
    let imported: unknown;
    const codes: string[] = [];
    const owner = createSyncpeerBrowserClient({ hostAdapter: createNodeHostAdapter(), platformAdapter: {
      readDefaultIdentity: async () => ownerIdentity,
      exportPairingTransfer: async (_localDeviceId, joiningDevice) => {
        const key = await openOwnedDeviceSigningKey(crypto.subtle, ownerSigning);
        const ownerDevice = { id: ownerSigning.id, syncthingId: ownerSigning.syncthingId,
          state: ownerSigning.state, signingKey: ownerSigning.signingKey };
        const genesis = await signSpaceMembershipUpdate(crypto.subtle, key,
          { sequence: 1, previous: null, signer: ownerDevice.id, devices: [ownerDevice] });
        const update = await signSpaceMembershipUpdate(crypto.subtle, key, { sequence: 2, previous: genesis.hash,
          signer: ownerDevice.id, devices: [ownerDevice, joiningDevice] });
        return { spaceId: "a".repeat(32), settingsFolderId: "b".repeat(32), rootKey: "c".repeat(64),
          trust: { genesisKey: ownerDevice.signingKey, knownHead: update.hash, updates: [genesis, update] } };
      },
    } });
    const joining = createSyncpeerBrowserClient({ hostAdapter: createNodeHostAdapter(), platformAdapter: {
      readDefaultIdentity: async () => joiningIdentity,
      importPairingTransfer: async (value, deviceIdentity, password, remember) => {
        imported = { value, deviceIdentity, password, remember };
      },
    } });
    handle = await owner.startPairingInvitation({ advertisedHost: "127.0.0.1", port: 0,
      confirm: async code => { codes.push(`owner:${code}`); return true; } });
    const joined = await joining.joinPairingInvitation({ invitation: handle.invitation,
      password: "joined-local-password", remember: false,
      confirm: async code => { codes.push(`joining:${code}`); return true; } });
    const accepted = await handle.completed;
    assert.equal(joined.remoteDeviceId.replaceAll("-", ""), ownerIdentity.deviceId.replaceAll("-", ""));
    assert.equal(accepted.remoteDeviceId, joiningIdentity.deviceId.replaceAll("-", ""));
    assert.equal(codes[0].split(":")[1], codes[1].split(":")[1]);
    const saved = imported as { value: { trust: { updates: Array<{ devices: Array<{ syncthingId: string }> }> } };
      deviceIdentity: { syncthingId: string; privateKey: string }; password: string; remember: boolean };
    assert.equal(saved.deviceIdentity.syncthingId, joiningIdentity.deviceId);
    assert.ok(saved.deviceIdentity.privateKey);
    assert.equal(saved.value.trust.updates.at(-1)?.devices.some(device =>
      device.syncthingId === joiningIdentity.deviceId), true);
    assert.equal(saved.password, "joined-local-password");
    assert.equal(saved.remember, false);
  } finally {
    await handle?.cancel().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
