import { validateRegistrations, type FolderRegistration } from "./folderRegistry.js";
import { deriveUntrustedFolderCrypto } from "../core/model/untrusted.js";
import { scryptPasswordKdf, type PasswordKdf } from "../core/model/passwordKdf.js";
import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import { FOLDER_PASSWORD_SCOPE_SEPARATOR, isScopedFolderPasswordKey } from "../ui/sessionPasswords.js";
import { normalizeProfileSettings, type SyncpeerProfileSettings } from "./profileSettings.js";
import { createPersonalSpaceBootstrap, openPersonalSpaceBootstrap,
  personalVaultKey, wrapPersonalSpaceBootstrap, type PersonalSpace, type PersonalSpaceBootstrap } from "./personalSpaceBootstrap.js";

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
  /** Revoke plaintext views/handles; locked ciphertext sync is a separate capability. */
  revokeAccess: () => Promise<void>;
}) {
  if (typeof options.profileId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.profileId)) throw new Error("Invalid vault profile.");
  const kdf = options.kdf ?? scryptPasswordKdf;
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
      const vault = await encrypt({ ...data, registrations: undefined, uiState: undefined }, key!,
        { format: 2, manualLocked: false, remember: false });
      return { format: 1, bootstrap, vault };
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
      for (const [id, value] of Object.entries(values)) {
        const folderId = isScopedFolderPasswordKey(id) ? id.slice(id.indexOf(FOLDER_PASSWORD_SCOPE_SEPARATOR) + 1).trim() : id;
        if (Object.hasOwn(data.folders, folderId) && data.folders[folderId] !== value) {
          throw new Error("Folder password changes require migration; the saved password was not changed.");
        }
      }
      return { ...data, connectionPasswords: { ...values } };
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
