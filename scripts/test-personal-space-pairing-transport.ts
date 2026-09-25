import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createPairingInvitation } from "../packages/core/dist/sync/personalSpacePairing.js";
import { createOwnedDeviceIdentity, openOwnedDeviceSigningKey, signSpaceMembershipUpdate } from
  "../packages/core/dist/sync/personalSpaceSharing.js";
import { acceptPairingTransfer, joinPersonalSpace } from
  "../packages/core/dist/sync/personalSpacePairingTransport.js";

const socketPair = () => {
  const queues: Uint8Array[][] = [[], []];
  const waiters: Array<ReturnType<typeof Promise.withResolvers<Uint8Array>> | undefined> = [];
  const closed = [false, false];
  const socket = (side: 0 | 1) => ({
    peerCertificateDer: async () => new Uint8Array(),
    write: async (bytes: Uint8Array) => {
      const other = (1 - side) as 0 | 1;
      if (closed[side] || closed[other]) throw new Error("Connection closed");
      const split = Math.max(1, Math.floor(bytes.length / 3));
      for (let offset = 0; offset < bytes.length; offset += split) {
        const chunk = bytes.slice(offset, offset + split);
        const waiter = waiters[other];
        if (waiter) { waiters[other] = undefined; waiter.resolve(chunk); }
        else queues[other].push(chunk);
      }
    },
    read: async () => {
      const queued = queues[side].shift();
      if (queued) return queued;
      if (closed[side]) throw new Error("Connection closed");
      const waiter = Promise.withResolvers<Uint8Array>();
      waiters[side] = waiter;
      return waiter.promise;
    },
    close: async () => { closed[side] = true; waiters[side]?.reject(new Error("Connection closed")); },
  });
  return [socket(0), socket(1)] as const;
};

const pairingTransfer = async () => {
  const owner = await createOwnedDeviceIdentity(crypto.subtle, randomBytes, "OWNER");
  const genesis = await signSpaceMembershipUpdate(crypto.subtle,
    await openOwnedDeviceSigningKey(crypto.subtle, owner), { sequence: 1, previous: null, signer: owner.id,
      devices: [{ id: owner.id, syncthingId: owner.syncthingId, state: owner.state, signingKey: owner.signingKey }] });
  return { spaceId: "a".repeat(32), settingsFolderId: "b".repeat(32), rootKey: "c".repeat(64),
    trust: { genesisKey: owner.signingKey, knownHead: genesis.hash, updates: [genesis] } };
};

test("pairing transport confirms the same code before transferring personal-space secrets", async () => {
  const invitation = await createPairingInvitation(crypto.subtle, randomBytes, "OWNER", "127.0.0.1:22000",
    Date.now() + 60_000);
  const [ownerSocket, newSocket] = socketPair();
  const codes: string[] = [];
  const transfer = await pairingTransfer();
  const [accepted, joined] = await Promise.all([
    acceptPairingTransfer({ subtle: crypto.subtle, socket: ownerSocket, invitation,
      verifiedRemoteId: "NEW", createTransfer: async () => transfer, randomBytes,
      confirm: async code => { codes.push(`owner:${code}`); return true; } }),
    joinPersonalSpace({ subtle: crypto.subtle, socket: newSocket, invitation: invitation.invitation,
      localDeviceId: "NEW", verifiedRemoteId: "OWNER", randomBytes,
      confirm: async code => { codes.push(`new:${code}`); return true; } }),
  ]);
  assert.equal(accepted.remoteDeviceId, "NEW");
  assert.deepEqual(joined.transfer, transfer);
  assert.equal(codes[0].split(":")[1], codes[1].split(":")[1]);
});

test("either device rejecting the displayed code prevents secret transfer", async () => {
  const invitation = await createPairingInvitation(crypto.subtle, randomBytes, "OWNER", "127.0.0.1:22000",
    Date.now() + 60_000);
  const [ownerSocket, newSocket] = socketPair();
  const transfer = await pairingTransfer();
  let transferCreated = false;
  const outcomes = await Promise.allSettled([
    acceptPairingTransfer({ subtle: crypto.subtle, socket: ownerSocket, invitation,
      verifiedRemoteId: "NEW", createTransfer: async () => { transferCreated = true; return transfer; },
      randomBytes, confirm: async () => true }),
    joinPersonalSpace({ subtle: crypto.subtle, socket: newSocket, invitation: invitation.invitation,
      localDeviceId: "NEW", verifiedRemoteId: "OWNER", randomBytes, confirm: async () => false }),
  ]);
  assert.ok(outcomes.every(outcome => outcome.status === "rejected"));
  assert.equal(transferCreated, false);
});
