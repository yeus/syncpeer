import { sha256 } from "@noble/hashes/sha2.js";
import { BEP_MAX_BLOCK_SIZE } from "../core/protocol/blockLimits.js";

export interface DownloadRange {
  offset: number;
  size: number;
}

export interface RangeDigest extends DownloadRange {
  hash: Uint8Array;
}

export interface CachedRangeStorage {
  digestCachedRanges?: (ranges: readonly DownloadRange[]) => Promise<readonly RangeDigest[]>;
  copyCachedRanges?: (ranges: readonly DownloadRange[]) => Promise<void>;
}

const rangeKey = (range: DownloadRange): string => `${range.offset}:${range.size}`;

export const equalHash = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === 32 && right.length === 32 && left.every((byte, index) => byte === right[index]);

export const validateBlockPlan = (blocks: readonly RangeDigest[], size: number): void => {
  // Syncthing may advertise the authenticated empty block instead of no blocks.
  if (size === 0 && blocks.length === 1 && blocks[0].offset === 0 && blocks[0].size === 0 &&
    equalHash(blocks[0].hash, sha256(new Uint8Array()))) return;
  let end = 0;
  for (const block of blocks) {
    if (!Number.isSafeInteger(block.offset) || !Number.isSafeInteger(block.size) ||
        block.offset !== end || block.size <= 0 || block.hash.length !== 32) {
      throw new Error("Invalid download block plan.");
    }
    end += block.size;
  }
  if (!Number.isSafeInteger(size) || size < 0 || end !== size) {
    throw new Error("Download block plan does not cover the file.");
  }
};

/** Map a plaintext range to authenticated blocks, including EOF and empty files. */
export const planBlockRange = (blocks: readonly RangeDigest[], fileSize: number, offset: number, size: number) => {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || size > BEP_MAX_BLOCK_SIZE) {
    throw new Error("Invalid or oversized file range.");
  }
  validateBlockPlan(blocks, fileSize);
  if (blocks.some(block => block.size > BEP_MAX_BLOCK_SIZE)) throw new Error("Oversized file block.");
  const length = Math.min(size, Math.max(0, fileSize - offset));
  const selected: Array<{ index: number; sourceOffset: number; targetOffset: number; size: number }> = [];
  if (length) for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.offset >= offset + length) break;
    if (block.offset + block.size <= offset) continue;
    const from = Math.max(block.offset, offset), to = Math.min(block.offset + block.size, offset + length);
    selected.push({ index, sourceOffset: from - block.offset, targetOffset: from - offset, size: to - from });
  }
  return { size: length, blocks: selected };
};

const indexDigests = (requested: readonly DownloadRange[], digests: readonly RangeDigest[]) => {
  const allowed = new Set(requested.map(rangeKey));
  const result = new Map<string, Uint8Array>();
  for (const digest of digests) {
    const key = rangeKey(digest);
    if (!allowed.has(key) || result.has(key) || !(digest.hash instanceof Uint8Array) || digest.hash.length !== 32) {
      throw new Error("Invalid storage range digest response.");
    }
    result.set(key, digest.hash);
  }
  return result;
};

export const verifyBlockDigests = (blocks: readonly RangeDigest[], digests: readonly RangeDigest[]): void => {
  const indexed = indexDigests(blocks, digests);
  for (const block of blocks) {
    const hash = indexed.get(rangeKey(block));
    if (!hash || !equalHash(block.hash, hash)) throw new Error("Download block digest verification failed.");
  }
};

export const prepareCachedBlocks = async (
  blocks: readonly RangeDigest[],
  size: number,
  storage: CachedRangeStorage,
  signal?: AbortSignal,
  completed: readonly DownloadRange[] = [],
): Promise<DownloadRange[]> => {
  validateBlockPlan(blocks, size);
  signal?.throwIfAborted();
  if (!storage.digestCachedRanges || !storage.copyCachedRanges) return [];
  const reused: DownloadRange[] = [];
  const excluded = new Set(completed.map(rangeKey));
  // Bound bridge messages even for files containing many thousands of blocks.
  for (let start = 0; start < blocks.length; start += 256) {
    signal?.throwIfAborted();
    const batch = blocks.slice(start, start + 256).filter((block) => !excluded.has(rangeKey(block)));
    if (!batch.length) continue;
    const ranges = batch.map(({ offset, size }) => ({ offset, size }));
    const digests = indexDigests(ranges, await storage.digestCachedRanges(ranges));
    const matches = batch.filter((block) => {
      const hash = digests.get(rangeKey(block));
      return hash && equalHash(block.hash, hash);
    }).map(({ offset, size }) => ({ offset, size }));
    signal?.throwIfAborted();
    if (matches.length) await storage.copyCachedRanges(matches);
    reused.push(...matches);
  }
  return reused;
};
