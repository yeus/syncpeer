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
import { createOwnedDeviceIdentity, openOwnedRecoveryKit, openOwnedDeviceSigningKey, signSpaceMembershipUpdate,
  validateOwnedRecoveryPublicKey, verifySpaceDeviceMembership, type OwnedDeviceIdentity, type OwnedRecoveryKit, type SpaceDeviceMembershipTrust,
  type OwnedSpaceDevice } from "./personalSpaceSharing.js";
import { signPersonalSpaceChange, type PersonalSpaceChange } from "./personalSpaceChanges.js";
import { createDangerousLocalRelease, signReplicaCompletion, signRetentionReleaseProposal,
  type DangerousLocalRelease, type LocalReleaseRecord, type ReplicaCompletion,
  type RetentionReleaseProposal } from "./folderRetention.js";

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
  /** Persisted v1 key: public signed history plus this device's pinned trust anchors. */
  trustedRoster?: SpaceDeviceMembershipTrust;
  localReleases?: Array<{ record: LocalReleaseRecord; pending: boolean }>;
}

export interface RememberedUnlockSecretStore {
  load: () => Promise<string | null>;
  save: (password: string) => Promise<void>;
  remove: () => Promise<void>;
  /**
   * Report whether the remembered secret is usable. Desktop platforms with a
   * locked system keyring request its unlock prompt and wait for the user
   * instead of failing, so automatic vault unlock can continue afterwards.
   */
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
  let data: VaultData;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as VaultData; }
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
  if (data.localReleases !== undefined && (!Array.isArray(data.localReleases) ||
    data.localReleases.length > 1000 || data.localReleases.some(entry => !entry ||
      typeof entry.pending !== "boolean" || !entry.record ||
      (entry.record.kind === "safe" ? !entry.record.proposal || !Array.isArray(entry.record.completions)
        : entry.record.kind === "dangerous" ? !entry.record.exception : true)))) {
    throw new Error("Invalid local release history.");
  }
  return data;
};

/** One core vault owner per profile; platform ports only persist bytes and protect the unlock secret. */
export type CredentialVaultOptions = {
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
};

class CredentialVault {
  private readonly options: CredentialVaultOptions;
  private readonly kdf: PasswordKdf;
  private readonly subtle: SubtleCrypto;
  private readonly vaultId: string;
  private key: Uint8Array | undefined;
  private personalSpace: PersonalSpace | undefined;
  private initialized = false;
  private remembered = false;
  private issue: string | undefined;
  private closed = false;
  private queue = Promise.resolve();
  private closeTask: Promise<void> | undefined;

  constructor(options: CredentialVaultOptions) {
    if (typeof options.profileId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.profileId)) {
      throw new Error("Invalid vault profile.");
    }
    this.options = options;
    this.kdf = options.kdf ?? scryptPasswordKdf;
    this.subtle = options.subtle ?? crypto.subtle;
    this.vaultId = `syncpeer-vault:${options.profileId}`;
  }

  status() {
    return {
      phase: this.closed ? "closed" as const : this.key ? "unlocked" as const
        : this.initialized ? "locked" as const : "uninitialized" as const,
      remembered: this.remembered,
      ...(this.issue ? { issue: this.issue } : {}),
    };
  }

  private run<T>(operation: () => Promise<T>) {
    if (this.closed) return Promise.reject(new Error("Credential vault is closed."));
    const task = this.queue.then(() => this.options.storage.withLock(operation));
    this.queue = task.then(() => {}, () => {});
    return task;
  }

  private async revoke() {
    try {
      await this.options.revokeAccess();
    } finally {
      this.key?.fill(0);
      this.personalSpace?.rootKey.fill(0);
      this.key = undefined;
      this.personalSpace = undefined;
    }
  }

  private async read(record: CredentialVaultRecord, secret: Uint8Array) {
    const ciphertext = new Uint8Array(record.ciphertext);
    const bytes = await readEncryptedRecord({ size: ciphertext.length,
      readRange: async (offset, size) => ciphertext.slice(offset, offset + size) }, secret, ".syncpeer-vault");
    try {
      return decodeData(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  private async encrypt(
    data: VaultData,
    secret: Uint8Array,
    record: Pick<CredentialVaultRecord, "format" | "manualLocked" | "remember">,
  ) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let ciphertext = new Uint8Array();
    try {
      if (bytes.length > 1024 * 1024) throw new Error("Credential vault capacity exceeded.");
      decodeData(bytes);
      await writeEncryptedRecord({ name: ".syncpeer-vault", bytes, folderKey: secret,
        randomBytes: this.options.randomBytes,
        createSink: async (_info, size) => {
          ciphertext = new Uint8Array(size);
          return { write: async (offset, chunk) => { ciphertext.set(chunk, offset); }, commit: async () => {},
            abort: async () => { ciphertext.fill(0); } };
        } });
      return { ...record, ciphertext: Array.from(ciphertext) };
    } finally {
      bytes.fill(0);
    }
  }

  private async save(
    data: VaultData,
    secret: Uint8Array,
    record: Pick<CredentialVaultRecord, "format" | "manualLocked" | "remember">,
  ) {
    const result = await this.encrypt(data, secret, record);
    await this.options.storage.save(result);
    return result;
  }

  private async unlockRecord(masterPassword: string, record: CredentialVaultRecord) {
    if (record.format === 2 && !this.options.bootstrapStorage) {
      throw new Error("Personal-space recovery storage is unavailable.");
    }
    const space = record.format === 2
      ? await openPersonalSpaceBootstrap(await this.options.bootstrapStorage!.load() as PersonalSpaceBootstrap,
          password(masterPassword), this.kdf)
      : undefined;
    const secret = space ? personalVaultKey(space)
      : (await deriveUntrustedFolderCrypto(this.vaultId, password(masterPassword), this.kdf)).folderKey;
    try {
      await this.read(record, secret); // Wrong passwords/corruption never reset the vault.
      await this.options.storage.save({ ...record, manualLocked: false });
      this.key?.fill(0);
      this.personalSpace?.rootKey.fill(0);
      this.key = secret;
      this.personalSpace = space;
      this.initialized = true;
      this.remembered = record.remember;
      this.issue = undefined;
    } catch (error) {
      secret.fill(0);
      space?.rootKey.fill(0);
      throw error;
    }
  }

  private async unlocked() {
    if (!this.key) throw new Error("Credential vault is locked.");
    const record = decodeRecord(await this.options.storage.load());
    if (!record) throw new Error("Credential vault is missing.");
    if (record.manualLocked) {
      await this.revoke();
      throw new Error("Credential vault is locked.");
    }
    return { record, data: await this.read(record, this.key) };
  }

  /** Remembering intent lives in the vault record; a failed store write stays retryable. */
  private async rememberSecret(masterPassword: string) {
    if (!this.options.rememberedSecret) return;
    try {
      await this.options.rememberedSecret.save(masterPassword);
      this.remembered = true;
    } catch {
      this.remembered = false;
      this.issue = "Unlock secret could not be remembered; manual unlock remains available.";
    }
  }

  private update(transform: (data: VaultData) => VaultData | Promise<VaultData>) {
    return this.run(async () => {
      const { record, data } = await this.unlocked();
      await this.save(await transform(data), this.key!, record);
    });
  }

  private async verifyTrust(trust: SpaceDeviceMembershipTrust, knownHead = trust.knownHead) {
    if (!trust || trust.knownHead !== trust.updates.at(-1)?.hash) throw new Error("Invalid trusted device list.");
    return verifySpaceDeviceMembership(this.subtle, trust.updates, trust.genesisKey, knownHead);
  }

  private async prepareOwnedDevice(
    space: PersonalSpace | undefined,
    data: VaultData,
    syncthingId: string,
    recoveryKey?: string,
  ) {
    if (!space) throw new Error("Only personal-space profiles have a trusted device list.");
    if (data.ownedDevice) return this.updateOwnedDevice(data, syncthingId);
    return this.enrollOwnedDevice(data, syncthingId, recoveryKey);
  }

  private async updateOwnedDevice(data: VaultData, syncthingId: string) {
    const ownedDevice = data.ownedDevice!;
    await openOwnedDeviceSigningKey(this.subtle, ownedDevice);
    if (!data.trustedRoster) throw new Error("Trusted device list is missing.");
    await this.verifyTrust(data.trustedRoster);
    if (ownedDevice.syncthingId === syncthingId) return data;
    const signingKey = await openOwnedDeviceSigningKey(this.subtle, ownedDevice);
    const current = await this.verifyTrust(data.trustedRoster);
    const devices = current.devices.map(device => device.id === ownedDevice.id
      ? { ...device, syncthingId,
          retiredSyncthingIds: [...new Set([...(device.retiredSyncthingIds ?? []), device.syncthingId])] }
      : device);
    const update = await signSpaceMembershipUpdate(this.subtle, signingKey, {
      sequence: data.trustedRoster.updates.length + 1,
      previous: data.trustedRoster.knownHead,
      signer: ownedDevice.id,
      devices,
      recoveryKey: data.trustedRoster.updates[0].recoveryKey,
    });
    return { ...data, ownedDevice: { ...ownedDevice, syncthingId },
      trustedRoster: { ...data.trustedRoster, knownHead: update.hash,
        updates: [...data.trustedRoster.updates, update] } };
  }

  private async enrollOwnedDevice(data: VaultData, syncthingId: string, recoveryKey?: string) {
    if (data.trustedRoster) throw new Error("This recovered profile requires trusted-device recovery enrollment.");
    if (!recoveryKey) {
      throw new Error("A separate offline recovery signing kit is required before enrolling the first device.");
    }
    await validateOwnedRecoveryPublicKey(this.subtle, recoveryKey);
    const identity = await createOwnedDeviceIdentity(this.subtle, this.options.randomBytes, syncthingId);
    const signingKey = await openOwnedDeviceSigningKey(this.subtle, identity);
    const device = { id: identity.id, syncthingId: identity.syncthingId,
      state: identity.state, signingKey: identity.signingKey };
    const genesis = await signSpaceMembershipUpdate(this.subtle, signingKey,
      { sequence: 1, previous: null, signer: identity.id, recoveryKey, devices: [device] });
    return { ...data, ownedDevice: identity,
      trustedRoster: { genesisKey: identity.signingKey, knownHead: genesis.hash, updates: [genesis] } };
  }

  createDeviceProtected() {
    return this.run(async () => {
      if (!this.options.rememberedSecret) throw new Error("Secure device storage is required.");
      if (this.key || this.initialized || decodeRecord(await this.options.storage.load())) {
        throw new Error("Credential vault already exists.");
      }
      if (!await this.options.rememberedSecret.isDeviceUnlocked()) throw new Error("Unlock the device first.");
      const random = await this.options.randomBytes(32);
      let derived: Awaited<ReturnType<typeof deriveUntrustedFolderCrypto>> | undefined;
      try {
        if (random.length !== 32) throw new Error("Invalid random secret length.");
        const secret = [...random].map(byte => byte.toString(16).padStart(2, "0")).join("");
        // Persist and verify recovery before publishing ciphertext encrypted with a generated secret.
        await this.options.rememberedSecret.save(secret);
        if (await this.options.rememberedSecret.load() !== secret) {
          throw new Error("Secure device storage verification failed.");
        }
        derived = await deriveUntrustedFolderCrypto(this.vaultId, secret, this.kdf);
        await this.save({ format: 1, defaultPassword: null, folders: {} }, derived.folderKey,
          { format: 1, manualLocked: false, remember: true });
        this.key = derived.folderKey;
        this.initialized = true;
        this.remembered = true;
        this.issue = undefined;
        return this.status();
      } catch (error) {
        derived?.folderKey.fill(0);
        throw error;
      } finally {
        random.fill(0);
      }
    });
  }

  initialize() {
    return this.run(async () => {
      if (this.key) throw new Error("Credential vault is already unlocked.");
      const record = decodeRecord(await this.options.storage.load());
      this.initialized = !!record;
      this.remembered = record?.remember ?? false;
      if (record && record.remember && !record.manualLocked && this.options.rememberedSecret) {
        try {
          if (await this.options.rememberedSecret.isDeviceUnlocked()) {
            const masterPassword = await this.options.rememberedSecret.load();
            if (masterPassword !== null) await this.unlockRecord(masterPassword, record);
          }
        } catch {
          this.issue = "Automatic unlock failed; enter the master password.";
        }
      }
      return this.status();
    });
  }

  create(masterPassword: string, remember = true, localSyncthingId?: string, recoveryKey?: string) {
    return this.run(() => this.createVault(masterPassword, remember, localSyncthingId, recoveryKey));
  }

  private async createVault(
    masterPassword: string,
    remember: boolean,
    localSyncthingId?: string,
    recoveryKey?: string,
  ) {
    if (this.key || this.initialized) {
      throw new Error("Credential vault already initialized; recover missing storage instead of replacing it.");
    }
    if (decodeRecord(await this.options.storage.load())) throw new Error("Credential vault already exists.");
    if (localSyncthingId && !recoveryKey) {
      throw new Error("A separate offline recovery signing kit is required before enrolling the first device.");
    }
    if (recoveryKey && !localSyncthingId) throw new Error("A local device ID is required for trusted-device enrollment.");
    if (this.options.bootstrapStorage) {
      return this.createPersonalVault(masterPassword, remember, localSyncthingId, recoveryKey);
    }
    return this.createEncryptedVault(masterPassword, remember);
  }

  private async createPersonalVault(
    masterPassword: string,
    remember: boolean,
    localSyncthingId?: string,
    recoveryKey?: string,
  ) {
    if (await this.options.bootstrapStorage!.load() !== null) {
      throw new Error("Personal-space recovery record already exists.");
    }
    const { record: bootstrap, space } = await createPersonalSpaceBootstrap(
      password(masterPassword), this.options.randomBytes, this.kdf,
    );
    let secret: Uint8Array | undefined;
    try {
      const initialData: VaultData = { format: 1, defaultPassword: null, folders: {} };
      const data = localSyncthingId
        ? await this.prepareOwnedDevice(space, initialData, localSyncthingId, recoveryKey)
        : initialData;
      await this.options.bootstrapStorage!.save(bootstrap);
      secret = personalVaultKey(space);
      await this.save(data, secret, { format: 2, manualLocked: false, remember });
      this.key = secret;
      this.personalSpace = space;
      this.initialized = true;
      if (remember) await this.rememberSecret(masterPassword);
      return this.status();
    } catch (error) {
      if (!this.initialized) {
        secret?.fill(0);
        space.rootKey.fill(0);
        // A failed save may have committed the vault before its flush failed.
        // Keep the wrapped root key so that record remains recoverable.
      }
      throw error;
    }
  }

  private async createEncryptedVault(masterPassword: string, remember: boolean) {
    const derived = await deriveUntrustedFolderCrypto(this.vaultId, password(masterPassword), this.kdf);
    try {
      await this.save({ format: 1, defaultPassword: null, folders: {} }, derived.folderKey,
        { format: 1, manualLocked: false, remember });
      this.key = derived.folderKey;
      this.initialized = true;
      if (remember) await this.rememberSecret(masterPassword);
      return this.status();
    } catch (error) {
      derived.folderKey.fill(0);
      throw error;
    }
  }

  exportRecoveryBackup(recoveryPassword: string) {
    return this.run(async (): Promise<PersonalSpaceRecoveryBackup> => {
      const { record, data } = await this.unlocked();
      if (record.format !== 2 || !this.personalSpace) {
        throw new Error("Only personal-space profiles can be backed up.");
      }
      const bootstrap = await wrapPersonalSpaceBootstrap(
        this.personalSpace, recoveryPassword, this.options.randomBytes, this.kdf,
      );
      const vault = await this.encrypt({ ...data, registrations: undefined, uiState: undefined,
        ownedDevice: undefined, localReleases: undefined }, this.key!,
        { format: 2, manualLocked: false, remember: false });
      return { format: 1, bootstrap, vault };
    });
  }

  exportPairingTransfer(localSyncthingId: string, joiningDevice: OwnedSpaceDevice) {
    return this.run(async (): Promise<PersonalSpacePairingTransfer> => {
      const { record, data: stored } = await this.unlocked();
      if (!this.personalSpace) throw new Error("Only personal-space profiles can pair devices.");
      let data = await this.prepareOwnedDevice(this.personalSpace, stored, localSyncthingId);
      const current = await this.verifyTrust(data.trustedRoster!);
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
        const signingKey = await openOwnedDeviceSigningKey(this.subtle, data.ownedDevice!);
        const update = await signSpaceMembershipUpdate(this.subtle, signingKey, {
          sequence: data.trustedRoster!.updates.length + 1,
          previous: data.trustedRoster!.knownHead,
          signer: data.ownedDevice!.id,
          devices: [...current.devices, joiningDevice],
          recoveryKey: data.trustedRoster!.updates[0].recoveryKey,
        });
        data = { ...data, trustedRoster: { ...data.trustedRoster!, knownHead: update.hash,
          updates: [...data.trustedRoster!.updates, update] } };
      }
      await this.save(data, this.key!, record);
      return { spaceId: this.personalSpace.id, settingsFolderId: this.personalSpace.settingsFolderId,
        rootKey: [...this.personalSpace.rootKey].map(byte => byte.toString(16).padStart(2, "0")).join(""),
        trust: data.trustedRoster! };
    });
  }

  spaceDeviceMembership() {
    return this.run(async () => {
      const { data } = await this.unlocked();
      if (!data.trustedRoster) return null;
      const verified = await this.verifyTrust(data.trustedRoster);
      return { trust: data.trustedRoster, localDeviceId: data.ownedDevice?.id ?? null,
        devices: verified.devices };
    });
  }

  signPersonalSpaceChange(change: PersonalSpaceChange) {
    return this.run(async () => {
      const { data } = await this.unlocked();
      if (!data.ownedDevice || !data.trustedRoster || change.deviceId !== data.ownedDevice.id) {
        throw new Error("Personal-space setting author is not this enrolled device.");
      }
      const membership = await this.verifyTrust(data.trustedRoster);
      if (!membership.devices.some(device => device.id === data.ownedDevice!.id && device.state === "active")) {
        throw new Error("Revoked devices cannot sign personal-space settings.");
      }
      return signPersonalSpaceChange(this.subtle, await openOwnedDeviceSigningKey(this.subtle, data.ownedDevice), change);
    });
  }

  signReplicaCompletion(value: Omit<ReplicaCompletion, "format" | "signature" | "signerId">) {
    return this.run(async () => {
      const { data } = await this.unlocked();
      if (!data.ownedDevice || !data.trustedRoster) throw new Error("Trusted local signing identity is unavailable.");
      const membership = await this.verifyTrust(data.trustedRoster);
      if (!membership.devices.some(device => device.id === data.ownedDevice!.id && device.state === "active")) {
        throw new Error("Revoked devices cannot sign copy observations.");
      }
      return signReplicaCompletion(this.subtle, await openOwnedDeviceSigningKey(this.subtle, data.ownedDevice),
        { ...value, signerId: data.ownedDevice.id });
    });
  }

  signRetentionReleaseProposal(value: Omit<RetentionReleaseProposal,
    "format" | "action" | "id" | "signature" | "proposerId">) {
    return this.run(async () => {
      const { data } = await this.unlocked();
      if (!data.ownedDevice || !data.trustedRoster) throw new Error("Trusted local signing identity is unavailable.");
      const membership = await this.verifyTrust(data.trustedRoster);
      if (!membership.devices.some(device => device.id === data.ownedDevice!.id && device.state === "active")) {
        throw new Error("Revoked devices cannot sign local releases.");
      }
      return signRetentionReleaseProposal(this.subtle, await openOwnedDeviceSigningKey(this.subtle, data.ownedDevice),
        { ...value, proposerId: data.ownedDevice.id });
    });
  }

  signDangerousLocalRelease(value: Omit<DangerousLocalRelease,
    "format" | "scope" | "guaranteeBroken" | "signature" | "localHolderId"> & { confirmedText: string }) {
    return this.run(async () => {
      const { data } = await this.unlocked();
      if (!data.ownedDevice || !data.trustedRoster) throw new Error("Trusted local signing identity is unavailable.");
      const membership = await this.verifyTrust(data.trustedRoster);
      if (!membership.devices.some(device => device.id === data.ownedDevice!.id && device.state === "active")) {
        throw new Error("Revoked devices cannot sign local releases.");
      }
      return createDangerousLocalRelease(this.subtle, await openOwnedDeviceSigningKey(this.subtle, data.ownedDevice),
        { ...value, localHolderId: data.ownedDevice.id });
    });
  }

  acceptSpaceDeviceMembership(trust: SpaceDeviceMembershipTrust) {
    return this.run(async () => {
      const { record, data } = await this.unlocked();
      if (!data.trustedRoster || trust.genesisKey !== data.trustedRoster.genesisKey) {
        throw new Error("Trusted device list genesis does not match.");
      }
      await this.verifyTrust(trust, data.trustedRoster.knownHead);
      if (trust.updates.length < data.trustedRoster.updates.length) {
        throw new Error("Trusted device list rollback detected.");
      }
      await this.save({ ...data, trustedRoster: trust }, this.key!, record);
    });
  }

  revokeOwnedDevice(deviceId: string) {
    return this.run(async () => {
      const { record, data } = await this.unlocked();
      if (!data.ownedDevice || !data.trustedRoster) throw new Error("Trusted device administration is unavailable.");
      if (deviceId === data.ownedDevice.id) throw new Error("The current device cannot revoke itself.");
      const verified = await this.verifyTrust(data.trustedRoster);
      const target = verified.devices.find(device => device.id === deviceId);
      if (!target) throw new Error("Trusted device was not found.");
      if (target.state === "revoked") return data.trustedRoster;
      const signingKey = await openOwnedDeviceSigningKey(this.subtle, data.ownedDevice);
      const membershipUpdate = await signSpaceMembershipUpdate(this.subtle, signingKey, {
        sequence: data.trustedRoster.updates.length + 1,
        previous: data.trustedRoster.knownHead,
        signer: data.ownedDevice.id,
        devices: verified.devices.map(device => device.id === deviceId
          ? { ...device, state: "revoked" as const } : device),
        recoveryKey: data.trustedRoster.updates[0].recoveryKey,
      });
      const trust = { ...data.trustedRoster, knownHead: membershipUpdate.hash,
        updates: [...data.trustedRoster.updates, membershipUpdate] };
      await this.save({ ...data, trustedRoster: trust }, this.key!, record);
      return trust;
    });
  }

  personalSpaceFolder() {
    return this.run(async () => {
      await this.unlocked();
      return this.personalSpace ? { id: this.personalSpace.settingsFolderId,
        password: settingsFolderPassword(this.personalSpace) } : null;
    });
  }

  initializeOwnedDevice(syncthingId: string, recoveryKey?: string) {
    return this.run(async () => {
      const { record, data } = await this.unlocked();
      const prepared = await this.prepareOwnedDevice(this.personalSpace, data, syncthingId, recoveryKey);
      await this.save(prepared, this.key!, record);
      return prepared.trustedRoster!;
    });
  }

  recoverOwnedDevice(syncthingId: string, kit: OwnedRecoveryKit, kitPassword: string) {
    return this.run(async () => {
      const { record, data } = await this.unlocked();
      if (!this.personalSpace || !data.trustedRoster) {
        throw new Error("Trusted-device recovery needs a restored personal-space backup.");
      }
      if (data.ownedDevice) throw new Error("This device is already enrolled in the personal space.");
      const current = await this.verifyTrust(data.trustedRoster);
      if (!kit || kit.publicKey !== data.trustedRoster.updates[0].recoveryKey) {
        throw new Error("Recovery kit does not match this personal space.");
      }
      const recoveryKey = await openOwnedRecoveryKit(this.subtle, kit, kitPassword, this.kdf);
      const identity = await createOwnedDeviceIdentity(this.subtle, this.options.randomBytes, syncthingId);
      const devices: OwnedSpaceDevice[] = [...current.devices.map(device => ({ ...device,
        state: "revoked" as const })), { id: identity.id, syncthingId: identity.syncthingId,
        signingKey: identity.signingKey, state: "active" }];
      const next = await signSpaceMembershipUpdate(this.subtle, recoveryKey, {
        sequence: data.trustedRoster.updates.length + 1,
        previous: data.trustedRoster.knownHead,
        signer: "recovery",
        recoveryKey: kit.publicKey,
        devices,
      });
      const trust = { ...data.trustedRoster, knownHead: next.hash,
        updates: [...data.trustedRoster.updates, next] };
      await this.verifyTrust(trust, data.trustedRoster.knownHead);
      await this.save({ ...data, ownedDevice: identity, trustedRoster: trust }, this.key!, record);
      return trust;
    });
  }

  importPairingTransfer(transfer: PersonalSpacePairingTransfer, identity: OwnedDeviceIdentity,
    localMasterPassword: string, remember = true) {
    return this.run(() => this.importPairing(transfer, identity, localMasterPassword, remember));
  }

  private async importPairing(
    transfer: PersonalSpacePairingTransfer,
    identity: OwnedDeviceIdentity,
    localMasterPassword: string,
    remember: boolean,
  ) {
    if (!this.options.bootstrapStorage) throw new Error("Personal-space recovery storage is unavailable.");
    if (this.key || this.initialized || decodeRecord(await this.options.storage.load()) ||
      await this.options.bootstrapStorage.load() !== null) {
      throw new Error("Local profile already exists; pairing cannot replace it.");
    }
    const space = pairingSpace(transfer);
    await this.verifyPairingEnrollment(identity, transfer.trust);
    await this.installPairing(space, identity, transfer, localMasterPassword, remember);
    if (remember) await this.rememberSecret(localMasterPassword);
    return this.status();
  }

  private async verifyPairingEnrollment(identity: OwnedDeviceIdentity, trust: SpaceDeviceMembershipTrust) {
    await openOwnedDeviceSigningKey(this.subtle, identity);
    const membership = await this.verifyTrust(trust);
    const enrolled = membership.devices.find(device => device.id === identity.id);
    if (!enrolled || enrolled.syncthingId !== identity.syncthingId ||
      enrolled.signingKey !== identity.signingKey || enrolled.state !== "active") {
      throw new Error("Pairing transfer did not enroll this device.");
    }
  }

  private async installPairing(
    space: PersonalSpace,
    identity: OwnedDeviceIdentity,
    transfer: PersonalSpacePairingTransfer,
    localMasterPassword: string,
    remember: boolean,
  ) {
    const bootstrap = await wrapPersonalSpaceBootstrap(
      space, password(localMasterPassword), this.options.randomBytes, this.kdf,
    );
    await this.options.bootstrapStorage!.save(bootstrap);
    const secret = personalVaultKey(space);
    try {
      await this.save({ format: 1, defaultPassword: null, folders: {}, ownedDevice: identity,
        trustedRoster: transfer.trust }, secret,
        { format: 2, manualLocked: false, remember });
      this.key = secret;
      this.personalSpace = space;
      this.initialized = true;
      this.remembered = remember;
      this.issue = undefined;
      return secret;
    } catch (error) {
      if (!this.initialized) {
        secret.fill(0);
        space.rootKey.fill(0);
      }
      throw error;
    }
  }

  restoreRecoveryBackup(backup: PersonalSpaceRecoveryBackup, recoveryPassword: string,
    localMasterPassword: string) {
    return this.run(async () => {
      if (!this.options.bootstrapStorage) throw new Error("Personal-space recovery storage is unavailable.");
      if (this.key || this.initialized || decodeRecord(await this.options.storage.load()) ||
        await this.options.bootstrapStorage.load() !== null) {
        throw new Error("Local profile already exists; recovery cannot replace it.");
      }
      if (!backup || backup.format !== 1) throw new Error("Invalid personal-space recovery backup.");
      const record = decodeRecord(backup.vault);
      if (!record || record.format !== 2) throw new Error("Invalid personal-space recovery backup.");
      const space = await openPersonalSpaceBootstrap(backup.bootstrap, password(recoveryPassword), this.kdf);
      const secret = personalVaultKey(space);
      try {
        await this.read(record, secret);
        const localBootstrap = await wrapPersonalSpaceBootstrap(
          space, password(localMasterPassword), this.options.randomBytes, this.kdf,
        );
        await this.options.bootstrapStorage.save(localBootstrap);
        await this.options.storage.save({ ...record, manualLocked: false, remember: false });
        this.key = secret;
        this.personalSpace = space;
        this.initialized = true;
        this.remembered = false;
        this.issue = undefined;
        return this.status();
      } catch (error) {
        secret.fill(0);
        space.rootKey.fill(0);
        throw error;
      }
    });
  }

  unlock(masterPassword: string) {
    return this.run(async () => {
      const record = decodeRecord(await this.options.storage.load());
      if (!record) throw new Error("Credential vault is missing.");
      await this.unlockRecord(masterPassword, record);
      if (record.remember) await this.rememberSecret(masterPassword);
      return this.status();
    });
  }

  unlockRemembered() {
    return this.run(async () => {
      const record = decodeRecord(await this.options.storage.load());
      if (record?.manualLocked) throw new Error("Enter the master password after explicit lock.");
      if (!record?.remember || !await this.options.rememberedSecret?.isDeviceUnlocked()) {
        throw new Error("A remembered unlock secret is unavailable.");
      }
      const masterPassword = await this.options.rememberedSecret?.load();
      if (!record || !masterPassword) throw new Error("A remembered unlock secret is unavailable.");
      await this.unlockRecord(masterPassword, record);
      return this.status();
    });
  }

  changeMasterPassword(newPassword: string) {
    return this.run(async () => {
      const { record, data } = await this.unlocked();
      const nextPassword = password(newPassword);
      if (record.format === 2) return this.changePersonalPassword(record, nextPassword);
      return this.changeLocalPassword(record, data, nextPassword);
    });
  }

  private async changePersonalPassword(record: CredentialVaultRecord, nextPassword: string) {
    if (!this.options.bootstrapStorage || !this.personalSpace) {
      throw new Error("Personal-space recovery storage is unavailable.");
    }
    const current = await this.options.bootstrapStorage.load() as PersonalSpaceBootstrap;
    const oldPassword = await this.options.rememberedSecret?.load();
    const next = await wrapPersonalSpaceBootstrap(
      this.personalSpace, nextPassword, this.options.randomBytes, this.kdf,
    );
    try {
      if (record.remember && this.options.rememberedSecret) await this.options.rememberedSecret.save(nextPassword);
      await this.options.bootstrapStorage.save(next);
      this.issue = undefined;
      return this.status();
    } catch (error) {
      if (record.remember && this.options.rememberedSecret) {
        if (oldPassword) await this.options.rememberedSecret.save(oldPassword).catch(() => {});
        else await this.options.rememberedSecret.remove().catch(() => {});
      }
      await this.options.bootstrapStorage.save(current).catch(() => {
        this.issue = "Master password change needs recovery; try the previous password.";
      });
      throw error;
    }
  }

  private async changeLocalPassword(record: CredentialVaultRecord, data: VaultData, nextPassword: string) {
    const oldKey = this.key!;
    const oldRemembered = await this.options.rememberedSecret?.load();
    const derived = await deriveUntrustedFolderCrypto(this.vaultId, nextPassword, this.kdf);
    try {
      const nextRecord = await this.encrypt(data, derived.folderKey,
        { format: 1, manualLocked: false, remember: record.remember });
      if (record.remember && this.options.rememberedSecret) await this.options.rememberedSecret.save(nextPassword);
      await this.options.storage.save(nextRecord);
      oldKey.fill(0);
      this.key = derived.folderKey;
      this.initialized = true;
      this.remembered = record.remember;
      this.issue = undefined;
      return this.status();
    } catch (error) {
      derived.folderKey.fill(0);
      try {
        if (record.remember && this.options.rememberedSecret) {
          if (oldRemembered === null || oldRemembered === undefined) await this.options.rememberedSecret.remove();
          else await this.options.rememberedSecret.save(oldRemembered);
        }
        await this.options.storage.save(record);
      } catch {
        this.issue = "Master password rotation needs recovery; the previous unlock may be required.";
      }
      throw error;
    }
  }

  lock() {
    return this.run(async () => {
      try {
        const record = decodeRecord(await this.options.storage.load());
        if (record) await this.options.storage.save({ ...record, manualLocked: true });
      } finally {
        await this.revoke();
      }
      return this.status();
    });
  }

  folderPassword(folderId: string) {
    return this.run(async () => {
      const { data } = await this.unlocked();
      return Object.hasOwn(data.folders, folderId) ? data.folders[folderId] : null;
    });
  }

  connectionPasswords() {
    return this.run(async () => {
      const { data } = await this.unlocked();
      return { ...data.connectionPasswords };
    });
  }

  saveConnectionPasswords(values: Record<string, string>) {
    return this.update(data => {
      validateConnectionPasswords(data, values);
      return { ...data, connectionPasswords: { ...values } };
    });
  }

  mergeConnectionPasswords(values: Record<string, string>) {
    return this.update(data => {
      validateConnectionPasswords(data, values);
      return { ...data, connectionPasswords: { ...values, ...data.connectionPasswords } };
    });
  }

  profileSettings() {
    return this.run(async () => {
      const { data } = await this.unlocked();
      return normalizeProfileSettings(data.settings);
    });
  }

  registrations() {
    return this.run(async () => (await this.unlocked()).data.registrations ?? null);
  }

  saveRegistrations(folders: FolderRegistration[]) {
    return this.update(data => ({ ...data, registrations: validateRegistrations(folders) }));
  }

  commitLocalRelease(record: LocalReleaseRecord, folders: FolderRegistration[]) {
    return this.update(data => {
      const folderId = record.kind === "safe" ? record.proposal.folderId : record.exception.folderId;
      const before = data.registrations ?? [];
      const after = validateRegistrations(folders);
      if (!before.some(folder => folder.id === folderId && folder.downloads) ||
        JSON.stringify(after) !== JSON.stringify(before.map(folder => folder.id === folderId
          ? { id: folder.id, label: folder.label, storageId: folder.storageId, browseOnly: true } : folder)) ||
        data.localReleases?.some(entry => entry.pending &&
          (entry.record.kind === "safe" ? entry.record.proposal.folderId : entry.record.exception.folderId) === folderId) ||
        (data.localReleases?.length ?? 0) >= 1000) {
        throw new Error("Local release registration is stale or already pending.");
      }
      return { ...data, registrations: after,
        localReleases: [...data.localReleases ?? [], { record, pending: true }] };
    });
  }

  pendingLocalReleases() {
    return this.run(async () => (await this.unlocked()).data.localReleases
      ?.filter(entry => entry.pending).map(entry => entry.record) ?? []);
  }

  localReleaseHistory() {
    return this.run(async () => (await this.unlocked()).data.localReleases
      ?.map(entry => entry.record) ?? []);
  }

  completeLocalRelease(folderId: string) {
    return this.update(data => ({ ...data,
      localReleases: data.localReleases?.map(entry => {
        const id = entry.record.kind === "safe" ? entry.record.proposal.folderId : entry.record.exception.folderId;
        return id === folderId ? { ...entry, pending: false } : entry;
      }) }));
  }

  uiState() {
    return this.run(async () => {
      const { data } = await this.unlocked();
      return data.uiState ?? null;
    });
  }

  saveUiState(value: unknown) {
    return this.update(data => ({ ...data, uiState: value === null ? undefined : value }));
  }

  saveProfileSettings(settings: SyncpeerProfileSettings) {
    return this.update(data => ({ ...data, settings: normalizeProfileSettings(settings) }));
  }

  addFolder(folderId: string, value?: string) {
    return this.update(async data => {
      if (Object.hasOwn(data.folders, folderId)) {
        throw new Error("Folder credentials already exist; password changes require migration.");
      }
      const selected = value === undefined ? null : password(value);
      const generated = selected === null ? await this.options.randomBytes(32) : undefined;
      try {
        if (generated && generated.length !== 32) throw new Error("Invalid random password length.");
        const secret = selected ?? [...generated!].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return { ...data, folders: { ...data.folders, [folderId]: secret } };
      } finally {
        generated?.fill(0);
      }
    });
  }

  forgetRememberedSecret() {
    return this.run(async () => {
      const record = decodeRecord(await this.options.storage.load());
      if (record) await this.options.storage.save({ ...record, remember: false });
      this.remembered = false;
      await this.options.rememberedSecret?.remove();
    });
  }

  close() {
    this.closed = true;
    this.closeTask ??= this.queue.then(() => this.revoke()).catch(error => {
      this.closeTask = undefined;
      throw error;
    });
    return this.closeTask;
  }
}

export function createCredentialVault(options: CredentialVaultOptions) {
  return new CredentialVault(options);
}
