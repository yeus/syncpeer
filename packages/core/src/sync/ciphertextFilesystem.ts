import { FileInfo, type BepFileInfo } from "../core/protocol/bep.js";
import { BEP_MAX_BLOCK_SIZE } from "../core/protocol/blockLimits.js";
import type { FileDownloadSink } from "../transfer/stream.js";

export interface EncryptedFileSource {
  size: number;
  readRange: (offset: number, size: number) => Promise<Uint8Array>;
}

/** Structural validation only: encrypted tokens are not ciphertext digests. */
export const validateCiphertextMetadata = (encrypted: BepFileInfo) => {
  if (!/^[0-9A-V]\.syncthing-enc\/[0-9A-V]{2}\/(?:[0-9A-V]{200}\/)*[0-9A-V]{1,200}$/.test(encrypted.name) ||
    ![0, 1].includes(Number(encrypted.type ?? 0))) throw new Error("Invalid encrypted file descriptor.");
  if (!(encrypted.encrypted instanceof Uint8Array) || encrypted.encrypted.length < 40) throw new Error("Encrypted metadata is missing.");
  let end = 0;
  for (const block of encrypted.blocks ?? []) {
    if (Number(block.offset) !== end || !Number.isSafeInteger(block.size) || block.size < 1064 ||
      block.size > BEP_MAX_BLOCK_SIZE + 40 || !(block.hash instanceof Uint8Array) || block.hash.length !== 48) {
      throw new Error("Invalid encrypted block layout.");
    }
    end += block.size;
    if (!Number.isSafeInteger(end)) throw new Error("Oversized encrypted block layout.");
  }
  if (!Number.isSafeInteger(Number(encrypted.size ?? 0)) || Number(encrypted.size ?? 0) !== end ||
    (Number(encrypted.type ?? 0) === 1 && end !== 0)) throw new Error("Encrypted blocks do not cover file layout.");
};

export const encodeCiphertextTrailer = (encrypted: BepFileInfo) => {
  validateCiphertextMetadata(encrypted);
  if (Number(encrypted.type ?? 0) !== 0 || encrypted.deleted || encrypted.invalid) throw new Error("Invalid encrypted file descriptor.");
  const trailer = FileInfo.encode(encrypted).finish();
  if (trailer.length > 64 * 1024 * 1024) throw new Error("Encrypted trailer is oversized.");
  const footer = new Uint8Array(4);
  new DataView(footer.buffer).setUint32(0, trailer.length, false);
  const storedSize = Number(encrypted.size) + trailer.length + 4;
  if (!Number.isSafeInteger(storedSize)) throw new Error("Encrypted file is oversized.");
  return { trailer, footer, storedSize };
};

export const readExactEncryptedRange = async (source: EncryptedFileSource, offset: number, size: number, signal?: AbortSignal) => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > source.size) {
    throw new Error("Encrypted file read is outside storage bounds.");
  }
  const bytes = new Uint8Array(size);
  for (let consumed = 0; consumed < size; consumed += 131072) {
    signal?.throwIfAborted();
    const length = Math.min(131072, size - consumed);
    const chunk = await source.readRange(offset + consumed, length);
    signal?.throwIfAborted();
    if (chunk.length !== length) throw new Error("Encrypted file is truncated.");
    bytes.set(chunk, consumed);
  }
  return bytes;
};

export const writeCiphertextRange = async (sink: Pick<FileDownloadSink, "write">, offset: number, bytes: Uint8Array, check: () => void) => {
  for (let start = 0; start < bytes.length; start += 131072) {
    check();
    await sink.write(offset + start, bytes.subarray(start, start + 131072));
  }
};

/** Parse a received file without keys. Authentication remains pending until unlock. */
export async function loadCiphertextDiskMetadata(source: EncryptedFileSource, encryptedName: string, signal?: AbortSignal) {
  if (!Number.isSafeInteger(source.size) || source.size < 4) throw new Error("Encrypted trailer is missing.");
  const footer = await readExactEncryptedRange(source, source.size - 4, 4, signal);
  const length = new DataView(footer.buffer, footer.byteOffset, 4).getUint32(0, false);
  if (!length || length > 64 * 1024 * 1024 || length > source.size - 4) throw new Error("Invalid or oversized encrypted trailer.");
  const dataSize = source.size - length - 4;
  const encrypted = FileInfo.decode(await readExactEncryptedRange(source, dataSize, length, signal)) as unknown as BepFileInfo;
  if (encrypted.name !== encryptedName) throw new Error("Encrypted trailer name does not match its storage path.");
  validateCiphertextMetadata(encrypted);
  if (Number(encrypted.type ?? 0) !== 0 || encrypted.deleted || encrypted.invalid) throw new Error("Invalid encrypted file descriptor.");
  if (Number(encrypted.size) !== dataSize) throw new Error("Encrypted block layout mismatch.");
  return { encrypted, dataSize, verification: "pending-unlock" as const };
}

/** The host must keep the source revision stable for this advertised descriptor. */
export async function readCiphertextBlock(source: EncryptedFileSource,
  metadata: Awaited<ReturnType<typeof loadCiphertextDiskMetadata>>,
  offset: number, size: number, token: Uint8Array, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 1064 ||
    size > BEP_MAX_BLOCK_SIZE + 40 || offset + size > metadata.dataSize) throw new Error("Ciphertext block is not in the advertised metadata.");
  const block = metadata.encrypted.blocks?.find(block => Number(block.offset) === offset && block.size === size &&
    token.length === block.hash.length && token.every((byte, index) => byte === block.hash[index]));
  if (!block) throw new Error("Ciphertext block is not in the advertised metadata.");
  return readExactEncryptedRange(source, offset, size, signal);
}

/** Store ciphertext verbatim. No key, encryption, decryption, or random source is accepted. */
export async function receiveCiphertextFile(args: {
  encrypted: BepFileInfo;
  requestBlock: (offset: number, size: number, token: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array>;
  createSink: (encrypted: BepFileInfo, size: number) => Promise<Pick<FileDownloadSink, "write" | "commit" | "abort">>;
  signal?: AbortSignal;
}) {
  args.signal?.throwIfAborted();
  const { trailer, footer, storedSize } = encodeCiphertextTrailer(args.encrypted);
  // Preserve protobuf defaults and uint64 values while detaching caller-owned metadata.
  const encrypted = FileInfo.decode(trailer) as unknown as BepFileInfo;
  const sink = await args.createSink(encrypted, storedSize);
  try {
    for (const block of encrypted.blocks ?? []) {
      args.signal?.throwIfAborted();
      const bytes = await args.requestBlock(Number(block.offset), block.size, block.hash, args.signal);
      if (bytes.length !== block.size) throw new Error("Ciphertext response length mismatch or truncated block.");
      await writeCiphertextRange(sink, Number(block.offset), bytes, () => args.signal?.throwIfAborted());
    }
    await writeCiphertextRange(sink, Number(encrypted.size), trailer, () => args.signal?.throwIfAborted());
    await writeCiphertextRange(sink, Number(encrypted.size) + trailer.length, footer, () => args.signal?.throwIfAborted());
    args.signal?.throwIfAborted();
    await sink.commit();
    return { encrypted, verification: "pending-unlock" as const };
  } catch (error) { await sink.abort(error); throw error; }
}
