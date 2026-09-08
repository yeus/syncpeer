import type { BepFileInfo } from "../core/protocol/bep.js";
import type { ReplicaIndex } from "./replicaIndex.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";
import { mergeVersionVectors } from "../core/protocol/versionVector.js";

const serializeInfo = (info: BepFileInfo) => ({ ...info,
  blocks: info.blocks?.map(block => ({ ...block, hash: Array.from(block.hash) })),
});

const deserializeInfo = (value: unknown): BepFileInfo => {
  if (!value || typeof value !== "object") throw new Error("Invalid persisted replica metadata.");
  const info = value as ReturnType<typeof serializeInfo>;
  if (typeof info.name !== "string") throw new Error("Invalid persisted replica name.");
  assertReplicaPath(info.name);
  if (isInternalReplicaPath(info.name)) throw new Error("Internal path in persisted replica metadata.");
  for (const number of [info.size, info.sequence, info.block_size]) {
    if (number !== undefined && (!Number.isSafeInteger(Number(number)) || Number(number) < 0)) throw new Error("Invalid persisted replica number.");
  }
  if (info.version) mergeVersionVectors(info.version, {});
  if (info.blocks !== undefined && !Array.isArray(info.blocks)) throw new Error("Invalid persisted replica blocks.");
  const { blocks: storedBlocks, ...metadata } = info;
  const blocks = storedBlocks?.map(block => {
    if (!block || !Number.isSafeInteger(Number(block.offset)) || Number(block.offset) < 0 ||
      !Number.isSafeInteger(block.size) || block.size < 0 || !Array.isArray(block.hash) || block.hash.length !== 32 ||
      block.hash.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("Invalid persisted replica block.");
    return { ...block, hash: new Uint8Array(block.hash) };
  });
  return { ...metadata, ...(blocks ? { blocks } : {}) };
};

/** Shared on-disk codec; platform adapters only load/store the resulting bytes. */
export function encodeReplicaIndex(index: ReplicaIndex): Uint8Array {
  const files = Object.fromEntries(Object.entries(index.files).map(([name, entry]) => [name, {
    revision: entry.revision, info: serializeInfo(entry.info),
  }]));
  return new TextEncoder().encode(JSON.stringify({ format: 1, sequence: index.sequence, files,
    ...(index.pending ? { pending: serializeInfo(index.pending) } : {}),
  }));
}

export function decodeReplicaIndex(bytes: Uint8Array): ReplicaIndex {
  const stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!stored || stored.format !== 1 || !Number.isSafeInteger(stored.sequence) || stored.sequence < 0 ||
    !stored.files || typeof stored.files !== "object" || Array.isArray(stored.files)) throw new Error("Invalid persisted replica index.");
  const files: ReplicaIndex["files"] = Object.create(null);
  for (const [name, raw] of Object.entries(stored.files)) {
    const value = raw as { revision: unknown; info: unknown };
    if (!value || typeof value.revision !== "string") throw new Error("Invalid persisted replica revision.");
    const info = deserializeInfo(value.info);
    if (info.name !== name) throw new Error("Replica index path mismatch.");
    files[name] = { revision: value.revision, info };
  }
  return { format: 1, sequence: stored.sequence, files,
    ...(stored.pending !== undefined ? { pending: deserializeInfo(stored.pending) } : {}),
  };
}
