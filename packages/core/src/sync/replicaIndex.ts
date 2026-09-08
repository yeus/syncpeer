import type { BepBlockInfo, BepFileInfo, BepVersionVector } from "../core/protocol/bep.js";
import { BEP_MAX_BLOCK_SIZE } from "../core/protocol/blockLimits.js";
import { advanceVersionVector } from "../core/protocol/versionVector.js";
import { equalHash, validateBlockPlan } from "../transfer/blockReuse.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

export interface ReplicaEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedMs: number;
  /** Opaque storage change token, including changes made without changing mtime. */
  revision: string;
}

export interface ReplicaIndex {
  format: 1;
  sequence: number;
  files: Record<string, { revision: string; info: BepFileInfo }>;
  pending?: BepFileInfo;
}

export interface ReplicaSource {
  listEntries: () => Promise<ReplicaEntry[]>;
  readRange: (path: string, offset: number, size: number) => Promise<Uint8Array>;
}

export type ReplicaBlockReader = (path: string, offset: number, size: number, hash?: Uint8Array) => Promise<Uint8Array>;

export type LocalReplicaEdit = {
  folderId: string;
  path: string;
  /** Null means no prior entry, including no tombstone. */
  expectedVersion: BepVersionVector | null;
  modifiedMs: number;
} & ({ method: "write";
  /** Immutable plaintext snapshot; core reads bounded ranges and verifies publication. */
  source: { size: number; readRange: (offset: number, size: number) => Promise<Uint8Array> };
} | { method: "mkdir" | "delete" });

export interface LocalFolderReplica {
  isPaused?: () => boolean;
  scan: () => Promise<BepFileInfo[]>;
  readBlock: ReplicaBlockReader;
  receive?: (folderId: string, files: BepFileInfo[], request: ReplicaBlockReader) => Promise<boolean>;
  edit?: (edit: LocalReplicaEdit) => Promise<BepFileInfo>;
}

export async function readReplicaBlock(
  index: ReplicaIndex | null,
  readRange: ReplicaSource["readRange"],
  request: { path: string; offset: number; size: number; hash?: Uint8Array },
  hashBytes: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<Uint8Array> {
  const { path, offset, size, hash } = request;
  assertReplicaPath(path);
  if (isInternalReplicaPath(path)) throw new Error("Internal replica paths cannot be requested.");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size <= 0 || size > BEP_MAX_BLOCK_SIZE) {
    throw new Error("Requested replica block is not in the published index.");
  }
  const candidates = Object.values(index?.files ?? {}).filter(entry => entry.info.name === path ||
    (hash && entry.info.name.startsWith(`${path}.sync-conflict-`)));
  for (const { info } of candidates) {
    const block = info.blocks?.find(block => Number(block.offset) === offset && block.size === size &&
      (!hash || equalHash(block.hash, hash)));
    if (!block || info.deleted) continue;
    const bytes = await readRange(info.name, offset, size);
    if (bytes.length === size && equalHash(await hashBytes(bytes), block.hash)) return bytes;
  }
  throw new Error("Replica file changed since publication or requested block is unavailable.");
}

const entryMap = (entries: ReplicaEntry[]) => {
  const result = new Map<string, ReplicaEntry>();
  for (const entry of entries) {
    assertReplicaPath(entry.path);
    if (isInternalReplicaPath(entry.path)) continue;
    if (result.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error("Invalid local replica entry.");
    }
    result.set(entry.path, entry);
  }
  return result;
};

export const hashReplicaEntry = async (
  entry: ReplicaEntry,
  source: Pick<ReplicaSource, "readRange">,
  hash: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
  signal?: AbortSignal,
) => {
  const blocks: BepBlockInfo[] = [];
  if (entry.type === "directory") return blocks;
  for (let offset = 0; offset < entry.size; offset += 131072) {
    signal?.throwIfAborted();
    const size = Math.min(131072, entry.size - offset);
    const bytes = await source.readRange(entry.path, offset, size);
    if (bytes.length !== size) throw new Error("Local replica changed during hashing.");
    const digest = await hash(bytes);
    if (digest.length !== 32) throw new Error("Invalid local replica digest.");
    blocks.push({ offset, size, hash: digest });
  }
  return blocks;
};

/** Core owns block boundaries, causal versions and tombstones; storage supplies bytes. */
export async function scanReplicaIndex(
  source: ReplicaSource,
  deviceCounterId: string,
  previous: ReplicaIndex | null,
  hash: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReplicaIndex> {
  signal?.throwIfAborted();
  const entries = entryMap(await source.listEntries());
  const files: ReplicaIndex["files"] = Object.create(null);
  for (const [name, entry] of Object.entries(previous?.files ?? {})) {
    assertReplicaPath(name);
    if (!isInternalReplicaPath(name)) files[name] = entry;
  }
  let sequence = previous?.sequence ?? 0;
  const pending = previous?.pending;
  if (pending) {
    assertReplicaPath(pending.name);
    if (isInternalReplicaPath(pending.name)) throw new Error("Internal replica path in pending update.");
    const entry = entries.get(pending.name);
    let matches = pending.deleted ? !entry : entry?.type === "directory" && pending.type === 1;
    if (!pending.deleted && pending.type !== 1 && entry?.type === "file" && entry.size === Number(pending.size)) {
      const blocks = (pending.blocks ?? []).map(block => ({ ...block, offset: Number(block.offset) }));
      validateBlockPlan(blocks, entry.size);
      matches = true;
      for (const block of blocks) {
        signal?.throwIfAborted();
        if (block.size === 0) continue; // The shared plan validator verified the empty digest.
        const bytes = await source.readRange(pending.name, block.offset, block.size);
        if (bytes.length !== block.size || !equalHash(await hash(bytes), block.hash)) { matches = false; break; }
      }
    }
    if (matches) files[pending.name] = { revision: entry?.revision ?? "deleted", info: { ...pending, sequence: ++sequence } };
  }
  for (const [name, entry] of entries) {
    const old = files[name];
    if (entry.type === "directory" && old?.info.type === 1 && !old.info.deleted) {
      files[name] = { ...old, revision: entry.revision };
      continue;
    }
    if (old && !old.info.deleted && old.revision === entry.revision &&
        old.info.size === entry.size && old.info.type === (entry.type === "file" ? 0 : 1)) continue;
    const blocks = await hashReplicaEntry(entry, source, hash, signal);
    files[name] = { revision: entry.revision, info: {
      name, type: entry.type === "file" ? 0 : 1, size: entry.size,
      modified_s: Math.floor(entry.modifiedMs / 1000), modified_ns: Math.floor(entry.modifiedMs % 1000) * 1000000,
      deleted: false, blocks, sequence: ++sequence,
      version: advanceVersionVector(old?.info.version, deviceCounterId),
    } };
  }
  for (const [name, old] of Object.entries(files)) {
    if (entries.has(name) || old.info.deleted) continue;
    files[name] = { revision: "deleted", info: { ...old.info, size: 0, blocks: [], deleted: true,
      sequence: ++sequence, version: advanceVersionVector(old.info.version, deviceCounterId) } };
  }
  signal?.throwIfAborted();
  const after = entryMap(await source.listEntries());
  if (after.size !== entries.size || [...entries].some(([name, entry]) => {
    const current = after.get(name);
    return !current || current.revision !== entry.revision || current.size !== entry.size || current.type !== entry.type;
  })) throw new Error("Local replica changed during hashing.");
  return { format: 1, sequence, files };
}
