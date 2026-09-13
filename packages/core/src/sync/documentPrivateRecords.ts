import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import type { ReplicaByteStorage } from "./encryptedReplicaStorage.js";
import type { FileEntry } from "../core/model/remoteFs.js";
import { assertReplicaPath } from "./replicaPaths.js";

const CATALOG_NAME = ".syncpeer-directory-catalog";
const ACCESS_NAME = ".syncpeer-cache-access";
const safeText = (value: unknown, label: string, maximum = 4096) => {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
};

const safeSnapshot = (value: StoredDirectorySnapshot): StoredDirectorySnapshot => {
  if (!value || !Array.isArray(value.entries) || value.entries.length > 10_000 ||
    !Number.isSafeInteger(value.loadedAtMs) || value.loadedAtMs < 0) throw new Error("Invalid directory snapshot.");
  return { versionKey: safeText(value.versionKey, "directory version"), loadedAtMs: value.loadedAtMs,
    entries: value.entries.map(entry => {
      if (!entry || !["file", "directory", "symlink"].includes(entry.type) || entry.name.includes("/") ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(entry.modifiedMs) || entry.modifiedMs < 0) {
        throw new Error("Invalid directory entry.");
      }
      assertReplicaPath(entry.path);
      if ((entry.invalid !== undefined && typeof entry.invalid !== "boolean") ||
        (entry.deleted !== undefined && typeof entry.deleted !== "boolean")) throw new Error("Invalid directory entry.");
      return { name: safeText(entry.name, "directory entry name"), path: safeText(entry.path, "directory entry path"),
        type: entry.type, size: entry.size, modifiedMs: entry.modifiedMs,
        ...(entry.invalid === undefined ? {} : { invalid: entry.invalid }),
        ...(entry.deleted === undefined ? {} : { deleted: entry.deleted }),
        ...(entry.fingerprint === undefined ? {} : { fingerprint: safeText(entry.fingerprint, "entry fingerprint") }) };
    }) };
};

export interface StoredDirectorySnapshot {
  entries: FileEntry[];
  versionKey: string;
  loadedAtMs: number;
}

interface DirectoryCatalog {
  format: 1;
  sources: Record<string, Record<string, StoredDirectorySnapshot>>;
}

const readJson = async <T>(bytes: ReplicaByteStorage, key: Uint8Array, name: string, fallback: T): Promise<T> => {
  const entry = await bytes.stat(name);
  if (!entry) return fallback;
  if (entry.type !== "file" || entry.size > 64 * 1024 * 1024) throw new Error("Invalid private document record.");
  const clear = await readEncryptedRecord({ size: entry.size,
    readRange: (offset, size) => bytes.readRange(name, offset, size) }, key, name);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear)) as T; }
  finally { clear.fill(0); }
};

const writeJson = async (bytes: ReplicaByteStorage, key: Uint8Array,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>, name: string, value: unknown) => {
  const clear = new TextEncoder().encode(JSON.stringify(value));
  try {
    await writeEncryptedRecord({ name, bytes: clear, folderKey: key, randomBytes,
      createSink: (_info, size) => bytes.createSink(name, size) });
    await bytes.flushChanges([name]);
  } finally { clear.fill(0); }
};

const catalog = async (bytes: ReplicaByteStorage, key: Uint8Array): Promise<DirectoryCatalog> => {
  const value = await readJson<DirectoryCatalog>(bytes, key, CATALOG_NAME, { format: 1, sources: {} });
  if (value?.format !== 1 || !value.sources || typeof value.sources !== "object") {
    throw new Error("Invalid directory catalog.");
  }
  const sources = Object.fromEntries(Object.entries(value.sources).map(([source, directories]) => {
    safeText(source, "catalog source", 1024);
    if (!directories || typeof directories !== "object" || Object.keys(directories).length > 64) {
      throw new Error("Invalid directory catalog.");
    }
    return [source, Object.fromEntries(Object.entries(directories).map(([path, snapshot]) => {
      safeText(path, "catalog path");
      if (path) assertReplicaPath(path);
      return [path, safeSnapshot(snapshot)];
    }))];
  }));
  return { format: 1, sources };
};

export const loadDirectorySnapshot = async (bytes: ReplicaByteStorage, key: Uint8Array,
  sourceDeviceId: string, path: string) => (await catalog(bytes, key)).sources[sourceDeviceId]?.[path] ?? null;

export const saveDirectorySnapshot = async (bytes: ReplicaByteStorage, args: {
  folderKey: Uint8Array;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
  sourceDeviceId: string;
  path: string;
  snapshot: StoredDirectorySnapshot;
}) => {
  const value = await catalog(bytes, args.folderKey);
  safeText(args.sourceDeviceId, "catalog source", 1024);
  safeText(args.path, "catalog path");
  if (args.path) assertReplicaPath(args.path);
  const current = value.sources[args.sourceDeviceId] ?? {};
  const directories = Object.fromEntries(Object.entries({ ...current, [args.path]: safeSnapshot(args.snapshot) })
    .sort(([, left], [, right]) => right.loadedAtMs - left.loadedAtMs).slice(0, 64));
  const sources = { ...value.sources };
  delete sources[args.sourceDeviceId];
  const retainedSources = Object.fromEntries(Object.entries({ ...sources, [args.sourceDeviceId]: directories }).slice(-32));
  await writeJson(bytes, args.folderKey, args.randomBytes, CATALOG_NAME, { format: 1, sources: retainedSources });
};

export const loadCacheAccess = async (bytes: ReplicaByteStorage, key: Uint8Array) => {
  const value = await readJson<Record<string, number>>(bytes, key, ACCESS_NAME, {});
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100_000 ||
    Object.entries(value).some(([path, time]) => !path || path.length > 4096 || !Number.isSafeInteger(time) || time < 0)) {
    throw new Error("Invalid cache access record.");
  }
  return value;
};

export const saveCacheAccess = (bytes: ReplicaByteStorage, key: Uint8Array,
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>, value: Record<string, number>) =>
  writeJson(bytes, key, randomBytes, ACCESS_NAME, value);
