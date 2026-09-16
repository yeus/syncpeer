import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";

export interface PersonalSpaceBootstrap {
  format: 1;
  kdf: "scrypt-N32768-r8-p1";
  salt: number[];
  nonce: number[];
  ciphertext: number[];
}

export interface PersonalSpace {
  id: string;
  settingsFolderId: string;
  rootKey: Uint8Array;
}

const bytes = (value: unknown, size: number): Uint8Array => {
  if (!Array.isArray(value) || value.length !== size || value.some(item =>
    !Number.isInteger(item) || item < 0 || item > 255)) throw new Error("Invalid personal-space bootstrap.");
  return Uint8Array.from(value);
};

const random = async (source: (size: number) => Uint8Array | Promise<Uint8Array>, size: number) => {
  const value = await source(size);
  if (!(value instanceof Uint8Array) || value.length !== size) throw new Error("Invalid random source.");
  return value;
};

const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
const idBytes = (value: string) => Uint8Array.from(value.match(/../g)!.map(part => Number.parseInt(part, 16)));

const seal = async (space: PersonalSpace, masterPassword: string,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>): Promise<PersonalSpaceBootstrap> => {
  if (typeof masterPassword !== "string" || masterPassword.length < 16) {
    throw new Error("Personal-space master password must have at least 16 characters.");
  }
  if (masterPassword.length > 4096 || !validId(space.id) || !validId(space.settingsFolderId) ||
    space.rootKey.length !== 32) throw new Error("Invalid personal-space recovery input.");
  const salt = await random(randomBytes, 16);
  const nonce = await random(randomBytes, 24);
  const passwordBytes = new TextEncoder().encode(masterPassword);
  let key: Uint8Array;
  try { key = scrypt(passwordBytes, salt, { N: 32768, r: 8, p: 1, dkLen: 32 }); }
  finally { passwordBytes.fill(0); }
  const plaintext = new Uint8Array(64);
  plaintext.set(idBytes(space.id), 0);
  plaintext.set(idBytes(space.settingsFolderId), 16);
  plaintext.set(space.rootKey, 32);
  try {
    const ciphertext = xchacha20poly1305(key, nonce, new TextEncoder().encode("syncpeer.personal-space.v1"))
      .encrypt(plaintext);
    return { format: 1, kdf: "scrypt-N32768-r8-p1", salt: Array.from(salt), nonce: Array.from(nonce),
      ciphertext: Array.from(ciphertext) };
  } finally { key.fill(0); plaintext.fill(0); }
};

export async function createPersonalSpaceBootstrap(masterPassword: string,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>) {
  const space = { id: hex(await random(randomBytes, 16)), settingsFolderId: hex(await random(randomBytes, 16)),
    rootKey: await random(randomBytes, 32) };
  try { return { record: await seal(space, masterPassword, randomBytes), space }; }
  catch (error) { space.rootKey.fill(0); throw error; }
}

export function openPersonalSpaceBootstrap(record: PersonalSpaceBootstrap, masterPassword: string): PersonalSpace {
  if (!record || record.format !== 1 || record.kdf !== "scrypt-N32768-r8-p1" ||
    typeof masterPassword !== "string" || !masterPassword || masterPassword.length > 4096 ||
    !Array.isArray(record.ciphertext) || record.ciphertext.length < 16 || record.ciphertext.length > 4096) {
    throw new Error("Invalid personal-space bootstrap.");
  }
  const salt = bytes(record.salt, 16), nonce = bytes(record.nonce, 24);
  if (record.ciphertext.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("Invalid personal-space bootstrap.");
  }
  const ciphertext = Uint8Array.from(record.ciphertext);
  const passwordBytes = new TextEncoder().encode(masterPassword);
  let key: Uint8Array;
  try { key = scrypt(passwordBytes, salt, { N: 32768, r: 8, p: 1, dkLen: 32 }); }
  finally { passwordBytes.fill(0); }
  let plaintext: Uint8Array = new Uint8Array();
  try {
    plaintext = xchacha20poly1305(key, nonce, new TextEncoder().encode("syncpeer.personal-space.v1"))
      .decrypt(ciphertext);
    if (plaintext.length !== 64) throw new Error("Invalid personal-space payload.");
    return { id: hex(plaintext.subarray(0, 16)), settingsFolderId: hex(plaintext.subarray(16, 32)),
      rootKey: plaintext.slice(32) };
  } finally { key.fill(0); plaintext.fill(0); }
}

export async function rewrapPersonalSpaceBootstrap(record: PersonalSpaceBootstrap, oldPassword: string,
  newPassword: string, randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>) {
  const space = openPersonalSpaceBootstrap(record, oldPassword);
  try { return await seal(space, newPassword, randomBytes); }
  finally { space.rootKey.fill(0); }
}

/** Rewrap an already-unlocked space without retaining or re-entering the old password. */
export function wrapPersonalSpaceBootstrap(space: PersonalSpace, newPassword: string,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>) {
  return seal(space, newPassword, randomBytes);
}

const deriveSpaceKey = (space: PersonalSpace, purpose: string): Uint8Array => {
  if (!validId(space.id) || !validId(space.settingsFolderId) || space.rootKey.length !== 32) {
    throw new Error("Invalid personal space.");
  }
  return hkdf(sha256, space.rootKey, new Uint8Array(), new TextEncoder().encode(purpose), 32);
};

export function personalVaultKey(space: PersonalSpace): Uint8Array {
  return deriveSpaceKey(space, "syncpeer.personal-space.vault.v1");
}

export function settingsFolderPassword(space: PersonalSpace): string {
  const derived = deriveSpaceKey(space, "syncpeer.personal-space.settings-folder.v1");
  try { return hex(derived); }
  finally { derived.fill(0); }
}
