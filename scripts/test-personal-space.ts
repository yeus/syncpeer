import assert from "node:assert/strict";
import { test } from "node:test";
import { createPersonalSpaceBootstrap, openPersonalSpaceBootstrap,
  rewrapPersonalSpaceBootstrap, settingsFolderPassword, personalVaultKey } from "../packages/core/dist/sync/personalSpaceBootstrap.js";

const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));

test("personal-space bootstrap hides both identifiers and supports recovery", async () => {
  const { record, space } = await createPersonalSpaceBootstrap("synthetic-master-password", randomBytes);
  const visible = JSON.stringify(record);
  assert.equal(visible.includes(space.id), false);
  assert.equal(visible.includes(space.settingsFolderId), false);
  assert.equal(visible.includes(Array.from(space.rootKey).join(",")), false);
  const recovered = openPersonalSpaceBootstrap(record, "synthetic-master-password");
  assert.equal(recovered.id, space.id);
  assert.equal(recovered.settingsFolderId, space.settingsFolderId);
  assert.deepEqual(recovered.rootKey, space.rootKey);
  assert.equal(settingsFolderPassword(recovered), settingsFolderPassword(space));
  assert.notDeepEqual(personalVaultKey(recovered), recovered.rootKey);
});

test("wrong passwords and modified bootstrap ciphertext fail closed", async () => {
  const { record } = await createPersonalSpaceBootstrap("synthetic-master-password", randomBytes);
  assert.throws(() => openPersonalSpaceBootstrap(record, "wrong-password"));
  const changed = structuredClone(record);
  changed.ciphertext[0] ^= 1;
  assert.throws(() => openPersonalSpaceBootstrap(changed, "synthetic-master-password"));
});

test("a new personal space refuses trivially short master passwords", async () => {
  await assert.rejects(createPersonalSpaceBootstrap("password", randomBytes), /at least 16/i);
});

test("changing the master password only rewraps the stable space key", async () => {
  const { record, space } = await createPersonalSpaceBootstrap("old-synthetic-password", randomBytes);
  const changed = await rewrapPersonalSpaceBootstrap(record, "old-synthetic-password",
    "new-synthetic-password", randomBytes);
  assert.throws(() => openPersonalSpaceBootstrap(changed, "old-synthetic-password"));
  const recovered = openPersonalSpaceBootstrap(changed, "new-synthetic-password");
  assert.deepEqual(recovered.rootKey, space.rootKey);
  assert.equal(settingsFolderPassword(recovered), settingsFolderPassword(space));
  assert.notDeepEqual(changed.salt, record.salt);
});
