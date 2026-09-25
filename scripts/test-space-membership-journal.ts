import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createSpaceMembershipJournal } from "../packages/core/dist/sync/spaceMembershipJournal.js";
import { createOwnedDeviceIdentity, openOwnedDeviceSigningKey, signSpaceMembershipUpdate } from
  "../packages/core/dist/sync/personalSpaceSharing.js";

test("only the signer publishes an encrypted space membership update", async () => {
  const owner = await createOwnedDeviceIdentity(crypto.subtle, randomBytes, "OWNER");
  const genesis = await signSpaceMembershipUpdate(crypto.subtle,
    await openOwnedDeviceSigningKey(crypto.subtle, owner), {
      sequence: 1, previous: null, signer: owner.id, devices: [{ id: owner.id,
        syncthingId: owner.syncthingId, state: owner.state, signingKey: owner.signingKey }],
    });
  const edits: string[] = [];
  const replica = { scan: async () => [], readBlock: async () => assert.fail("No prior membership file"),
    edit: async (change: { path: string }) => { edits.push(change.path); } };
  const journal = createSpaceMembershipJournal(replica as never, "settings");
  await journal.appendMissing([genesis], "joined-device");
  assert.deepEqual(edits, [], "A joining device must wait for the signer to publish the update");
  await journal.appendMissing([genesis], owner.id);
  assert.deepEqual(edits, ["roster", "roster/0000000001.json"]);
});
