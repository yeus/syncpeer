import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createPairingInvitation, createPairingRequest, openPairingSession,
  sealPairingTransfer, openPairingTransfer } from "../packages/core/dist/sync/personalSpacePairing.js";

test("pairing binds both certificate identities and requires matching confirmation codes", async () => {
  const subtle = globalThis.crypto.subtle;
  const inviter = await createPairingInvitation(subtle, randomBytes, "OWNED", "127.0.0.1:22002", Date.now() + 60_000);
  const joiner = await createPairingRequest(subtle, randomBytes, inviter.invitation, "NEW", "OWNED");
  const first = await openPairingSession(subtle, inviter.privateKey, inviter.invitation,
    joiner.request, "NEW");
  const second = await openPairingSession(subtle, joiner.privateKey, inviter.invitation,
    joiner.request, "OWNED");
  assert.equal(first.confirmationCode, second.confirmationCode);
  const sealed = await sealPairingTransfer(subtle, first, randomBytes, {
    spaceId: "a".repeat(32), settingsFolderId: "b".repeat(32), rootKey: "c".repeat(64),
  });
  assert.deepEqual(await openPairingTransfer(subtle, second, sealed), {
    spaceId: "a".repeat(32), settingsFolderId: "b".repeat(32), rootKey: "c".repeat(64),
  });
  await assert.rejects(openPairingSession(subtle, joiner.privateKey, inviter.invitation,
    joiner.request, "IMPOSTOR"), /identity/i);
  await assert.rejects(openPairingTransfer(subtle, { ...second, confirmationCode: "000000" }, sealed), /confirmation/i);
});
