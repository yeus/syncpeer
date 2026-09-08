import type { ReplicaByteStorage } from "./encryptedReplicaStorage.js";
import type { ReplicaWritableScratch } from "./replicaWritableFile.js";
import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import { BEP_MAX_BLOCK_SIZE } from "../core/protocol/blockLimits.js";
import type { ReplicaEntry } from "./replicaIndex.js";

/** Only the exclusive folder owner may reclaim scratch after process death.
 * Published files never reference these ephemeral, independently encrypted chunks.
 */
export async function removeAbandonedEncryptedScratch(storage: ReplicaByteStorage & {
  listDirectory: (path: string) => Promise<ReplicaEntry[]>;
}) {
  for (const root of await storage.listDirectory("")) {
    if (root.type !== "directory" || !/^\.syncpeer-scratch-[a-f0-9]{32}$/.test(root.path)) continue;
    const chunks = await storage.listDirectory(root.path);
    if (chunks.some(chunk => chunk.type !== "file" || !/^\d+$/.test(chunk.path.slice(root.path.length + 1)))) continue;
    for (const chunk of chunks) await storage.remove(chunk.path, false);
    await storage.remove(root.path, true);
  }
}

/** Temporary edits use Syncthing records and an ephemeral key; no plaintext spill files. */
export async function createEncryptedScratch(storage: ReplicaByteStorage,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>): Promise<ReplicaWritableScratch> {
  const key = await randomBytes(32);
  const prefix = ".syncpeer-scratch-" + [...await randomBytes(16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (await storage.stat(prefix)) { key.fill(0); throw new Error("Scratch already exists."); }
  try { await storage.makeDirectory(prefix); } catch (error) { key.fill(0); throw error; }
  const chunks = new Set<number>();
  const blockSize = 131072;
  let length = 0, closed = false, failed = false;
  let queue = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  const run = <T>(operation: () => Promise<T>) => {
    const result = queue.then(async () => {
      if (closed || failed) throw new Error("Encrypted scratch is closed or failed.");
      try { return await operation(); } catch (error) { failed = true; throw error; }
    });
    queue = result.then(() => {}, () => {});
    return result;
  };
  const range = (offset: number, size: number, bounded = true) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 ||
      !Number.isSafeInteger(offset + size) || (bounded && size > BEP_MAX_BLOCK_SIZE)) throw new Error("Invalid scratch range.");
  };
  const name = (index: number) => `${prefix}/${index}`;
  const load = async (index: number) => {
    if (!chunks.has(index)) return new Uint8Array(blockSize);
    const path = name(index), entry = await storage.stat(path);
    if (!entry || entry.type !== "file") throw new Error("Scratch block is missing.");
    const bytes = await readEncryptedRecord({ size: entry.size,
      readRange: (offset, size) => storage.readRange(path, offset, size) }, key, path);
    if (bytes.length !== blockSize) { bytes.fill(0); throw new Error("Invalid scratch block."); }
    return bytes;
  };
  const save = async (index: number, bytes: Uint8Array) => {
    const path = name(index);
    chunks.add(index); // Track cleanup even if publication fails partway through.
    await writeEncryptedRecord({ name: path, bytes, folderKey: key, randomBytes,
      createSink: (_info, size) => storage.createSink(path, size) });
  };
  return {
    size: () => run(async () => length),
    readRange: (offset, size) => run(async () => {
      range(offset, size);
      const result = new Uint8Array(Math.max(0, Math.min(size, length - offset)));
      try {
        for (let done = 0; done < result.length;) {
          const position = offset + done, start = position % blockSize;
          const count = Math.min(result.length - done, blockSize - start);
          const bytes = await load(Math.floor(position / blockSize));
          try { result.set(bytes.subarray(start, start + count), done); } finally { bytes.fill(0); }
          done += count;
        }
        return result;
      } catch (error) { result.fill(0); throw error; }
    }),
    write: (offset, input) => run(async () => {
      range(offset, input.length);
      if (!input.length) return;
      for (let done = 0; done < input.length;) {
        const position = offset + done, index = Math.floor(position / blockSize), start = position % blockSize;
        const count = Math.min(input.length - done, blockSize - start), bytes = await load(index);
        try { bytes.set(input.subarray(done, done + count), start); await save(index, bytes); }
        finally { bytes.fill(0); }
        done += count;
      }
      length = Math.max(length, offset + input.length);
    }),
    truncate: size => run(async () => {
      range(0, size, false);
      if (size < length) {
        const last = Math.floor(size / blockSize), tail = size % blockSize;
        if (tail && chunks.has(last)) {
          const bytes = await load(last);
          try { bytes.fill(0, tail); await save(last, bytes); } finally { bytes.fill(0); }
        }
        for (const index of chunks) if (index >= Math.ceil(size / blockSize)) {
          await storage.remove(name(index), false); chunks.delete(index);
        }
      }
      length = size;
    }),
    close: () => {
      closed = true;
      cleanup ??= queue.then(async () => {
        try {
          for (const index of chunks) {
            if (await storage.stat(name(index))) await storage.remove(name(index), false);
            chunks.delete(index);
          }
          if (await storage.stat(prefix)) await storage.remove(prefix, true);
        } finally { key.fill(0); }
      }).catch(error => { cleanup = undefined; throw error; });
      return cleanup;
    },
  };
}
