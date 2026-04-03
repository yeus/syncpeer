import { aessiv } from "@noble/ciphers/aes.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BASE32_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
const PASSWORD_TOKEN_PREFIX = "syncthing";
const ENCRYPTED_DIR_EXTENSION = ".syncthing-enc";
const XCHACHA_NONCE_SIZE = 24;
const EMPTY_AAD = new Uint8Array(0);

export interface UntrustedFolderCrypto {
  folderId: string;
  folderKey: Uint8Array;
  passwordToken: Uint8Array;
}

export interface UntrustedFileRequestBlock {
  offset: number;
  size: number;
  hash: Uint8Array;
}

export interface UntrustedFileRequestInfo {
  encryptedName: string;
  fileKey: Uint8Array;
  encryptedBlocks: UntrustedFileRequestBlock[];
}

function decodeBase32NoPadding(value: string): Uint8Array {
  let bits = 0;
  let current = 0;
  const output: number[] = [];
  for (const char of value.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

function encodeBase32NoPadding(value: Uint8Array): string {
  let bits = 0;
  let current = 0;
  let out = "";
  for (const byte of value) {
    current = (current << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(current >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(current << (5 - bits)) & 31];
  }
  return out;
}

function normalizeEncryptedName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Encrypted filename is empty");
  }
  if (!trimmed.slice(1).startsWith(ENCRYPTED_DIR_EXTENSION)) {
    throw new Error(`Invalid encrypted path: ${trimmed}`);
  }
  const deslashed = `${trimmed.slice(0, 1)}${trimmed.slice(1 + ENCRYPTED_DIR_EXTENSION.length)}`;
  return deslashed.replace(/\//g, "");
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export async function deriveUntrustedFolderCrypto(
  folderId: string,
  password: string,
): Promise<UntrustedFolderCrypto> {
  const passwordBytes = textEncoder.encode(password);
  const salt = textEncoder.encode(`${PASSWORD_TOKEN_PREFIX}${folderId}`);
  const folderKey = scrypt(passwordBytes, salt, {
    N: 32768,
    r: 8,
    p: 1,
    dkLen: 32,
  });
  const passwordToken = aessiv(folderKey, EMPTY_AAD).encrypt(salt);
  return {
    folderId,
    folderKey,
    passwordToken,
  };
}

export async function verifyUntrustedPasswordToken(
  folderCrypto: UntrustedFolderCrypto,
  expectedToken: Uint8Array | null | undefined,
): Promise<boolean> {
  if (!expectedToken || expectedToken.length === 0) return true;
  return bytesEqual(folderCrypto.passwordToken, expectedToken);
}

export async function decryptEncryptedFilename(
  folderKey: Uint8Array,
  encryptedName: string,
): Promise<string> {
  const normalized = normalizeEncryptedName(encryptedName);
  const sealed = decodeBase32NoPadding(normalized);
  const plaintext = aessiv(folderKey, EMPTY_AAD).decrypt(sealed);
  return textDecoder.decode(plaintext);
}

export async function encryptUntrustedFilename(
  folderKey: Uint8Array,
  plaintextName: string,
): Promise<string> {
  const sealed = aessiv(folderKey, EMPTY_AAD).encrypt(textEncoder.encode(plaintextName));
  const base32 = encodeBase32NoPadding(sealed);
  const first = base32.slice(0, 1);
  const secondThird = base32.slice(1, 3);
  const rest = base32.slice(3);
  const chunks: string[] = [];
  for (let offset = 0; offset < rest.length; offset += 200) {
    chunks.push(rest.slice(offset, offset + 200));
  }
  return [`${first}${ENCRYPTED_DIR_EXTENSION}`, secondThird, ...chunks.filter(Boolean)]
    .filter(Boolean)
    .join("/");
}

export function deriveUntrustedFileKey(
  folderKey: Uint8Array,
  plaintextName: string,
): Uint8Array {
  return hkdf(
    sha256,
    concatBytes(folderKey, textEncoder.encode(plaintextName)),
    textEncoder.encode(PASSWORD_TOKEN_PREFIX),
    new Uint8Array(0),
    32,
  );
}

export function encryptUntrustedBlockHash(
  fileKey: Uint8Array,
  hash: Uint8Array,
): Uint8Array {
  return aessiv(fileKey, EMPTY_AAD).encrypt(hash);
}

export function encryptUntrustedBytes(
  fileKey: Uint8Array,
  payload: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  if (nonce.length !== XCHACHA_NONCE_SIZE) {
    throw new Error(`Invalid XChaCha nonce length: expected ${XCHACHA_NONCE_SIZE}, got ${nonce.length}`);
  }
  const encrypted = xchacha20poly1305(fileKey, nonce).encrypt(payload);
  return concatBytes(nonce, encrypted);
}

export function decryptUntrustedBytes(
  fileKey: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  if (payload.length < XCHACHA_NONCE_SIZE + 16) {
    throw new Error("Encrypted payload is truncated");
  }
  const nonce = payload.slice(0, XCHACHA_NONCE_SIZE);
  const ciphertext = payload.slice(XCHACHA_NONCE_SIZE);
  return xchacha20poly1305(fileKey, nonce).decrypt(ciphertext);
}
