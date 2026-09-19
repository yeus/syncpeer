import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createCredentialVault } from "../packages/core/dist/sync/credentialVault.js";
import { createCredentialVaultStorage, createPersonalSpaceBootstrapStorage } from "../packages/core/dist/sync/credentialVaultStorage.js";
import { memoryReplicaStorage } from "./lan-test/replica-storage.ts";
import { deriveUntrustedFolderCrypto } from "@syncpeer/core/filesystem";
import { writeEncryptedRecord } from "../packages/core/dist/sync/encryptedRecord.js";

test("new personal-space vault wraps one stable random key instead of re-encrypting settings on password change", async () => {
  let record: unknown = null;
  let bootstrap: unknown = null;
  const options = { profileId: "personal-space-fixture", randomBytes,
    storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
      withLock: async <T>(operation: () => Promise<T>) => operation() },
    bootstrapStorage: { load: async () => structuredClone(bootstrap),
      save: async (value: unknown) => { bootstrap = structuredClone(value); },
      remove: async () => { bootstrap = null; } },
    revokeAccess: async () => {} };
  const vault = createCredentialVault(options);
  await vault.create("old-synthetic-master", false);
  await vault.addFolder("photos", "synthetic-folder-secret");
  assert.equal((record as { format: number }).format, 2);
  assert.equal(JSON.stringify(bootstrap).includes("personal-space-fixture"), false);
  const originalCiphertext = (record as { ciphertext: number[] }).ciphertext;
  const savedBootstrap = bootstrap;
  bootstrap = null;
  await vault.close();
  await assert.rejects(createCredentialVault(options).unlock("old-synthetic-master"));
  bootstrap = savedBootstrap;
  const changing = createCredentialVault(options);
  await changing.unlock("old-synthetic-master");
  await changing.changeMasterPassword("new-synthetic-master");
  assert.deepEqual((record as { ciphertext: number[] }).ciphertext, originalCiphertext);
  await changing.close();
  const reopened = createCredentialVault(options);
  await assert.rejects(reopened.unlock("old-synthetic-master"));
  await reopened.unlock("new-synthetic-master");
  assert.equal(await reopened.folderPassword("photos"), "synthetic-folder-secret");
  await reopened.close();
});

test("encrypted UI state survives lock and reopen without a plaintext copy", async () => {
  const makeStorage = () => {
    let record: unknown = null, bootstrap: unknown = null;
    return { profileId: "ui-state-fixture", randomBytes,
      storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
        withLock: async <T>(operation: () => Promise<T>) => operation() },
      bootstrapStorage: { load: async () => structuredClone(bootstrap),
        save: async (value: unknown) => { bootstrap = structuredClone(value); },
        remove: async () => { bootstrap = null; } },
      revokeAccess: async () => {},
      record: () => record };
  };
  const options = makeStorage();
  const vault = createCredentialVault(options);
  await vault.create("synthetic-master-password", false);
  assert.equal(await vault.uiState(), null);
  await vault.saveUiState({ approvals: ["device:folder"], offlineFolderSnapshots: { device: { lastSeenAtMs: 7 } } });
  await vault.close();
  assert.equal(JSON.stringify(options.record()).includes("device:folder"), false);
  const reopened = createCredentialVault(options);
  assert.equal((await reopened.initialize()).phase, "locked");
  await assert.rejects(reopened.uiState(), /locked/i);
  await reopened.unlock("synthetic-master-password");
  assert.deepEqual(await reopened.uiState(),
    { approvals: ["device:folder"], offlineFolderSnapshots: { device: { lastSeenAtMs: 7 } } });
  await reopened.saveUiState(null);
  assert.equal(await reopened.uiState(), null);
  await reopened.close();
});

test("offline recovery backup restores settings with a new device password and no old device secret", async () => {
  const makeStorage = () => {
    let record: unknown = null, bootstrap: unknown = null;
    return { profileId: "recovery-fixture", randomBytes,
      storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
        withLock: async <T>(operation: () => Promise<T>) => operation() },
      bootstrapStorage: { load: async () => structuredClone(bootstrap),
        save: async (value: unknown) => { bootstrap = structuredClone(value); },
        remove: async () => { bootstrap = null; } },
      revokeAccess: async () => {} };
  };
  const first = createCredentialVault(makeStorage());
  await first.create("first-device-password", false);
  await first.addFolder("photos", "synthetic-folder-secret");
  const backup = await first.exportRecoveryBackup("separate-offline-recovery-password");
  assert.equal(JSON.stringify(backup).includes("synthetic-folder-secret"), false);
  await first.changeMasterPassword("rotated-first-device-password");
  await first.close();
  const second = createCredentialVault(makeStorage());
  await assert.rejects(second.restoreRecoveryBackup(backup, "wrong-recovery-password", "second-device-password"));
  assert.equal(second.status().phase, "uninitialized");
  await second.restoreRecoveryBackup(backup, "separate-offline-recovery-password", "second-device-password");
  assert.equal(await second.folderPassword("photos"), "synthetic-folder-secret");
  await second.close();
  const tampered = structuredClone(backup);
  tampered.vault.ciphertext[0] ^= 1;
  const third = createCredentialVault(makeStorage());
  await assert.rejects(third.restoreRecoveryBackup(tampered, "separate-offline-recovery-password", "third-device-password"));
  assert.equal(third.status().phase, "uninitialized");
});

test("personal-space password change rolls back when its recovery record cannot be saved", async () => {
  let record: unknown = null, bootstrap: unknown = null, remembered: string | null = null;
  let failNextBootstrapSave = false;
  const options = { profileId: "personal-space-rollback", randomBytes,
    storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
      withLock: async <T>(operation: () => Promise<T>) => operation() },
    bootstrapStorage: { load: async () => structuredClone(bootstrap), save: async (value: unknown) => {
      if (failNextBootstrapSave) { failNextBootstrapSave = false; throw new Error("synthetic bootstrap failure"); }
      bootstrap = structuredClone(value);
    }, remove: async () => { bootstrap = null; } },
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => remembered,
      save: async (value: string) => { remembered = value; }, remove: async () => { remembered = null; } },
    revokeAccess: async () => {} };
  const vault = createCredentialVault(options);
  await vault.create("old-synthetic-master", true);
  failNextBootstrapSave = true;
  await assert.rejects(vault.changeMasterPassword("new-synthetic-master"), /bootstrap failure/);
  assert.equal(remembered, "old-synthetic-master");
  await vault.close();
  const reopened = createCredentialVault(options);
  await assert.rejects(reopened.unlock("new-synthetic-master"));
  await reopened.unlock("old-synthetic-master");
  await reopened.close();
});

test("failed first vault publication never deletes a possibly committed recovery key", async () => {
  let record: unknown = null, bootstrap: unknown = null;
  const options = { profileId: "personal-space-uncertain-write", randomBytes,
    storage: { load: async () => structuredClone(record), save: async (value: unknown) => {
      record = structuredClone(value);
      throw new Error("synthetic flush failure after commit");
    }, withLock: async <T>(operation: () => Promise<T>) => operation() },
    bootstrapStorage: { load: async () => structuredClone(bootstrap),
      save: async (value: unknown) => { bootstrap = structuredClone(value); },
      remove: async () => { bootstrap = null; } },
    revokeAccess: async () => {} };
  await assert.rejects(createCredentialVault(options).create("synthetic-master-password", false), /flush failure/);
  assert.equal((record as { format: number }).format, 2);
  assert.notEqual(bootstrap, null);
});

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

test("profile settings are encrypted, validated, and default to staggered versioning", async () => {
  let record: unknown = null;
  const vault = createCredentialVault({ profileId: "settings-profile", randomBytes,
    storage: { load: async () => structuredClone(record), save: async value => { record = structuredClone(value); },
      withLock: async operation => operation() }, revokeAccess: async () => {} });
  await vault.create("synthetic-master");
  const defaults = await vault.profileSettings();
  assert.equal(defaults.profile.versioning, "staggered");
  assert.equal(defaults.profile.cache.percent, 5);
  const settings = structuredClone(defaults);
  settings.folders.photos = { favorites: [{ key: "folder:photos:", folderId: "photos", path: "", name: "Photos", kind: "folder" }],
    exclusions: [{ folderId: "photos", path: "node_modules", kind: "folder" }],
    ignorePatterns: ["node_modules/"], paused: false };
  await vault.saveProfileSettings(settings);
  assert.equal(JSON.stringify(record).includes("node_modules"), false);
  assert.deepEqual(await vault.profileSettings(), settings);
  const invalid = structuredClone(settings);
  invalid.profile.cache.percent = 101;
  await assert.rejects(vault.saveProfileSettings(invalid), /cache settings/);
  await vault.close();
});

test("rotates the local master password and allows an authorized remembered unlock", async () => {
  let record: unknown = null;
  let remembered: string | null = null;
  const options = { profileId: "rotation-profile", randomBytes,
    storage: { load: async () => structuredClone(record), save: async value => { record = structuredClone(value); },
      withLock: async operation => operation() },
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => remembered,
      save: async value => { remembered = value; }, remove: async () => { remembered = null; } }, revokeAccess: async () => {} };
  const vault = createCredentialVault(options);
  await vault.createDeviceProtected();
  await vault.changeMasterPassword("synthetic-user-master");
  assert.equal(remembered, "synthetic-user-master");
  await vault.lock();
  await assert.rejects(vault.unlockRemembered(), /master password/);
  await vault.unlock("synthetic-user-master");
  await vault.lock();
  await assert.rejects(vault.unlock("wrong-password"));
  await vault.unlock("synthetic-user-master");
  await vault.close();
});

test("failed master-password rotation restores the old encrypted record and remembered secret", async () => {
  let record: unknown = null;
  let remembered: string | null = null;
  let failNextSave = false;
  const vault = createCredentialVault({ profileId: "rotation-rollback", randomBytes,
    storage: { load: async () => structuredClone(record), save: async value => {
      if (failNextSave) { failNextSave = false; throw new Error("synthetic storage failure"); }
      record = structuredClone(value);
    }, withLock: async operation => operation() },
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => remembered,
      save: async value => { remembered = value; }, remove: async () => { remembered = null; } },
    revokeAccess: async () => {},
  });
  await vault.create("synthetic-old-master");
  assert.equal(remembered, "synthetic-old-master");
  failNextSave = true;
  await assert.rejects(vault.changeMasterPassword("synthetic-new-master"), /storage failure/);
  assert.equal(remembered, "synthetic-old-master");
  await vault.lock();
  await assert.rejects(vault.unlockRemembered(), /master password/);
  await vault.unlock("synthetic-old-master");
  await vault.lock();
  await assert.rejects(vault.unlock("synthetic-new-master"));
  await vault.unlock("synthetic-old-master");
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

test("personal-space recovery is a separate bounded record without readable IDs or passwords", async () => {
  const { storage, files } = memoryReplicaStorage();
  const options = { withLock: async <T>(operation: () => Promise<T>) => operation(), checkHealth: async () => {} };
  const vault = createCredentialVault({ profileId: "synthetic-profile", randomBytes,
    storage: createCredentialVaultStorage(storage, options),
    bootstrapStorage: createPersonalSpaceBootstrapStorage(storage, options), revokeAccess: async () => {} });
  await vault.create("synthetic-master-password", false);
  assert.equal(files.has(".syncpeer-space"), true);
  assert.equal(files.has(".syncpeer-vault-record"), true);
  const visible = new TextDecoder().decode(files.get(".syncpeer-space")!.bytes);
  assert.equal(visible.includes("synthetic-master-password"), false);
  assert.equal(visible.includes("synthetic-profile"), false);
  await vault.close();
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

test("manual unlock preserves opt-out and missing remembered secrets require the password", async () => {
  let record: unknown = null, secret: string | null = null;
  const options = { profileId: "remember-policy-fixture", randomBytes,
    storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
      withLock: async <T>(operation: () => Promise<T>) => operation() },
    rememberedSecret: { load: async () => secret, save: async (value: string) => { secret = value; },
      remove: async () => { secret = null; }, isDeviceUnlocked: async () => true }, revokeAccess: async () => {} };
  const vault = createCredentialVault(options);
  await vault.create("synthetic-master-password", false);
  await vault.lock();
  await vault.unlock("synthetic-master-password");
  assert.equal(secret, null, "Unlock must not silently opt in to remembering");
  assert.equal(vault.status().remembered, false);
  await vault.close();
  const reopened = createCredentialVault(options);
  assert.equal((await reopened.initialize()).phase, "locked");
  await assert.rejects(reopened.unlockRemembered(), /unavailable/);
  await assert.rejects(reopened.unlock("wrong-password"));
  await reopened.unlock("synthetic-master-password");
  await reopened.close();
});

test("unlock falls back to the master password when the device or Keystore is unavailable", async () => {
  let record: unknown = null, bootstrap: unknown = null, secret: string | null = null;
  let deviceUnlocked = true, secretMissing = false;
  const options = { profileId: "unlock-fallback-fixture", randomBytes,
    storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
      withLock: async <T>(operation: () => Promise<T>) => operation() },
    bootstrapStorage: { load: async () => structuredClone(bootstrap),
      save: async (value: unknown) => { bootstrap = structuredClone(value); }, remove: async () => { bootstrap = null; } },
    rememberedSecret: { isDeviceUnlocked: async () => deviceUnlocked,
      load: async () => secretMissing ? null : secret, save: async (value: string) => { secret = value; },
      remove: async () => { secret = null; } }, revokeAccess: async () => {} };
  const vault = createCredentialVault(options);
  await vault.create("synthetic-master-password", true);
  await vault.addFolder("photos", "synthetic-folder-password");
  await vault.close();

  deviceUnlocked = false;
  const lockedDevice = createCredentialVault(options);
  assert.equal((await lockedDevice.initialize()).phase, "locked");
  await lockedDevice.close();
  deviceUnlocked = true; secretMissing = true;
  const missingSecret = createCredentialVault(options);
  assert.equal((await missingSecret.initialize()).phase, "locked");
  await assert.rejects(missingSecret.unlockRemembered(), /unavailable/);
  await assert.rejects(missingSecret.folderPassword("photos"), /locked/i, "A locked vault never leaks folder passwords");
  await assert.rejects(missingSecret.unlock("wrong-password"));
  await missingSecret.unlock("synthetic-master-password");
  assert.equal(await missingSecret.folderPassword("photos"), "synthetic-folder-password");
  await missingSecret.close();
  secretMissing = false;

  const locked = createCredentialVault(options);
  await locked.initialize();
  await locked.lock();
  await assert.rejects(locked.unlockRemembered(), /master password/);
  await locked.unlock("synthetic-master-password");
  assert.equal(await locked.folderPassword("photos"), "synthetic-folder-password");
  await locked.close();
});

test("failed password rotation and recovery keep the previous unlock path", async () => {
  let record: unknown = null, bootstrap: unknown = null, secret: string | null = null, failBootstrapSave = false;
  const options = { profileId: "rotation-safety-fixture", randomBytes,
    storage: { load: async () => structuredClone(record), save: async (value: unknown) => { record = structuredClone(value); },
      withLock: async <T>(operation: () => Promise<T>) => operation() },
    bootstrapStorage: { load: async () => structuredClone(bootstrap), save: async (value: unknown) => {
      if (failBootstrapSave) throw new Error("synthetic bootstrap failure");
      bootstrap = structuredClone(value);
    }, remove: async () => { bootstrap = null; } },
    rememberedSecret: { isDeviceUnlocked: async () => true, load: async () => secret,
      save: async (value: string) => { secret = value; }, remove: async () => { secret = null; } },
    revokeAccess: async () => {} };
  const vault = createCredentialVault(options);
  await vault.create("synthetic-master-password", true);
  await vault.addFolder("photos", "synthetic-folder-password");
  const originalCiphertext = (record as { ciphertext: number[] }).ciphertext.slice();
  const originalBootstrap = structuredClone(bootstrap);
  failBootstrapSave = true;
  await assert.rejects(vault.changeMasterPassword("synthetic-new-master"), /bootstrap failure/);
  assert.deepEqual(bootstrap, originalBootstrap);
  assert.deepEqual((record as { ciphertext: number[] }).ciphertext, originalCiphertext);
  failBootstrapSave = false;
  await vault.changeMasterPassword("synthetic-new-master");
  await assert.rejects(vault.unlock("synthetic-master-password"));
  assert.equal(await vault.folderPassword("photos"), "synthetic-folder-password");
  const backup = await vault.exportRecoveryBackup("synthetic-recovery-password");
  await vault.close();

  const occupied = createCredentialVault(options);
  await assert.rejects(occupied.restoreRecoveryBackup(backup, "synthetic-recovery-password", "synthetic-new-device"),
    /already exists/i, "Recovery never silently replaces an existing encrypted profile");
  await assert.rejects(occupied.create("synthetic-other-master"), /already/i);
  await occupied.unlock("synthetic-new-master");
  await occupied.close();
});
