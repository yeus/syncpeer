import { sha256 } from "@noble/hashes/sha2.js";
import type { BepFileInfo } from "./bep.js";

/** Syncthing requires one authenticated empty block for live zero-byte files.
 * The untrusted representation expands it to one padded ciphertext block. */
export const emptyFileBlock = () => ({ offset: 0, size: 0, hash: sha256(new Uint8Array()) });

/** Normalize at publication boundaries, including legacy persisted indexes.
 * Do not modify tombstones, invalid files, directories or nonempty content. */
export const withEmptyFileBlock = (file: BepFileInfo): BepFileInfo =>
  !file.deleted && !file.invalid && Number(file.type ?? 0) === 0 &&
  Number(file.size ?? 0) === 0 && !(file.blocks ?? file.Blocks ?? []).length
    ? { ...file, blocks: [emptyFileBlock()] } : file;
