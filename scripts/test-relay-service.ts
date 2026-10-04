import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";
import { createSyncpeerBrowserClient } from "../packages/core/dist/ui/browserClient.js";
import { createOwnedDeviceIdentity, openOwnedDeviceSigningKey, signSpaceMembershipUpdate } from
  "../packages/core/dist/sync/personalSpaceSharing.js";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { generateSyncthingIdentity } from "./lan-test/syncthing.ts";
import { startLocalRelay } from "./lan-test/relay.ts";

test("two Syncpeer peers exchange bytes and pair through a local Syncthing relay",
  { timeout: 30000 }, async () => {
    const relay = await startLocalRelay();
    const { root, relayAddress } = relay;
    let listener: Awaited<ReturnType<NonNullable<ReturnType<typeof createNodeHostAdapter>["listenRelay"]>>> | undefined;
    let pairing: Awaited<ReturnType<ReturnType<typeof createSyncpeerBrowserClient>["startPairingInvitation"]>> | undefined;
    try {
      const a = generateSyncthingIdentity(path.join(root, "a"));
      const b = generateSyncthingIdentity(path.join(root, "b"));
      const adapter = createNodeHostAdapter();
      listener = await adapter.listenRelay!({ relayAddress,
        certPem: await readFile(a.certPath, "utf8"), keyPem: await readFile(a.keyPath, "utf8"),
        alpnProtocols: ["bep/1.0"] });
      const accepted = listener.accept();
      // If dialing fails, closing the listener also rejects this pending accept.
      // Observe both errors so the dial failure remains the reported root cause.
      void accepted.catch(() => undefined);
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

      // Use separate devices for pairing: relay presence can outlive socket close briefly.
      const pairingOwner = generateSyncthingIdentity(path.join(root, "pairing-owner"));
      const pairingJoiner = generateSyncthingIdentity(path.join(root, "pairing-joiner"));
      const ownerIdentity = { certPem: await readFile(pairingOwner.certPath, "utf8"),
        keyPem: await readFile(pairingOwner.keyPath, "utf8"), deviceId: pairingOwner.deviceId };
      const joiningIdentity = { certPem: await readFile(pairingJoiner.certPath, "utf8"),
        keyPem: await readFile(pairingJoiner.keyPath, "utf8"), deviceId: pairingJoiner.deviceId };
      const signing = await createOwnedDeviceIdentity(crypto.subtle, randomBytes, pairingOwner.deviceId);
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
        assert.equal((await pairing.completed).remoteDeviceId, pairingJoiner.deviceId.replaceAll("-", ""));
        assert.equal(imported, true);
      } finally {
        await pairing?.cancel().catch(() => undefined);
        await Promise.all([owner.disconnect(), joining.disconnect()]);
      }
    } finally {
      await listener?.close().catch(() => undefined);
      await relay.close();
    }
  });
