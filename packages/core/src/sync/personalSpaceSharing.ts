export interface OwnedSpaceDevice {
  /** Stable Syncpeer slot; a certificate replacement changes only syncthingId. */
  id: string;
  syncthingId: string;
  state: "active" | "revoked";
  retiredSyncthingIds?: string[];
  /** SPKI-encoded key used to authorize subsequent roster changes. */
  signingKey: string;
}

export interface OwnedRosterUpdate {
  format: 1;
  sequence: number;
  previous: string | null;
  signer: string;
  recoveryKey?: string;
  devices: OwnedSpaceDevice[];
  signature: string;
  hash: string;
}

export interface OwnedDeviceIdentity extends OwnedSpaceDevice {
  privateKey: string;
}

export interface OwnedRosterTrust {
  genesisKey: string;
  knownHead: string;
  updates: OwnedRosterUpdate[];
}

/** Store this separately from the space backup and every device-local vault. */
export interface OwnedRecoveryKit {
  format: 1;
  kdf: "scrypt-N32768-r8-p1";
  publicKey: string;
  salt: number[];
  nonce: number[];
  ciphertext: number[];
}

export type FolderShareTarget = { kind: "personal-space" } | { kind: "device"; syncthingId: string };

const validateRoster = (devices: readonly OwnedSpaceDevice[]) => {
  const slots = new Set<string>(), identities = new Set<string>(), signingKeys = new Set<string>();
  for (const device of devices) {
    if (!device.id || !device.syncthingId || !["active", "revoked"].includes(device.state) ||
      slots.has(device.id) || !Array.isArray(device.retiredSyncthingIds ?? []) ||
      typeof device.signingKey !== "string" || !device.signingKey || device.signingKey.length > 4096 ||
      signingKeys.has(device.signingKey)) {
      throw new Error("Invalid personal-space device roster.");
    }
    slots.add(device.id);
    signingKeys.add(device.signingKey);
    for (const identity of [device.syncthingId, ...(device.retiredSyncthingIds ?? [])]) {
      const comparable = normalizeDeviceId(identity);
      if (!comparable || identities.has(comparable)) throw new Error("Invalid personal-space device roster.");
      identities.add(comparable);
    }
  }
};

const validateRosterTransition = (previous: readonly OwnedSpaceDevice[], next: readonly OwnedSpaceDevice[]) => {
  const nextById = new Map(next.map(device => [device.id, device]));
  for (const device of previous) {
    const updated = nextById.get(device.id);
    if (!updated) throw new Error("Owned roster device disappeared.");
    if (updated.signingKey !== device.signingKey) throw new Error("Owned roster device key changed.");
    if (device.state === "revoked" && updated.state !== "revoked") {
      throw new Error("Owned roster revoked device cannot be reactivated.");
    }
    const retired = new Set(updated.retiredSyncthingIds ?? []);
    for (const identity of device.retiredSyncthingIds ?? []) {
      if (!retired.has(identity)) throw new Error("Owned roster retired identity disappeared.");
    }
    if (updated.syncthingId !== device.syncthingId && !retired.has(device.syncthingId)) {
      throw new Error("Owned roster certificate replacement must retain the retired identity.");
    }
  }
};

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const kitBytes = (value: unknown, length: number) => {
  if (!Array.isArray(value) || value.length !== length || value.some(byte =>
    !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("Invalid owned recovery kit.");
  return Uint8Array.from(value);
};
const recoveryPassword = (value: string) => {
  if (typeof value !== "string" || value.length < 16 || value.length > 4096) {
    throw new Error("Owned recovery kit password must have at least 16 characters.");
  }
  return new TextEncoder().encode(value);
};
const recoveryAad = (publicKey: string) =>
  new TextEncoder().encode(`syncpeer.owned-recovery-kit.v1\n${publicKey}`);
export async function validateOwnedRecoveryPublicKey(subtle: SubtleCrypto, publicKey: string): Promise<void> {
  try {
    if (typeof publicKey !== "string" || !publicKey || publicKey.length > 4096) throw new Error();
    await subtle.importKey("spki", decode(publicKey),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch { throw new Error("Invalid offline recovery signing key."); }
}
const random = async (source: (size: number) => Uint8Array | Promise<Uint8Array>, size: number) => {
  const value = await source(size);
  if (!(value instanceof Uint8Array) || value.length !== size) throw new Error("Invalid device identity random source.");
  return value;
};
const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
const unsignedUpdate = (value: Pick<OwnedRosterUpdate, "sequence" | "previous" | "signer" | "devices" | "recoveryKey">) =>
  ({ format: 1 as const, sequence: value.sequence, previous: value.previous, signer: value.signer,
    ...(value.recoveryKey ? { recoveryKey: value.recoveryKey } : {}), devices: value.devices });
const updateBytes = (value: ReturnType<typeof unsignedUpdate>) =>
  new TextEncoder().encode(`syncpeer.owned-roster.v1\n${JSON.stringify(value)}`);

export async function createOwnedDeviceIdentity(subtle: SubtleCrypto,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>, syncthingId: string): Promise<OwnedDeviceIdentity> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const identity = { id: hex(await random(randomBytes, 16)), syncthingId, state: "active" as const,
    signingKey: encode(new Uint8Array(await subtle.exportKey("spki", pair.publicKey))),
    privateKey: encode(new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey))) };
  validateRoster([identity]);
  return identity;
}

export async function openOwnedDeviceSigningKey(subtle: SubtleCrypto,
  identity: OwnedDeviceIdentity): Promise<CryptoKey> {
  validateRoster([identity]);
  if (typeof identity.privateKey !== "string" || !identity.privateKey || identity.privateKey.length > 4096) {
    throw new Error("Invalid owned device identity.");
  }
  try {
    const [privateKey, publicKey] = await Promise.all([
      subtle.importKey("pkcs8", decode(identity.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
      subtle.importKey("spki", decode(identity.signingKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    ]);
    const challenge = new TextEncoder().encode("syncpeer.device-identity.v1");
    const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
    if (!await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge)) {
      throw new Error("Owned device identity keys do not match.");
    }
    return privateKey;
  } catch { throw new Error("Invalid owned device identity."); }
}

export async function createOwnedRecoveryKit(subtle: SubtleCrypto,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>, kitPassword: string,
  kdf: PasswordKdf = scryptPasswordKdf): Promise<OwnedRecoveryKit> {
  const passwordBytes = recoveryPassword(kitPassword);
  let key: Uint8Array | undefined, privateBytes: Uint8Array | undefined;
  try {
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = encode(new Uint8Array(await subtle.exportKey("spki", pair.publicKey)));
    privateBytes = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
    const salt = await random(randomBytes, 16), nonce = await random(randomBytes, 24);
    key = await kdf(passwordBytes, salt);
    return { format: 1, kdf: "scrypt-N32768-r8-p1", publicKey,
      salt: Array.from(salt), nonce: Array.from(nonce),
      ciphertext: Array.from(xchacha20poly1305(key, nonce, recoveryAad(publicKey)).encrypt(privateBytes)) };
  } finally { key?.fill(0); passwordBytes.fill(0); privateBytes?.fill(0); }
}

export async function openOwnedRecoveryKit(subtle: SubtleCrypto, kit: OwnedRecoveryKit,
  kitPassword: string, kdf: PasswordKdf = scryptPasswordKdf): Promise<CryptoKey> {
  if (!kit || kit.format !== 1 || kit.kdf !== "scrypt-N32768-r8-p1" ||
    typeof kit.publicKey !== "string" || kit.publicKey.length > 4096 ||
    !Array.isArray(kit.ciphertext) || kit.ciphertext.length < 64 || kit.ciphertext.length > 4096 ||
    kit.ciphertext.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("Invalid owned recovery kit.");
  }
  const salt = kitBytes(kit.salt, 16), nonce = kitBytes(kit.nonce, 24);
  const passwordBytes = recoveryPassword(kitPassword);
  let key: Uint8Array | undefined, plaintext: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    key = await kdf(passwordBytes, salt);
    plaintext = xchacha20poly1305(key, nonce, recoveryAad(kit.publicKey))
      .decrypt(Uint8Array.from(kit.ciphertext));
    const [privateKey, publicKey] = await Promise.all([
      subtle.importKey("pkcs8", new Uint8Array(plaintext),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
      subtle.importKey("spki", decode(kit.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    ]);
    const challenge = new TextEncoder().encode("syncpeer.owned-recovery-kit.v1");
    const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
    if (!await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge)) {
      throw new Error("Owned recovery kit key mismatch.");
    }
    return privateKey;
  } catch { throw new Error("Invalid owned recovery kit or password."); }
  finally { key?.fill(0); passwordBytes.fill(0); plaintext.fill(0); }
}

/** A full roster snapshot signed by the device authorized in the preceding snapshot. */
export async function signOwnedRosterUpdate(subtle: SubtleCrypto, key: CryptoKey,
  value: Pick<OwnedRosterUpdate, "sequence" | "previous" | "signer" | "devices" | "recoveryKey">): Promise<OwnedRosterUpdate> {
  validateRoster(value.devices);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !value.signer ||
    (value.sequence === 1) !== (value.previous === null)) throw new Error("Invalid owned roster sequence.");
  const unsigned = unsignedUpdate(value);
  const bytes = updateBytes(unsigned);
  const signature = encode(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes)));
  const hash = encode(new Uint8Array(await subtle.digest("SHA-256", bytes)));
  return { ...unsigned, signature, hash };
}

/** Pin the genesis key locally; old snapshots cannot replace a previously accepted head. */
export async function verifyOwnedRoster(subtle: SubtleCrypto, updates: readonly OwnedRosterUpdate[],
  genesisKey: string, knownHead?: string): Promise<{ devices: OwnedSpaceDevice[]; hash: string }> {
  if (!updates.length || updates.length > 10000) throw new Error("Invalid owned roster history.");
  let recoveryKey: string | undefined;
  let previous: string | null = null;
  let devices: OwnedSpaceDevice[] = [];
  let knownHeadSeen = false;
  for (const [index, update] of updates.entries()) {
    if (update.format !== 1 || update.sequence !== index + 1 || update.previous !== previous ||
      typeof update.signer !== "string" || !update.signer) throw new Error("Invalid owned roster ancestry.");
    validateRoster(update.devices);
    if (index > 0) validateRosterTransition(devices, update.devices);
    if (index === 0) recoveryKey = update.recoveryKey;
    else if (update.recoveryKey !== recoveryKey) throw new Error("Owned roster recovery authority changed.");
    const signer = index === 0 ? update.devices.find(device => device.id === update.signer) :
      devices.find(device => device.id === update.signer && device.state === "active");
    let trusted: string;
    if (update.signer === "recovery" && index > 0 && recoveryKey) trusted = recoveryKey;
    else if (!signer || (index === 0 && signer.signingKey !== genesisKey)) {
      throw new Error("Owned roster signer is not authorized.");
    } else trusted = signer.signingKey;
    const bytes = updateBytes(unsignedUpdate(update));
    const hash = encode(new Uint8Array(await subtle.digest("SHA-256", bytes)));
    if (hash !== update.hash) throw new Error("Owned roster hash mismatch.");
    let valid = false;
    try {
      const key = await subtle.importKey("spki", decode(trusted), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      valid = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(update.signature), bytes);
    } catch { /* Invalid key or signature is untrusted input. */ }
    if (!valid) throw new Error("Owned roster signature is invalid.");
    knownHeadSeen ||= hash === knownHead;
    previous = hash;
    devices = update.devices;
  }
  if (knownHead && !knownHeadSeen) throw new Error("Owned roster rollback or fork detected.");
  return { devices, hash: previous! };
}

export function settingsFolderDevices(devices: readonly OwnedSpaceDevice[]): string[] {
  validateRoster(devices);
  return devices.filter(device => device.state === "active").map(device => device.syncthingId).sort();
}

/** Active owned devices plus one explicitly selected non-revoked external peer. */
export function resolveApprovedPeerDeviceIds(selectedDeviceId: string,
  devices: readonly OwnedSpaceDevice[]): string[] {
  if (!devices.length) return selectedDeviceId ? [selectedDeviceId] : [];
  const approved = new Map<string, string>();
  for (const id of [...settingsFolderDevices(devices),
    ...resolveFolderShareDevices([{ kind: "device", syncthingId: selectedDeviceId }], devices)]) {
    const comparable = normalizeDeviceId(id);
    if (!approved.has(comparable)) approved.set(comparable, id);
  }
  return [...approved.values()].sort();
}

/** Resolve policy at the Syncpeer boundary; BEP still sees ordinary device IDs. */
export function resolveFolderShareDevices(targets: readonly FolderShareTarget[],
  devices: readonly OwnedSpaceDevice[]): string[] {
  validateRoster(devices);
  const revoked = new Set(devices.flatMap(device => [
    ...(device.state === "revoked" ? [device.syncthingId] : []), ...(device.retiredSyncthingIds ?? [])])
    .map(normalizeDeviceId));
  const selected = new Map<string, string>();
  for (const target of targets) {
    if (target.kind === "personal-space") {
      for (const device of devices) if (device.state === "active") {
        selected.set(normalizeDeviceId(device.syncthingId), device.syncthingId);
      }
    } else if (target.kind === "device" && target.syncthingId) {
      const comparable = normalizeDeviceId(target.syncthingId);
      if (comparable && !revoked.has(comparable) && !selected.has(comparable)) {
        selected.set(comparable, target.syncthingId);
      }
    } else throw new Error("Invalid folder sharing target.");
  }
  return [...selected.values()].sort();
}
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scryptPasswordKdf, type PasswordKdf } from "../core/model/passwordKdf.js";
import { normalizeDeviceId } from "../ui/helpers.js";
