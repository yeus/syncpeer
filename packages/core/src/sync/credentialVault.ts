import { deriveUntrustedFolderCrypto } from "../core/model/untrusted.js";
import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";

export interface CredentialVaultRecord {
  format: 1;
  manualLocked: boolean;
  remember: boolean;
  ciphertext: number[];
}

interface VaultData {
  format: 1;
  defaultPassword: string | null;
  folders: Record<string, string>;
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
  if (!record || record.format !== 1 || typeof record.manualLocked !== "boolean" || typeof record.remember !== "boolean" ||
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
  for (const [id, value] of Object.entries(data.folders)) {
    if (!id.length || id.length > 1024) throw new Error("Invalid vault folder identifier.");
    password(value);
  }
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
  rememberedSecret?: RememberedUnlockSecretStore;
  /** Revoke plaintext views/handles; locked ciphertext sync is a separate capability. */
  revokeAccess: () => Promise<void>;
}) {
  if (typeof options.profileId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.profileId)) throw new Error("Invalid vault profile.");
  const vaultId = `syncpeer-vault:${options.profileId}`;
  let key: Uint8Array | undefined;
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
    finally { key?.fill(0); key = undefined; }
  };
  const read = async (record: CredentialVaultRecord, secret: Uint8Array) => {
    const ciphertext = new Uint8Array(record.ciphertext);
    const bytes = await readEncryptedRecord({ size: ciphertext.length,
      readRange: async (offset, size) => ciphertext.slice(offset, offset + size) }, secret, ".syncpeer-vault");
    try { return decodeData(bytes); } finally { bytes.fill(0); }
  };
  const save = async (data: VaultData, secret: Uint8Array, record: Pick<CredentialVaultRecord, "manualLocked" | "remember">) => {
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
      const result: CredentialVaultRecord = { format: 1, ...record, ciphertext: Array.from(ciphertext) };
      await options.storage.save(result);
      return result;
    } finally { bytes.fill(0); }
  };
  const unlock = async (masterPassword: string, record: CredentialVaultRecord) => {
    const derived = await deriveUntrustedFolderCrypto(vaultId, password(masterPassword));
    try {
      await read(record, derived.folderKey); // Wrong passwords/corruption never reset the vault.
      await options.storage.save({ ...record, manualLocked: false });
      key?.fill(0); key = derived.folderKey;
      initialized = true; remembered = record.remember; issue = undefined;
    } catch (error) { derived.folderKey.fill(0); throw error; }
  };
  const unlocked = async () => {
    if (!key) throw new Error("Credential vault is locked.");
    const record = decodeRecord(await options.storage.load());
    if (!record) throw new Error("Credential vault is missing.");
    if (record.manualLocked) { await revoke(); throw new Error("Credential vault is locked."); }
    return { record, data: await read(record, key) };
  };
  const update = (transform: (data: VaultData) => VaultData) => run(async () => {
    const { record, data } = await unlocked();
    await save(transform(data), key!, record);
  });
  return {
    status,
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
      const derived = await deriveUntrustedFolderCrypto(vaultId, password(masterPassword));
      try {
        const record = await save({ format: 1, defaultPassword: null, folders: {} }, derived.folderKey, { manualLocked: false, remember: false });
        key = derived.folderKey; initialized = true;
        if (remember && options.rememberedSecret) {
          try {
            await options.rememberedSecret.save(masterPassword);
            await options.storage.save({ ...record, remember: true });
            remembered = true;
          } catch { issue = "Unlock secret could not be remembered; manual unlock remains available."; }
        }
        return status();
      } catch (error) { derived.folderKey.fill(0); throw error; }
    }),
    unlock: (masterPassword: string) => run(async () => {
      const record = decodeRecord(await options.storage.load());
      if (!record) throw new Error("Credential vault is missing.");
      await unlock(masterPassword, record);
      return status();
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
    setDefaultPassword: (value: string | null) => update(data => ({ ...data, defaultPassword: value === null ? null : password(value) })),
    addFolder: (folderId: string, value?: string) => update(data => {
      if (Object.hasOwn(data.folders, folderId)) throw new Error("Folder credentials already exist; password changes require migration.");
      const selected = value === undefined ? data.defaultPassword : password(value);
      if (selected === null) throw new Error("A folder password or default is required.");
      return { ...data, folders: { ...data.folders, [folderId]: selected } };
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
