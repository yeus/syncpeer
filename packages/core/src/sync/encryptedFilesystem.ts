import { sha256 } from "@noble/hashes/sha2.js";
import type { BepFileInfo } from "../core/protocol/bep.js";
import { BEP_MAX_BLOCK_SIZE } from "../core/protocol/blockLimits.js";
import { decryptUntrustedFileInfo, encryptUntrustedFileInfo } from "../core/model/untrustedMetadata.js";
import { decryptUntrustedBytes, deriveUntrustedFileKey, encryptUntrustedBlock } from "../core/model/untrusted.js";
import { equalHash, validateBlockPlan, planBlockRange } from "../transfer/blockReuse.js";
import type { FileDownloadSink } from "../transfer/stream.js";
import { assertReplicaPath } from "./replicaPaths.js";
import { encodeCiphertextTrailer, loadCiphertextDiskMetadata, readExactEncryptedRange as readExact, writeCiphertextRange, type EncryptedFileSource } from "./ciphertextFilesystem.js";
export type { EncryptedFileSource } from "./ciphertextFilesystem.js";

const regularFileInfo = (file: BepFileInfo) => {
  assertReplicaPath(file.name);
  if (file.invalid || file.deleted || Number(file.type ?? 0) !== 0) throw new Error("Encrypted entry is not a readable regular file.");
  const blocks = (file.blocks ?? []).map(block => ({ offset: Number(block.offset), size: Number(block.size), hash: block.hash }));
  const size = Number(file.size ?? 0);
  validateBlockPlan(blocks, size);
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].size > BEP_MAX_BLOCK_SIZE || (i < blocks.length - 1 && blocks[i].size < 1024)) {
      throw new Error("Unsupported encrypted file block size.");
    }
  }
  return { ...file, size, blocks };
};

/** Parse Syncthing's on-disk trailer; the caller keeps the source snapshot stable. */
export async function loadEncryptedDiskMetadata(
  source: EncryptedFileSource,
  encryptedName: string,
  folderKey: Uint8Array,
  signal?: AbortSignal,
) {
  const { encrypted, dataSize } = await loadCiphertextDiskMetadata(source, encryptedName, signal);
  const { fileInfo: decoded, fileKey } = await decryptUntrustedFileInfo(folderKey, encrypted);
  const fileInfo = regularFileInfo(decoded);
  const blocks = fileInfo.blocks;
  const encryptedBlocks = (encrypted.blocks ?? []).map(block => ({ offset: Number(block.offset), size: Number(block.size), hash: block.hash }));
  if (encryptedBlocks.length !== blocks.length || Number(encrypted.size ?? 0) !== dataSize) throw new Error("Encrypted block layout mismatch.");
  let end = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = encryptedBlocks[i];
    if (blocks[i].size > BEP_MAX_BLOCK_SIZE || block.offset !== end || block.size !== Math.max(1024, blocks[i].size) + 40) {
      throw new Error("Invalid encrypted block layout.");
    }
    end += block.size;
  }
  if (end !== dataSize) throw new Error("Encrypted blocks do not cover the stored content.");
  signal?.throwIfAborted();
  return { fileInfo, fileKey, encryptedBlocks, dataSize };
}

/** Streaming download encryption; only one plaintext block is buffered in core. */
export async function createEncryptedDownloadSink(args: {
  fileInfo: BepFileInfo;
  folderKey: Uint8Array;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
  createSink: (encrypted: BepFileInfo, storedSize: number) => Promise<Pick<FileDownloadSink, "write" | "commit" | "abort">>;
  signal?: AbortSignal;
}): Promise<{ sink: FileDownloadSink; encrypted: BepFileInfo }> {
  args.signal?.throwIfAborted();
  const file = regularFileInfo(args.fileInfo);
  const encrypted = await encryptUntrustedFileInfo(args.folderKey, file, await args.randomBytes(24));
  const { trailer, footer, storedSize } = encodeCiphertextTrailer(encrypted);
  args.signal?.throwIfAborted();
  const storage = await args.createSink(encrypted, storedSize);
  const fileKey = deriveUntrustedFileKey(args.folderKey, file.name);
  let state: "open" | "committing" | "committed" | "failed" | "aborted" = "open";
  let pending = Promise.resolve();
  let abortTask: Promise<void> | undefined;
  let offset = 0;
  let blockIndex = 0;
  let buffered = 0;
  let buffer = new Uint8Array();
  const check = () => {
    args.signal?.throwIfAborted();
    if (state === "aborted") throw new Error("Encrypted download sink is closed.");
  };
  const flushBlock = async () => {
    if (!equalHash(sha256(buffer), file.blocks[blockIndex].hash)) throw new Error("Source block digest mismatch.");
    await writeCiphertextRange(storage, Number(encrypted.blocks![blockIndex].offset), await encryptUntrustedBlock(fileKey, buffer, args.randomBytes), check);
    buffer.fill(0); buffer = new Uint8Array(); buffered = 0; blockIndex++;
  };
  const enqueue = (operation: () => Promise<void>) => {
    pending = pending.then(operation).catch(error => {
      if (state !== "aborted") state = "failed";
      buffer.fill(0); fileKey.fill(0);
      throw error;
    });
    return pending;
  };
  const sink: FileDownloadSink = {
    begin: async metadata => {
      if (state !== "open") throw new Error("Encrypted download sink is closed.");
      if (metadata.path !== file.name || metadata.sizeBytes !== file.size) throw new Error("Download metadata does not match encrypted file.");
      check();
    },
    write: async (position, bytes) => {
      if (state !== "open") throw new Error("Encrypted download sink is closed.");
      await enqueue(async () => {
        check();
        if (position !== offset || bytes.length > file.size - offset) throw new Error("Encrypted download requires contiguous plaintext writes.");
        for (let consumed = 0; consumed < bytes.length;) {
          const block = file.blocks[blockIndex];
          if (!buffer.length) buffer = new Uint8Array(block.size);
          const length = Math.min(bytes.length - consumed, block.size - buffered);
          buffer.set(bytes.subarray(consumed, consumed + length), buffered);
          buffered += length; consumed += length; offset += length;
          if (buffered === block.size) await flushBlock();
        }
      });
    },
    commit: async () => {
      if (state !== "open") throw new Error("Encrypted download sink is closed.");
      state = "committing";
      await enqueue(async () => {
        check();
        if (offset !== file.size) throw new Error("Encrypted download is incomplete.");
        if (file.blocks[blockIndex]?.size === 0) await flushBlock();
        await writeCiphertextRange(storage, Number(encrypted.size), trailer, check);
        await writeCiphertextRange(storage, Number(encrypted.size) + trailer.length, footer, check);
        check();
        await storage.commit();
        state = "committed"; fileKey.fill(0);
      });
    },
    abort: error => {
      if (state === "committed") return;
      if (abortTask) return abortTask;
      state = "aborted";
      abortTask = (async () => {
        await pending.catch(() => {});
        // An already-dispatched native commit may win while cancellation drains it.
        try { if ((state as string) !== "committed") await storage.abort(error); }
        finally { buffer.fill(0); fileKey.fill(0); }
      })();
      return abortTask;
    },
  };
  return { sink, encrypted };
}

/** Read an existing source through the same streaming writer used by downloads. */
export async function writeEncryptedDiskFile(args: Parameters<typeof createEncryptedDownloadSink>[0] & {
  source: EncryptedFileSource;
}): Promise<BepFileInfo> {
  if (Number(args.fileInfo.size ?? 0) !== args.source.size) throw new Error("Source size does not match encrypted file metadata.");
  const { sink, encrypted } = await createEncryptedDownloadSink(args);
  try {
    for (let offset = 0; offset < args.source.size; offset += 131072) {
      const bytes = await readExact(args.source, offset, Math.min(131072, args.source.size - offset), args.signal);
      try { await sink.write(offset, bytes); } finally { bytes.fill(0); }
    }
    await sink.commit();
    return encrypted;
  } catch (error) {
    try { await sink.abort(error); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Encrypted write and cleanup failed.", { cause: cleanupError });
    }
    throw error;
  }
}

/** Read a bounded plaintext range from the same snapshot used to load metadata. */
export async function readEncryptedDiskRange(
  source: EncryptedFileSource,
  metadata: Awaited<ReturnType<typeof loadEncryptedDiskMetadata>>,
  offset: number,
  size: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || size > BEP_MAX_BLOCK_SIZE) {
    throw new Error("Invalid or oversized plaintext read range.");
  }
  const blocks = metadata.fileInfo.blocks ?? [];
  const plan = planBlockRange(blocks.map(block => ({ ...block, offset: Number(block.offset) })), Number(metadata.fileInfo.size), offset, size);
  const result = new Uint8Array(plan.size);
  for (const part of plan.blocks) {
    const i = part.index;
    const blockSize = Number(blocks[i].size);
    const encrypted = metadata.encryptedBlocks[i];
    const plaintext = decryptUntrustedBytes(metadata.fileKey, await readExact(source, encrypted.offset, encrypted.size, signal));
    try {
      if (plaintext.length !== blockSize && !(i === blocks.length - 1 && plaintext.length > blockSize)) {
        throw new Error("Decrypted block size mismatch.");
      }
      if (!equalHash(sha256(plaintext.subarray(0, blockSize)), blocks[i].hash)) throw new Error("Decrypted block digest mismatch.");
      result.set(plaintext.subarray(part.sourceOffset, part.sourceOffset + part.size), part.targetOffset);
    } finally {
      plaintext.fill(0);
    }
  }
  signal?.throwIfAborted();
  return result;
}
