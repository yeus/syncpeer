import { validateRegistrations, type FolderRegistration } from "./folderRegistry.js";
import { deriveUntrustedFolderCrypto } from "../core/model/untrusted.js";
import { scryptPasswordKdf, type PasswordKdf } from "../core/model/passwordKdf.js";
import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import { FOLDER_PASSWORD_SCOPE_SEPARATOR, isScopedFolderPasswordKey } from "../ui/sessionPasswords.js";
import { normalizeProfileSettings, type SyncpeerProfileSettings } from "./profileSettings.js";
import { createPersonalSpaceBootstrap, openPersonalSpaceBootstrap,
  personalVaultKey, settingsFolderPassword, wrapPersonalSpaceBootstrap,
  type PersonalSpace, type PersonalSpaceBootstrap } from "./personalSpaceBootstrap.js";
import type { PersonalSpacePairingTransfer } from "./personalSpacePairing.js";
import { createOwnedDeviceIdentity, openOwnedDeviceSigningKey, signOwnedRosterUpdate, verifyOwnedRoster,
  type OwnedDeviceIdentity, type OwnedRosterTrust, type OwnedSpaceDevice } from "./personalSpaceSharing.js";

export interface CredentialVaultRecord {
  format: 1 | 2;
  manualLocked: boolean;
  remember: boolean;
  ciphertext: number[];
}

/** Portable encrypted snapshot; it contains no device identity or remembered unlock secret. */
export interface PersonalSpaceRecoveryBackup {
  format: 1;
  bootstrap: PersonalSpaceBootstrap;
  vault: CredentialVaultRecord;
}

interface VaultData {
  format: 1;
  defaultPassword: string | null;
  folders: Record<string, string>;
  connectionPasswords?: Record<string, string>;
  settings?: SyncpeerProfileSettings;
  /** Device-local WebView state migrated out of plaintext browser storage. */
  uiState?: unknown;
  registrations?: FolderRegistration[];
  /** Device-local private identity; excluded from portable recovery and pairing transfers. */
  ownedDevice?: OwnedDeviceIdentity;
  /** Public signed history plus this device's pinned trust anchors. */
  trustedRoster?: OwnedRosterTrust;
}

export interface RememberedUnlockSecretStore {
  load: () => Promise<string | null>;
  save: (password: string) => Promise<void>;
  remove: () => Promise<void>;
  isDeviceUnlocked: () => Promise<boolean>;
}

const password = (value: unknown): string => {
  if (typeof value !== "string" || !value.length || value.length > 4096) throw new Error("Invalid vault password.");
  return value;
};

const validateConnectionPasswords = (data: VaultData, values: Record<string, string>) => {
  for (const [id, value] of Object.entries(values)) {
    const separator = id.indexOf(FOLDER_PASSWORD_SCOPE_SEPARATOR);
    const folderId = isScopedFolderPasswordKey(id) ? id.slice(separator + 1).trim() : id;
    if (Object.hasOwn(data.folders, folderId) && data.folders[folderId] !== value) {
      throw new Error("Folder password changes require migration; the saved password was not changed.");
    }
  }
};

const pairingSpace = (value: PersonalSpacePairingTransfer): PersonalSpace => {
  if (!value || !/^[a-f0-9]{32}$/.test(value.spaceId) ||
    !/^[a-f0-9]{32}$/.test(value.settingsFolderId) || !/^[a-f0-9]{64}$/.test(value.rootKey)) {
    throw new Error("Invalid personal-space pairing transfer.");
  }
  return { id: value.spaceId, settingsFolderId: value.settingsFolderId,
    rootKey: Uint8Array.from(value.rootKey.match(/../g)!, byte => Number.parseInt(byte, 16)) };
};

const decodeRecord = (value: unknown): CredentialVaultRecord | null => {
  if (value === null) return null;
  const record = value as CredentialVaultRecord;
  if (!record || (record.format !== 1 && record.format !== 2) || typeof record.manualLocked !== "boolean" || typeof record.remember !== "boolean" ||
    !Array.isArray(record.ciphertext) || !record.ciphertext.length || record.ciphertext.length > 2 * 1024 * 1024 ||
    record.ciphertext.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("Invalid credential vault record.");
  return record;
};

const decodeData = (bytes: Uint8Array): VaultData => {
  let data;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Invalid credential vault contents."); }
  if (!data || data.format !== 1 || !data.folders || typeof data.folders !== "object" || Array.isArray(data.folders) ||
    Object.keys(data.folders).length > 10000) throw new Error("Invalid credential vault contents.");
  if (data.defaultPassword !== null) password(data.defaultPassword);
  if (data.connectionPasswords !== undefined && (!data.connectionPasswords || typeof data.connectionPasswords !== "object" ||
    Array.isArray(data.connectionPasswords) || Object.keys(data.connectionPasswords).length > 10000)) throw new Error("Invalid credential vault contents.");
  for (const [id, value] of [...Object.entries(data.folders), ...Object.entries(data.connectionPasswords ?? {})]) {
    if (!id.length || id.length > 1024) throw new Error("Invalid vault folder identifier.");
    password(value);
  }
  normalizeProfileSettings(data.settings);
  if (data.registrations !== undefined) validateRegistrations(data.registrations);
  if (data.ownedDevice !== undefined && (!data.ownedDevice || typeof data.ownedDevice !== "object" ||
    typeof data.ownedDevice.privateKey !== "string" || !data.ownedDevice.privateKey)) {
    throw new Error("Invalid owned device identity.");
  }
  if (data.trustedRoster !== undefined && (!data.trustedRoster || typeof data.trustedRoster !== "object" ||
    typeof data.trustedRoster.genesisKey !== "string" || typeof data.trustedRoster.knownHead !== "string" ||
    !Array.isArray(data.trustedRoster.updates))) throw new Error("Invalid trusted device list.");
  return data;
};

/** One core vault owner per profile; platform ports only persist bytes and protect the unlock secret. */
export function createCredentialVault(options: {
  profileId: string;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
  storage: {
    load: () => Promise<unknown>;
    /** Durable atomic replacement; manual-lock intent and ciphertext travel together. */
    save: (record: CredentialVaultRecord) => Promise<void>;
    withLock: <T>(operation: () => Promise<T>) => Promise<T>;
  };
  bootstrapStorage?: {
    load: () => Promise<unknown>;
    save: (record: PersonalSpaceBootstrap) => Promise<void>;
    remove: () => Promise<void>;
  };
  rememberedSecret?: RememberedUnlockSecretStore;
  /** Defaults to the in-process scrypt derivation; platforms may inject a worker. */
  kdf?: PasswordKdf;
  subtle?: SubtleCrypto;
  /** Revoke plaintext views/handles; locked ciphertext sync is a separate capability. */
  revokeAccess: () => Promise<void>;
}) {
  if (typeof options.profileId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.profileId)) throw new Error("Invalid vault profile.");
  const kdf = options.kdf ?? scryptPasswordKdf;
  const subtle = options.subtle ?? crypto.subtle;
  const vaultId = `syncpeer-vault:${options.profileId}`;
  let key: Uint8Array | undefined;
  let personalSpace: PersonalSpace | undefined;
  let initialized = false;
  let remembered = false;
  let issue: string | undefined;
  let closed = false;
  let queue = Promise.resolve();
  let closeTask: Promise<void> | undefined;
  const status = () => ({ phase: closed ? "closed" as const : key ? "unlocked" as const : initialized ? "locked" as const : "uninitialized" as const,
    remembered, ...(issue ? { issue } : {}) });
  const run = <T>(operation: () => Promise<T>) => {
    if (closed) return Promise.reject(new Error("Credential vault is closed."));
    const task = queue.then(() => options.storage.withLock(operation));
    queue = task.then(() => {}, () => {});
    return task;
  };
  const revoke = async () => {
    try { await options.revokeAccess(); }
    finally { key?.fill(0); personalSpace?.rootKey.fill(0); key = undefined; personalSpace = undefined; }
  };
  const read = async (record: CredentialVaultRecord, secret: Uint8Array) => {
    const ciphertext = new Uint8Array(record.ciphertext);
    const bytes = await readEncryptedRecord({ size: ciphertext.length,
      readRange: async (offset, size) => ciphertext.slice(offset, offset + size) }, secret, ".syncpeer-vault");
    try { return decodeData(bytes); } finally { bytes.fill(0); }
  };
  const encrypt = async (data: VaultData, secret: Uint8Array,
    record: Pick<CredentialVaultRecord, "format" | "manualLocked" | "remember">) => {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let ciphertext = new Uint8Array();
    try {
      if (bytes.length > 1024 * 1024) throw new Error("Credential vault capacity exceeded.");
      decodeData(bytes);
      await writeEncryptedRecord({ name: ".syncpeer-vault", bytes, folderKey: secret, randomBytes: options.randomBytes,
        createSink: async (_info, size) => {
          ciphertext = new Uint8Array(size);
          return { write: async (offset, chunk) => { ciphertext.set(chunk, offset); }, commit: async () => {},
            abort: async () => { ciphertext.fill(0); } };
        } });
      const result: CredentialVaultRecord = { ...record, ciphertext: Array.from(ciphertext) };
      return result;
    } finally { bytes.fill(0); }
  };
  const save = async (data: VaultData, secret: Uint8Array,
    record: Pick<CredentialVaultRecord, "format" | "manualLocked" | "remember">) => {
    const result = await encrypt(data, secret, record);
    await options.storage.save(result);
    return result;
  };
  const unlock = async (masterPassword: string, record: CredentialVaultRecord) => {
    if (record.format === 2 && !options.bootstrapStorage) throw new Error("Personal-space recovery storage is unavailable.");
    const space = record.format === 2
      ? await openPersonalSpaceBootstrap(await options.bootstrapStorage!.load() as PersonalSpaceBootstrap,
          password(masterPassword), kdf)
      : undefined;
    const secret = space ? personalVaultKey(space)
      : (await deriveUntrustedFolderCrypto(vaultId, password(masterPassword), kdf)).folderKey;
    try {
      await read(record, secret); // Wrong passwords/corruption never reset the vault.
      await options.storage.save({ ...record, manualLocked: false });
      key?.fill(0); personalSpace?.rootKey.fill(0); key = secret; personalSpace = space;
      initialized = true; remembered = record.remember; issue = undefined;
    } catch (error) { secret.fill(0); space?.rootKey.fill(0); throw error; }
  };
  const unlocked = async () => {
    if (!key) throw new Error("Credential vault is locked.");
    const record = decodeRecord(await options.storage.load());
    if (!record) throw new Error("Credential vault is missing.");
    if (record.manualLocked) { await revoke(); throw new Error("Credential vault is locked."); }
    return { record, data: await read(record, key) };
  };
  /** Remembering intent lives in the vault record; a failed store write stays retryable. */
  const rememberSecret = async (masterPassword: string) => {
    if (!options.rememberedSecret) return;
    try {
      await options.rememberedSecret.save(masterPassword);
      remembered = true;
    } catch {
      remembered = false;
      issue = "Unlock secret could not be remembered; manual unlock remains available.";
    }
  };
  const update = (transform: (data: VaultData) => VaultData | Promise<VaultData>) => run(async () => {
    const { record, data } = await unlocked();
    await save(await transform(data), key!, record);
  });
  const verifyTrust = async (trust: OwnedRosterTrust, knownHead = trust.knownHead) => {
    if (!trust || trust.knownHead !== trust.updates.at(-1)?.hash) throw new Error("Invalid trusted device list.");
    return verifyOwnedRoster(subtle, trust.updates, trust.genesisKey, knownHead);
  };
  const prepareOwnedDevice = async (data: VaultData, syncthingId: string) => {
    if (!personalSpace) throw new Error("Only personal-space profiles have a trusted device list.");
    if (data.ownedDevice) {
      await openOwnedDeviceSigningKey(subtle, data.ownedDevice);
      if (!data.trustedRoster) throw new Error("Trusted device list is missing.");
      await verifyTrust(data.trustedRoster);
      if (data.ownedDevice.syncthingId === syncthingId) return data;
      const key = await openOwnedDeviceSigningKey(subtle, data.ownedDevice);
      const current = await verifyTrust(data.trustedRoster);
      const devices = current.devices.map(device => device.id === data.ownedDevice!.id
        ? { ...device, syncthingId,
            retiredSyncthingIds: [...new Set([...(device.retiredSyncthingIds ?? []), device.syncthingId])] }
        : device);
      const update = await signOwnedRosterUpdate(subtle, key, { sequence: data.trustedRoster.updates.length + 1,
        previous: data.trustedRoster.knownHead, signer: data.ownedDevice.id, devices,
        recoveryKey: data.trustedRoster.updates[0].recoveryKey });
      return { ...data, ownedDevice: { ...data.ownedDevice, syncthingId },
        trustedRoster: { ...data.trustedRoster, knownHead: update.hash,
          updates: [...data.trustedRoster.updates, update] } };
    }
    if (data.trustedRoster) throw new Error("This recovered profile requires trusted-device recovery enrollment.");
    const identity = await createOwnedDeviceIdentity(subtle, options.randomBytes, syncthingId);
    const key = await openOwnedDeviceSigningKey(subtle, identity);
    const device = { id: identity.id, syncthingId: identity.syncthingId,
      state: identity.state, signingKey: identity.signingKey };
    const genesis = await signOwnedRosterUpdate(subtle, key,
      { sequence: 1, previous: null, signer: identity.id, devices: [device] });
    return { ...data, ownedDevice: identity,
      trustedRoster: { genesisKey: identity.signingKey, knownHead: genesis.hash, updates: [genesis] } };
  };
  return {
    status,
    createDeviceProtected: () => run(async () => {
      if (!options.rememberedSecret) throw new Error("Secure device storage is required.");
      if (key || initialized || decodeRecord(await options.storage.load())) throw new Error("Credential vault already exists.");
      if (!await options.rememberedSecret.isDeviceUnlocked()) throw new Error("Unlock the device first.");
      const random = await options.randomBytes(32);
      let derived: Awaited<ReturnType<typeof deriveUntrustedFolderCrypto>> | undefined;
      try {
        if (random.length !== 32) throw new Error("Invalid random secret length.");
        const secret = [...random].map(byte => byte.toString(16).padStart(2, "0")).join("");
        // Persist and verify recovery before publishing ciphertext encrypted with a generated secret.
        await options.rememberedSecret.save(secret);
        if (await options.rememberedSecret.load() !== secret) throw new Error("Secure device storage verification failed.");
        derived = await deriveUntrustedFolderCrypto(vaultId, secret, kdf);
        await save({ format: 1, defaultPassword: null, folders: {} }, derived.folderKey,
          { format: 1, manualLocked: false, remember: true });
        key = derived.folderKey; initialized = true; remembered = true; issue = undefined;
        return status();
      } catch (error) { derived?.folderKey.fill(0); throw error; }
      finally { random.fill(0); }
    }),
    initialize: () => run(async () => {
      if (key) throw new Error("Credential vault is already unlocked.");
      const record = decodeRecord(await options.storage.load());
      initialized = !!record; remembered = record?.remember ?? false;
      if (record && record.remember && !record.manualLocked && options.rememberedSecret) {
        try {
          if (await options.rememberedSecret.isDeviceUnlocked()) {
            const masterPassword = await options.rememberedSecret.load();
            if (masterPassword !== null) await unlock(masterPassword, record);
          }
        } catch { issue = "Automatic unlock failed; enter the master password."; }
      }
      return status();
    }),
    create: (masterPassword: string, remember = true) => run(async () => {
      if (key || initialized) throw new Error("Credential vault already initialized; recover missing storage instead of replacing it.");
      if (decodeRecord(await options.storage.load())) throw new Error("Credential vault already exists.");
      if (options.bootstrapStorage) {
        if (await options.bootstrapStorage.load() !== null) throw new Error("Personal-space recovery record already exists.");
        const { record: bootstrap, space } = await createPersonalSpaceBootstrap(password(masterPassword), options.randomBytes, kdf);
        let secret: Uint8Array | undefined;
        try {
          await options.bootstrapStorage.save(bootstrap);
          secret = personalVaultKey(space);
          await save({ format: 1, defaultPassword: null, folders: {} }, secret,
            { format: 2, manualLocked: false, remember });
          key = secret; personalSpace = space; initialized = true;
          if (remember) await rememberSecret(masterPassword);
          return status();
        } catch (error) {
          if (!initialized) {
            secret?.fill(0);
            space.rootKey.fill(0);
            // A failed save may have committed the vault before its flush failed.
            // Keep the wrapped root key so that record remains recoverable.
          }
          throw error;
        }
      }
      const derived = await deriveUntrustedFolderCrypto(vaultId, password(masterPassword), kdf);
      try {
        await save({ format: 1, defaultPassword: null, folders: {} }, derived.folderKey,
          { format: 1, manualLocked: false, remember });
        key = derived.folderKey; initialized = true;
        if (remember) await rememberSecret(masterPassword);
        return status();
      } catch (error) { derived.folderKey.fill(0); throw error; }
    }),
    exportRecoveryBackup: (recoveryPassword: string) => run(async (): Promise<PersonalSpaceRecoveryBackup> => {
      const { record, data } = await unlocked();
      if (record.format !== 2 || !personalSpace) throw new Error("Only personal-space profiles can be backed up.");
      const bootstrap = await wrapPersonalSpaceBootstrap(personalSpace, recoveryPassword, options.randomBytes, kdf);
      const vault = await encrypt({ ...data, registrations: undefined, uiState: undefined, ownedDevice: undefined }, key!,
        { format: 2, manualLocked: false, remember: false });
      return { format: 1, bootstrap, vault };
    }),
    exportPairingTransfer: (localSyncthingId: string, joiningDevice: OwnedSpaceDevice) => run(async (): Promise<PersonalSpacePairingTransfer> => {
      const { record, data: stored } = await unlocked();
      if (!personalSpace) throw new Error("Only personal-space profiles can pair devices.");
      let data = await prepareOwnedDevice(stored, localSyncthingId);
      const current = await verifyTrust(data.trustedRoster!);
      if (!current.devices.some(device => device.id === data.ownedDevice!.id && device.state === "active")) {
        throw new Error("This device is no longer active in the trusted device list.");
      }
      const existing = current.devices.find(device => device.id === joiningDevice.id ||
        device.syncthingId === joiningDevice.syncthingId || device.signingKey === joiningDevice.signingKey);
      if (existing && (existing.id !== joiningDevice.id || existing.syncthingId !== joiningDevice.syncthingId ||
        existing.signingKey !== joiningDevice.signingKey || existing.state !== "active")) {
        throw new Error("Joining device conflicts with the trusted device list.");
      }
      if (!existing) {
        const signingKey = await openOwnedDeviceSigningKey(subtle, data.ownedDevice!);
        const update = await signOwnedRosterUpdate(subtle, signingKey, {
          sequence: data.trustedRoster!.updates.length + 1, previous: data.trustedRoster!.knownHead,
          signer: data.ownedDevice!.id, devices: [...current.devices, joiningDevice],
          recoveryKey: data.trustedRoster!.updates[0].recoveryKey,
        });
        data = { ...data, trustedRoster: { ...data.trustedRoster!, knownHead: update.hash,
          updates: [...data.trustedRoster!.updates, update] } };
      }
      await save(data, key!, record);
      return { spaceId: personalSpace.id, settingsFolderId: personalSpace.settingsFolderId,
        rootKey: [...personalSpace.rootKey].map(byte => byte.toString(16).padStart(2, "0")).join(""),
        trust: data.trustedRoster! };
    }),
    ownedRoster: () => run(async () => {
      const { data } = await unlocked();
      if (!data.trustedRoster) return null;
      const verified = await verifyTrust(data.trustedRoster);
      return { trust: data.trustedRoster, localDeviceId: data.ownedDevice?.id ?? null,
        devices: verified.devices };
    }),
    acceptOwnedRoster: (trust: OwnedRosterTrust) => run(async () => {
      const { record, data } = await unlocked();
      if (!data.trustedRoster || trust.genesisKey !== data.trustedRoster.genesisKey) {
        throw new Error("Trusted device list genesis does not match.");
      }
      await verifyTrust(trust, data.trustedRoster.knownHead);
      if (trust.updates.length < data.trustedRoster.updates.length) throw new Error("Trusted device list rollback detected.");
      await save({ ...data, trustedRoster: trust }, key!, record);
    }),
    revokeOwnedDevice: (deviceId: string) => run(async () => {
      const { record, data } = await unlocked();
      if (!data.ownedDevice || !data.trustedRoster) throw new Error("Trusted device administration is unavailable.");
      if (deviceId === data.ownedDevice.id) throw new Error("The current device cannot revoke itself.");
      const verified = await verifyTrust(data.trustedRoster);
      const target = verified.devices.find(device => device.id === deviceId);
      if (!target) throw new Error("Trusted device was not found.");
      if (target.state === "revoked") return data.trustedRoster;
      const signingKey = await openOwnedDeviceSigningKey(subtle, data.ownedDevice);
      const rosterUpdate = await signOwnedRosterUpdate(subtle, signingKey, {
        sequence: data.trustedRoster.updates.length + 1, previous: data.trustedRoster.knownHead,
        signer: data.ownedDevice.id,
        devices: verified.devices.map(device => device.id === deviceId ? { ...device, state: "revoked" as const } : device),
        recoveryKey: data.trustedRoster.updates[0].recoveryKey,
      });
      const trust = { ...data.trustedRoster, knownHead: rosterUpdate.hash,
        updates: [...data.trustedRoster.updates, rosterUpdate] };
      await save({ ...data, trustedRoster: trust }, key!, record);
      return trust;
    }),
    personalSpaceFolder: () => run(async () => {
      await unlocked();
      return personalSpace ? { id: personalSpace.settingsFolderId,
        password: settingsFolderPassword(personalSpace) } : null;
    }),
    initializeOwnedDevice: (syncthingId: string) => run(async () => {
      const { record, data } = await unlocked();
      const prepared = await prepareOwnedDevice(data, syncthingId);
      await save(prepared, key!, record);
      return prepared.trustedRoster!;
    }),
    importPairingTransfer: (transfer: PersonalSpacePairingTransfer, identity: OwnedDeviceIdentity, localMasterPassword: string,
      remember = true) => run(async () => {
      if (!options.bootstrapStorage) throw new Error("Personal-space recovery storage is unavailable.");
      if (key || initialized || decodeRecord(await options.storage.load()) ||
        await options.bootstrapStorage.load() !== null) {
        throw new Error("Local profile already exists; pairing cannot replace it.");
      }
      const space = pairingSpace(transfer);
      let secret: Uint8Array | undefined;
      try {
        await openOwnedDeviceSigningKey(subtle, identity);
        const roster = await verifyTrust(transfer.trust);
        const enrolled = roster.devices.find(device => device.id === identity.id);
        if (!enrolled || enrolled.syncthingId !== identity.syncthingId ||
          enrolled.signingKey !== identity.signingKey || enrolled.state !== "active") {
          throw new Error("Pairing transfer did not enroll this device.");
        }
        const bootstrap = await wrapPersonalSpaceBootstrap(space, password(localMasterPassword), options.randomBytes, kdf);
        await options.bootstrapStorage.save(bootstrap);
        secret = personalVaultKey(space);
        await save({ format: 1, defaultPassword: null, folders: {}, ownedDevice: identity,
          trustedRoster: transfer.trust }, secret,
          { format: 2, manualLocked: false, remember });
        key = secret; personalSpace = space; initialized = true; remembered = remember; issue = undefined;
        if (remember) await rememberSecret(localMasterPassword);
        return status();
      } catch (error) {
        if (!initialized) { secret?.fill(0); space.rootKey.fill(0); }
        throw error;
      }
    }),
    restoreRecoveryBackup: (backup: PersonalSpaceRecoveryBackup, recoveryPassword: string,
      localMasterPassword: string) => run(async () => {
      if (!options.bootstrapStorage) throw new Error("Personal-space recovery storage is unavailable.");
      if (key || initialized || decodeRecord(await options.storage.load()) ||
        await options.bootstrapStorage.load() !== null) throw new Error("Local profile already exists; recovery cannot replace it.");
      if (!backup || backup.format !== 1) throw new Error("Invalid personal-space recovery backup.");
      const record = decodeRecord(backup.vault);
      if (!record || record.format !== 2) throw new Error("Invalid personal-space recovery backup.");
      const space = await openPersonalSpaceBootstrap(backup.bootstrap, password(recoveryPassword), kdf);
      const secret = personalVaultKey(space);
      try {
        await read(record, secret);
        const localBootstrap = await wrapPersonalSpaceBootstrap(space, password(localMasterPassword), options.randomBytes, kdf);
        await options.bootstrapStorage.save(localBootstrap);
        await options.storage.save({ ...record, manualLocked: false, remember: false });
        key = secret; personalSpace = space; initialized = true; remembered = false; issue = undefined;
        return status();
      } catch (error) { secret.fill(0); space.rootKey.fill(0); throw error; }
    }),
    unlock: (masterPassword: string) => run(async () => {
      const record = decodeRecord(await options.storage.load());
      if (!record) throw new Error("Credential vault is missing.");
      await unlock(masterPassword, record);
      if (record.remember) await rememberSecret(masterPassword);
      return status();
    }),
    unlockRemembered: () => run(async () => {
      const record = decodeRecord(await options.storage.load());
      if (record?.manualLocked) throw new Error("Enter the master password after explicit lock.");
      if (!record?.remember || !await options.rememberedSecret?.isDeviceUnlocked()) {
        throw new Error("A remembered unlock secret is unavailable.");
      }
      const masterPassword = await options.rememberedSecret?.load();
      if (!record || !masterPassword) throw new Error("A remembered unlock secret is unavailable.");
      await unlock(masterPassword, record);
      return status();
    }),
    changeMasterPassword: (newPassword: string) => run(async () => {
      const { record, data } = await unlocked();
      const nextPassword = password(newPassword);
      if (record.format === 2) {
        if (!options.bootstrapStorage || !personalSpace) throw new Error("Personal-space recovery storage is unavailable.");
        const current = await options.bootstrapStorage.load() as PersonalSpaceBootstrap;
        const oldPassword = await options.rememberedSecret?.load();
        const next = await wrapPersonalSpaceBootstrap(personalSpace, nextPassword, options.randomBytes, kdf);
        try {
          if (record.remember && options.rememberedSecret) await options.rememberedSecret.save(nextPassword);
          await options.bootstrapStorage.save(next);
          issue = undefined;
          return status();
        } catch (error) {
          if (record.remember && options.rememberedSecret) {
            if (oldPassword) await options.rememberedSecret.save(oldPassword).catch(() => {});
            else await options.rememberedSecret.remove().catch(() => {});
          }
          await options.bootstrapStorage.save(current).catch(() => {
            issue = "Master password change needs recovery; try the previous password.";
          });
          throw error;
        }
      }
      const oldKey = key!;
      const oldRemembered = await options.rememberedSecret?.load();
      const derived = await deriveUntrustedFolderCrypto(vaultId, nextPassword, kdf);
      try {
        const nextRecord = await encrypt(data, derived.folderKey,
          { format: 1, manualLocked: false, remember: record.remember });
        if (record.remember && options.rememberedSecret) await options.rememberedSecret.save(nextPassword);
        await options.storage.save(nextRecord);
        oldKey.fill(0);
        key = derived.folderKey;
        initialized = true;
        remembered = record.remember;
        issue = undefined;
        return status();
      } catch (error) {
        derived.folderKey.fill(0);
        try {
          if (record.remember && options.rememberedSecret) {
            if (oldRemembered === null || oldRemembered === undefined) await options.rememberedSecret.remove();
            else await options.rememberedSecret.save(oldRemembered);
          }
          await options.storage.save(record);
        } catch { issue = "Master password rotation needs recovery; the previous unlock may be required."; }
        throw error;
      }
    }),
    lock: () => run(async () => {
      try {
        const record = decodeRecord(await options.storage.load());
        if (record) await options.storage.save({ ...record, manualLocked: true });
      } finally { await revoke(); }
      return status();
    }),
    folderPassword: (folderId: string) => run(async () => {
      const { data } = await unlocked();
      return Object.hasOwn(data.folders, folderId) ? data.folders[folderId] : null;
    }),
    connectionPasswords: () => run(async () => {
      const { data } = await unlocked();
      return { ...data.connectionPasswords };
    }),
    saveConnectionPasswords: (values: Record<string, string>) => update(data => {
      validateConnectionPasswords(data, values);
      return { ...data, connectionPasswords: { ...values } };
    }),
    mergeConnectionPasswords: (values: Record<string, string>) => update(data => {
      validateConnectionPasswords(data, values);
      return { ...data, connectionPasswords: { ...values, ...data.connectionPasswords } };
    }),
    profileSettings: () => run(async () => {
      const { data } = await unlocked();
      return normalizeProfileSettings(data.settings);
    }),
    registrations: () => run(async () => (await unlocked()).data.registrations ?? null),
    saveRegistrations: (folders: FolderRegistration[]) => update(data =>
      ({ ...data, registrations: validateRegistrations(folders) })),
    uiState: () => run(async () => {
      const { data } = await unlocked();
      return data.uiState ?? null;
    }),
    saveUiState: (value: unknown) => update(data => ({ ...data, uiState: value === null ? undefined : value })),
    saveProfileSettings: (settings: SyncpeerProfileSettings) => update(data =>
      ({ ...data, settings: normalizeProfileSettings(settings) })),
    addFolder: (folderId: string, value?: string) => update(async data => {
      if (Object.hasOwn(data.folders, folderId)) throw new Error("Folder credentials already exist; password changes require migration.");
      const selected = value === undefined ? null : password(value);
      const generated = selected === null ? await options.randomBytes(32) : undefined;
      try {
        if (generated && generated.length !== 32) throw new Error("Invalid random password length.");
        const secret = selected ?? [...generated!].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return { ...data, folders: { ...data.folders, [folderId]: secret } };
      } finally { generated?.fill(0); }
    }),
    forgetRememberedSecret: () => run(async () => {
      const record = decodeRecord(await options.storage.load());
      if (record) await options.storage.save({ ...record, remember: false });
      remembered = false;
      await options.rememberedSecret?.remove();
    }),
    close: () => {
      closed = true;
      closeTask ??= queue.then(revoke).catch(error => { closeTask = undefined; throw error; });
      return closeTask;
    },
  };
}
