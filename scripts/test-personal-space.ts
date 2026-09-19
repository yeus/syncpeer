import assert from "node:assert/strict";
import { test } from "node:test";
import { createPersonalSpaceBootstrap, openPersonalSpaceBootstrap,
  rewrapPersonalSpaceBootstrap, settingsFolderPassword, personalVaultKey } from "../packages/core/dist/sync/personalSpaceBootstrap.js";
import { scryptPasswordKdf, type PasswordKdf } from "../packages/core/dist/kdf.js";

const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));

test("personal-space bootstrap hides both identifiers and supports recovery", async () => {
  const { record, space } = await createPersonalSpaceBootstrap("synthetic-master-password", randomBytes);
  const visible = JSON.stringify(record);
  assert.equal(visible.includes(space.id), false);
  assert.equal(visible.includes(space.settingsFolderId), false);
  assert.equal(visible.includes(Array.from(space.rootKey).join(",")), false);
  const recovered = await openPersonalSpaceBootstrap(record, "synthetic-master-password");
  assert.equal(recovered.id, space.id);
  assert.equal(recovered.settingsFolderId, space.settingsFolderId);
  assert.deepEqual(recovered.rootKey, space.rootKey);
  assert.equal(settingsFolderPassword(recovered), settingsFolderPassword(space));
  assert.notDeepEqual(personalVaultKey(recovered), recovered.rootKey);
});

test("wrong passwords and modified bootstrap ciphertext fail closed", async () => {
  const { record } = await createPersonalSpaceBootstrap("synthetic-master-password", randomBytes);
  await assert.rejects(openPersonalSpaceBootstrap(record, "wrong-password"));
  const changed = structuredClone(record);
  changed.ciphertext[0] ^= 1;
  await assert.rejects(openPersonalSpaceBootstrap(changed, "synthetic-master-password"));
});

test("a new personal space refuses trivially short master passwords", async () => {
  await assert.rejects(createPersonalSpaceBootstrap("password", randomBytes), /at least 16/i);
});

test("changing the master password only rewraps the stable space key", async () => {
  const { record, space } = await createPersonalSpaceBootstrap("old-synthetic-password", randomBytes);
  const changed = await rewrapPersonalSpaceBootstrap(record, "old-synthetic-password",
    "new-synthetic-password", randomBytes);
  await assert.rejects(openPersonalSpaceBootstrap(changed, "old-synthetic-password"));
  const recovered = await openPersonalSpaceBootstrap(changed, "new-synthetic-password");
  assert.deepEqual(recovered.rootKey, space.rootKey);
  assert.equal(settingsFolderPassword(recovered), settingsFolderPassword(space));
  assert.notDeepEqual(changed.salt, record.salt);
});

test("an injected KDF port is awaited so the caller keeps running", async () => {
  const calls: string[] = [];
  const kdf: PasswordKdf = async (passwordBytes, salt) => {
    calls.push("derive");
    await new Promise(resolve => setTimeout(resolve, 5));
    return scryptPasswordKdf(passwordBytes, salt);
  };
  const { record, space } = await createPersonalSpaceBootstrap("synthetic-master-password", randomBytes, kdf);
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 0);
  const recovered = await openPersonalSpaceBootstrap(record, "synthetic-master-password", kdf);
  clearTimeout(timer);
  assert.equal(timerFired, true, "The event loop must run while the KDF derives");
  assert.deepEqual(calls, ["derive", "derive"]);
  assert.deepEqual(recovered.rootKey, space.rootKey);
});
