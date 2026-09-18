import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import type { ReplicaByteStorage } from "./encryptedReplicaStorage.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

const STATE_NAME = ".syncpeer-favorite-sync";
const maxEntries = 10_000;
const maxRenames = 1_000;
const phases = new Set(["synced", "downloading", "uploading", "deleting-remote", "deleting-local", "conflict", "error"]);

export type FavoriteSyncPhase = "synced" | "downloading" | "uploading" | "deleting-remote" | "deleting-local" | "conflict" | "error";

export interface FavoriteSyncEntry {
  phase: FavoriteSyncPhase;
  message?: string;
  attempts: number;
  updatedAtMs: number;
  nextAttemptMs: number;
}

export interface FavoriteRename {
  from: string;
  to: string;
  atMs: number;
}

export interface FavoriteSyncState {
  entries: Record<string, FavoriteSyncEntry>;
  renames: FavoriteRename[];
}

export const emptyFavoriteSyncState = (): FavoriteSyncState => ({ entries: {}, renames: [] });

export const favoriteRetryDelayMs = (attempts: number): number =>
  Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, Math.min(attempts, 6) - 1));

const safePath = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid favorite sync state.");
  assertReplicaPath(value);
  if (isInternalReplicaPath(value)) throw new Error("Invalid favorite sync state.");
  return value;
};

const safeTime = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid favorite sync state.");
  return Number(value);
};

const validateEntry = (value: unknown): FavoriteSyncEntry => {
  const entry = value as Partial<FavoriteSyncEntry>;
  if (!entry || typeof entry !== "object" || typeof entry.phase !== "string" || !phases.has(entry.phase) ||
    !Number.isSafeInteger(entry.attempts) || Number(entry.attempts) < 0 || Number(entry.attempts) > 10_000 ||
    (entry.message !== undefined && (typeof entry.message !== "string" || entry.message.length > 512))) {
    throw new Error("Invalid favorite sync state.");
  }
  return { phase: entry.phase as FavoriteSyncPhase, attempts: Number(entry.attempts),
    updatedAtMs: safeTime(entry.updatedAtMs), nextAttemptMs: safeTime(entry.nextAttemptMs),
    ...(entry.message === undefined ? {} : { message: entry.message }) };
};

const validateRename = (value: unknown): FavoriteRename => {
  const rename = value as Partial<FavoriteRename>;
  if (!rename || typeof rename !== "object") throw new Error("Invalid favorite rename record.");
  return { from: safePath(rename.from), to: safePath(rename.to), atMs: safeTime(rename.atMs) };
};

const validateEntries = (value: unknown): Record<string, FavoriteSyncEntry> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > maxEntries) {
    throw new Error("Invalid favorite sync state.");
  }
  return Object.fromEntries(Object.entries(value).map(([path, entry]) => [safePath(path), validateEntry(entry)]));
};

const validateRenames = (value: unknown): FavoriteRename[] => {
  if (!Array.isArray(value) || value.length > maxRenames) throw new Error("Invalid favorite rename record.");
  return value.map(validateRename);
};

const readState = async (bytes: ReplicaByteStorage, folderKey: Uint8Array): Promise<FavoriteSyncState> => {
  const info = await bytes.stat(STATE_NAME);
  if (!info) return emptyFavoriteSyncState();
  if (info.type !== "file" || info.size > 16 * 1024 * 1024) throw new Error("Invalid favorite sync state.");
  const data = await readEncryptedRecord({ size: info.size, readRange: (offset, size) => bytes.readRange(STATE_NAME, offset, size) }, folderKey, STATE_NAME);
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as {
      format?: unknown; entries?: unknown; renames?: unknown;
    };
    if (!value || value.format !== 1) throw new Error("Invalid favorite sync state.");
    return { entries: validateEntries(value.entries ?? {}), renames: validateRenames(value.renames ?? []) };
  } finally { data.fill(0); }
};

const writeState = async (bytes: ReplicaByteStorage, options: {
  folderKey: Uint8Array; randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
}, state: FavoriteSyncState): Promise<void> => {
  const data = new TextEncoder().encode(JSON.stringify({ format: 1, ...state }));
  try {
    await writeEncryptedRecord({ name: STATE_NAME, bytes: data, folderKey: options.folderKey, randomBytes: options.randomBytes,
      createSink: (_info, size) => bytes.createSink(STATE_NAME, size) });
    await bytes.flushChanges([STATE_NAME]);
  } finally { data.fill(0); }
};

export const loadFavoriteSyncState = (bytes: ReplicaByteStorage, folderKey: Uint8Array): Promise<FavoriteSyncState> =>
  readState(bytes, folderKey);

/** Entries are service-owned; renames are document-owner-owned. Each writer keeps the other half. */
export async function saveFavoriteSyncEntries(bytes: ReplicaByteStorage, options: {
  folderKey: Uint8Array; randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
}, entries: Record<string, FavoriteSyncEntry>): Promise<void> {
  const current = await readState(bytes, options.folderKey);
  await writeState(bytes, options, { entries: validateEntries(entries), renames: current.renames });
}

export async function recordFavoriteRename(bytes: ReplicaByteStorage, options: {
  folderKey: Uint8Array; randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
}, rename: FavoriteRename): Promise<void> {
  const current = await readState(bytes, options.folderKey);
  const next = validateRename(rename);
  const renames = [...current.renames.filter(entry => entry.from !== next.from && entry.to !== next.to),
    next].slice(-maxRenames);
  await writeState(bytes, options, { entries: current.entries, renames });
}

export async function clearFavoriteRenames(bytes: ReplicaByteStorage, options: {
  folderKey: Uint8Array; randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
}, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const removed = new Set(paths.map(safePath));
  const current = await readState(bytes, options.folderKey);
  const renames = current.renames.filter(entry => !removed.has(entry.from) && !removed.has(entry.to));
  await writeState(bytes, options, { entries: current.entries, renames });
}
