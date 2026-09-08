import { planBlockRange } from "../transfer/blockReuse.js";
import type { LocalFolderReplica } from "./replicaIndex.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

/** Optimistic versioned source: reads fail if the captured blocks are no longer available. */
export async function createReplicaFileSource(replica: LocalFolderReplica, path: string) {
  assertReplicaPath(path);
  if (isInternalReplicaPath(path)) throw new Error("Internal replica file cannot be opened.");
  const entry = (await replica.scan()).find(file => file.name === path);
  if (!entry || entry.deleted || entry.invalid || Number(entry.type ?? 0) !== 0) throw new Error("Replica file is unavailable.");
  const info = structuredClone(entry);
  const size = Number(info.size ?? 0);
  const blocks = (info.blocks ?? []).map(block => ({ offset: Number(block.offset), size: Number(block.size), hash: block.hash }));
  planBlockRange(blocks, size, 0, 0);
  return {
    size,
    get fileInfo() { return structuredClone(info); },
    readRange: async (offset: number, length: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const plan = planBlockRange(blocks, size, offset, length);
      const result = new Uint8Array(plan.size);
      for (const part of plan.blocks) {
        signal?.throwIfAborted();
        const block = blocks[part.index];
        const bytes = await replica.readBlock(path, block.offset, block.size, block.hash);
        signal?.throwIfAborted();
        if (bytes.length !== block.size) throw new Error("Replica file changed during range read.");
        result.set(bytes.subarray(part.sourceOffset, part.sourceOffset + part.size), part.targetOffset);
      }
      return result;
    },
  };
}
