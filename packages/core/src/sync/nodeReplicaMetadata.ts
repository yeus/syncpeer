import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeReplicaIndex, encodeReplicaIndex } from "./replicaPersistence.js";
import type { ReplicaIndex } from "./replicaIndex.js";
import type { createNodeMetadataStorage } from "./nodeMetadataStorage.js";

type Metadata = Awaited<ReturnType<typeof createNodeMetadataStorage>>;

/** Store each file separately while preserving the core's atomic index snapshot contract. */
export function saveSqliteReplicaIndex(storage: Metadata, index: ReplicaIndex) {
  const records = Object.entries(index.files).map(([name, entry]) => ({ id: `file/${name}`,
    value: encodeReplicaIndex({ format: 1, sequence: 0, files: { [name]: entry } }) }));
  records.push({ id: "header", value: encodeReplicaIndex({ ...index, files: {} }) });
  storage.replace("replica", records);
}

export function loadSqliteReplicaIndex(storage: Metadata): ReplicaIndex | null {
  const records = storage.entries("replica");
  if (!records.length) return null;
  const header = records.find(record => record.id === "header");
  if (!header) throw new Error("Replica metadata header missing; restore synchronization history.");
  const index = decodeReplicaIndex(header.value);
  for (const record of records) {
    if (record.id === "header") continue;
    const entry = decodeReplicaIndex(record.value);
    if (!record.id.startsWith("file/") || Object.keys(entry.files).length !== 1 || !entry.files[record.id.slice(5)]) throw new Error("Invalid replica metadata record.");
    index.files[record.id.slice(5)] = entry.files[record.id.slice(5)];
  }
  return index;
}

export async function readLegacyMetadata(filename: string) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("Invalid legacy synchronization metadata.");
    return new Uint8Array(await readFile(filename));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function migrateReplicaMetadata(root: string, storage: Metadata) {
  const indexPath = path.join(root, ".syncpeer-replica.json");
  const legacy = await readLegacyMetadata(indexPath);
  const current = loadSqliteReplicaIndex(storage);
  if (legacy) {
    const decoded = decodeReplicaIndex(legacy);
    if (current && !isDeepStrictEqual(current, decoded)) throw new Error("Legacy replica differs from SQLite; reconcile history before migrating.");
    if (!current) saveSqliteReplicaIndex(storage, decoded);
  }
  const settingsPath = path.join(root, ".syncpeer-replica-settings.json");
  const settings = await readLegacyMetadata(settingsPath);
  if (settings) {
    const parsed = JSON.parse(new TextDecoder().decode(settings));
    if (parsed.format !== 1 || typeof parsed.paused !== "boolean") throw new Error("Invalid replica settings.");
    const current = storage.entries("replica-settings")[0];
    if (current && current.value[0] !== Number(parsed.paused)) throw new Error("Legacy replica settings differ from SQLite.");
    if (!current) storage.replace("replica-settings", [{ id: "paused", value: new Uint8Array([Number(parsed.paused)]) }]);
  }
  // SQLite has committed before retiring legacy files. Never use them as fallback on corruption.
  if (legacy) await rm(indexPath);
  if (settings) await rm(settingsPath);
}

export async function initializeNodeMarker(root: string, storage: Metadata) {
  const marker = path.join(root, ".stfolder");
  const legacy = path.join(root, ".syncpeer-folder-marker");
  const expected = storage.entries("marker")[0];
  let info;
  try { info = await lstat(marker, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (expected) throw new Error("Replica folder marker missing; verify storage before resuming.", { cause: error });
    if (await readLegacyMetadata(path.join(root, ".syncpeer-replica.json")) && !await readLegacyMetadata(legacy)) {
      throw new Error("Legacy replica folder marker missing; recover before migrating.", { cause: error });
    }
    await mkdir(marker);
    info = await lstat(marker, { bigint: true });
  }
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("Invalid replica folder marker.");
  const identity = `${info.dev}:${info.ino}`;
  if (expected && new TextDecoder().decode(expected.value) !== identity) throw new Error("Replica folder marker replaced; verify storage before resuming.");
  const directory = await open(root, "r");
  try { await directory.sync(); } finally { await directory.close(); }
  if (!expected) storage.replace("marker", [{ id: "identity", value: new TextEncoder().encode(identity) }]);
  return async () => {
    const current = await lstat(marker, { bigint: true });
    if (current.isSymbolicLink() || `${current.dev}:${current.ino}` !== identity) throw new Error("Replica folder marker unavailable or replaced.");
  };
}
