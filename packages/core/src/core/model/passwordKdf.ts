import { scrypt } from "@noble/hashes/scrypt.js";

/** Memory-hard password key derivation. Platforms may run a port off the UI
 * thread; the reference implementation computes in-process and therefore
 * blocks its caller until the derivation finishes.
 */
export type PasswordKdf = (passwordBytes: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>;

/** Canonical in-process derivation shared by every platform default. */
export const scryptPasswordKdf: PasswordKdf = async (passwordBytes, salt) =>
  scrypt(passwordBytes, salt, { N: 32768, r: 8, p: 1, dkLen: 32 });
