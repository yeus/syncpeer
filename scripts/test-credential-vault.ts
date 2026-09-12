import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createCredentialVault } from "../packages/core/dist/sync/credentialVault.js";
import { createCredentialVaultStorage } from "../packages/core/dist/sync/credentialVaultStorage.js";
import { memoryReplicaStorage } from "./lan-test/replica-storage.ts";
import { deriveUntrustedFolderCrypto } from "@syncpeer/core/filesystem";
import { writeEncryptedRecord } from "../packages/core/dist/sync/encryptedRecord.js";

test("successful manual unlock repairs remembered access after a temporary secure-store failure", async () => {
  let record: unknown = null;
  let remembered: string | null = null;
  let unavailable = true;
  const options = { profileId: "synthetic-profile", randomBytes,
    storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
      withLock: async <T>(operation: () => Promise<T>) => operation() },
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => remembered,
      save: async (value: string) => { if (unavailable) throw new Error("Unavailable"); remembered = value; },
      remove: async () => { remembered = null; } }, revokeAccess: async () => {} };
  const first = createCredentialVault(options);
  assert.equal((await first.create("synthetic-master")).remembered, false);
  await first.addFolder("fixture", "synthetic-remote-password");
  await first.saveConnectionPasswords({ fixture: "synthetic-remote-password" });
  await assert.rejects(first.saveConnectionPasswords({ fixture: "different-password" }), /migration/i);
  await assert.rejects(first.saveConnectionPasswords({ "SYNTHETICPEER:fixture": "different-password" }), /migration/i);
  assert.equal(JSON.stringify(record).includes("synthetic-remote-password"), false);
  await first.close();
  unavailable = false;
  const reopened = createCredentialVault(options);
  assert.equal((await reopened.initialize()).phase, "locked");
  await assert.rejects(reopened.unlock("wrong-password"));
  assert.equal(remembered, null);
  assert.equal((await reopened.unlock("synthetic-master")).remembered, true);
  await reopened.close();
  const restarted = createCredentialVault(options);
  assert.equal((await restarted.initialize()).phase, "unlocked");
  assert.equal(await restarted.folderPassword("fixture"), "synthetic-remote-password");
  assert.deepEqual(await restarted.connectionPasswords(), { fixture: "synthetic-remote-password" });
  await restarted.close();
});

test("new folders receive independent random passwords when no default or remote password exists", async () => {
  let record: unknown = null;
  const vault = createCredentialVault({ profileId: "synthetic-profile", randomBytes,
    storage: { load: async () => structuredClone(record), save: async value => { record = structuredClone(value); },
      withLock: async operation => operation() }, revokeAccess: async () => {} });
  await vault.create("synthetic-master");
  await vault.addFolder("first");
  await vault.addFolder("second");
  const first = await vault.folderPassword("first");
  assert.match(first!, /^[a-f0-9]{64}$/);
  assert.notEqual(first, await vault.folderPassword("second"));
  await vault.lock();
  await vault.unlock("synthetic-master");
  assert.equal(await vault.folderPassword("first"), first);
  await vault.close();
});

test("vault corruption errors never expose decrypted credential contents", async () => {
  const crypto = await deriveUntrustedFolderCrypto("syncpeer-vault:synthetic-profile", "synthetic-master");
  let ciphertext = new Uint8Array();
  await writeEncryptedRecord({ name: ".syncpeer-vault", folderKey: crypto.folderKey, randomBytes,
    bytes: new TextEncoder().encode("synthetic-private-credential"), createSink: async (_info, size) => {
      ciphertext = new Uint8Array(size);
      return { write: async (offset, bytes) => { ciphertext.set(bytes, offset); }, commit: async () => {}, abort: async () => {} };
    } });
  const vault = createCredentialVault({ profileId: "synthetic-profile", randomBytes,
    storage: { load: async () => ({ format: 1, remember: false, manualLocked: false, ciphertext: Array.from(ciphertext) }),
      save: async () => assert.fail("Corrupt credentials must not be replaced"), withLock: async operation => operation() },
    revokeAccess: async () => {} });
  await assert.rejects(vault.unlock("synthetic-master"), { message: "Invalid credential vault contents." });
  crypto.folderKey.fill(0);
});

test("vault record storage uses bounded atomic native byte writes and rejects changed snapshots", async () => {
  const { storage, files } = memoryReplicaStorage();
  const options = { withLock: async <T>(operation: () => Promise<T>) => operation(), checkHealth: async () => {} };
  const records = createCredentialVaultStorage(storage, options);
  const vault = createCredentialVault({ profileId: "synthetic-profile", randomBytes, storage: records, revokeAccess: async () => {} });
  await vault.create("synthetic-master-password");
  await vault.addFolder("fixture-folder", "synthetic-folder-password");
  await vault.lock();
  const reopened = createCredentialVault({ profileId: "synthetic-profile", randomBytes,
    storage: createCredentialVaultStorage(storage, options), revokeAccess: async () => {} });
  await reopened.unlock("synthetic-master-password");
  assert.equal(await reopened.folderPassword("fixture-folder"), "synthetic-folder-password");
  assert.equal([...files.values()].some(file => new TextDecoder().decode(file.bytes).includes("synthetic-folder-password")), false);
  const changing = createCredentialVaultStorage({ ...storage, readRange: async (path, offset, size) => {
    const value = await storage.readRange(path, offset, size);
    files.get(path)!.revision = "changed";
    return value;
  } }, options);
  await assert.rejects(changing.load(), /changed/);
  await reopened.close();
});

test("vault encrypts independent folder credentials and persists manual lock", async () => {
  let record: unknown = null;
  let remembered: string | null = null;
  let deviceUnlocked = true;
  let revoked = 0;
  const options = { profileId: "synthetic-profile", randomBytes,
    storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
      withLock: async <T>(operation: () => Promise<T>) => operation() },
    rememberedSecret: { load: async () => remembered, save: async (value: string) => { remembered = value; },
      remove: async () => { remembered = null; }, isDeviceUnlocked: async () => deviceUnlocked },
    revokeAccess: async () => { revoked++; },
  };
  const vault = createCredentialVault(options);
  assert.equal((await vault.initialize()).phase, "uninitialized");
  await vault.create("synthetic-master-password");
  await vault.addFolder("fixture-first");
  await vault.addFolder("fixture-imported", "synthetic-import-password");
  await vault.addFolder("fixture-second");
  const firstPassword = await vault.folderPassword("fixture-first");
  assert.match(firstPassword!, /^[a-f0-9]{64}$/);
  assert.equal(await vault.folderPassword("fixture-imported"), "synthetic-import-password");
  assert.notEqual(await vault.folderPassword("fixture-second"), firstPassword);
  await assert.rejects(vault.addFolder("fixture-first", "different"), /already/);
  const serialized = JSON.stringify(record);
  for (const secret of ["fixture-first", "synthetic-default-one", "synthetic-master-password"]) assert.equal(serialized.includes(secret), false);
  await vault.lock();
  assert.equal(revoked, 1);
  await assert.rejects(vault.folderPassword("fixture-first"), /locked/);
  const restarted = createCredentialVault(options);
  assert.equal((await restarted.initialize()).phase, "locked", "Remembered secret must not bypass manual lock");
  await assert.rejects(restarted.unlock("incorrect"));
  await restarted.unlock("synthetic-master-password");
  deviceUnlocked = false;
  assert.equal((await createCredentialVault(options).initialize()).phase, "locked");
  deviceUnlocked = true;
  const automatic = createCredentialVault(options);
  assert.equal((await automatic.initialize()).phase, "unlocked");
  await automatic.forgetRememberedSecret();
  assert.equal(remembered, null);
  assert.equal(await automatic.folderPassword("fixture-first"), firstPassword);
  assert.equal((await createCredentialVault(options).initialize()).phase, "locked");
  await restarted.close(); await automatic.close();
});

test("vault refuses corrupt storage and failed manual-lock persistence still revokes current access", async () => {
  let record: unknown = null;
  let failSave = false;
  let revoked = false;
  const vault = createCredentialVault({ profileId: "synthetic-profile", randomBytes,
    storage: { load: async () => record, save: async value => { if (failSave) throw new Error("storage failed"); record = value; },
      withLock: async operation => operation() }, revokeAccess: async () => { revoked = true; } });
  await vault.create("synthetic-master-password");
  failSave = true;
  await assert.rejects(vault.lock(), /storage failed/);
  assert.equal(revoked, true);
  await assert.rejects(vault.folderPassword("fixture"), /locked/);
  record = { format: 1, manualLocked: false, remember: true, ciphertext: [300] };
  await assert.rejects(vault.initialize(), /Invalid/);
});
