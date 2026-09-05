import type { FileEntry, FileUploadOptions, FileDeleteOptions } from "../core/model/remoteFs.js";
import type { BepVersionVector } from "../core/protocol/bep.js";

export type FolderVersioningMode = "disabled" | "trash" | "simple" | "staggered";
export type ExternalDeletionPolicy = "ignore" | "propagate";

export interface FolderSyncPolicy {
  externalDeletion: ExternalDeletionPolicy;
  versioning: FolderVersioningMode;
  maxVersions?: number;
}

export const defaultFolderSyncPolicy = (): FolderSyncPolicy => ({
  externalDeletion: "ignore",
  versioning: "staggered",
});

export interface LocalSyncFile {
  path: string;
  size: number;
  modifiedMs: number;
  fingerprint: string;
  matchesRemote?: boolean;
}

export interface FolderSyncBaselineFile {
  exists: boolean;
  size: number;
  modifiedMs: number;
  fingerprint: string;
  version?: BepVersionVector;
  localFingerprint?: string;
  pending?: "upload" | "delete-remote";
}

export interface FolderSyncBaseline {
  format: 1;
  files: Record<string, FolderSyncBaselineFile>;
}

export interface FolderSyncStorage {
  listFiles: (remote?: readonly FileEntry[]) => Promise<LocalSyncFile[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, bytes: Uint8Array, modifiedMs?: number) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  archiveFile: (path: string, reason: "replace" | "delete" | "conflict", policy: FolderSyncPolicy, nowMs: number) => Promise<string | null>;
  loadState?: () => Promise<FolderSyncBaseline | null>;
  saveState?: (state: FolderSyncBaseline) => Promise<void>;
  withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
  setSubscribed?: (subscribed: boolean) => Promise<void>;
  isSubscribed?: () => Promise<boolean>;
}

export interface FolderSyncRemote {
  listFiles: (folderId: string) => Promise<FileEntry[]>;
  readFileFully: (folderId: string, path: string, signal?: AbortSignal) => Promise<Uint8Array>;
  writeFileFully: (folderId: string, path: string, bytes: Uint8Array, options?: FileUploadOptions) => Promise<void>;
  deleteFile?: (folderId: string, path: string, options?: FileDeleteOptions) => Promise<void>;
}

export type FolderSyncAction =
  | { kind: "upload"; path: string; reason: "local-new" | "local-changed" | "remote-deleted" }
  | { kind: "download"; path: string; reason: "remote-new" | "remote-changed" | "local-deleted" }
  | { kind: "delete-remote"; path: string; reason: "local-deleted" }
  | { kind: "delete-local"; path: string; reason: "remote-deleted" }
  | { kind: "conflict"; path: string; conflictPath: string };

export interface FolderSyncPlan {
  actions: FolderSyncAction[];
  baseline: FolderSyncBaseline;
}

export interface FolderSyncEvent {
  action: FolderSyncAction;
  status: "started" | "completed" | "failed";
  message?: string;
}

export interface FolderSyncResult {
  actions: FolderSyncAction[];
  completed: number;
  conflicts: string[];
  baseline: FolderSyncBaseline;
}

export interface FolderDeleteResult {
  path: string;
  archivedPath: string | null;
}

export interface FolderUnsubscribeResult {
  removed: string[];
  archived: string[];
}

const normalizePath = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");

const remoteFingerprint = (entry: FileEntry): string =>
  entry.fingerprint ?? `${entry.size}:${entry.modifiedMs}:${entry.sequence ?? 0}`;

const sameFile = (
  left: Pick<FolderSyncBaselineFile, "exists" | "size" | "modifiedMs" | "fingerprint"> | undefined,
  right: Pick<FolderSyncBaselineFile, "exists" | "size" | "modifiedMs" | "fingerprint"> | undefined,
): boolean => {
  if (!left || !right) return !left && !right;
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return left.size === right.size && left.fingerprint === right.fingerprint;
};

const localRecord = (file: LocalSyncFile): FolderSyncBaselineFile => ({
  exists: true,
  size: file.size,
  modifiedMs: file.modifiedMs,
  fingerprint: file.fingerprint,
});

const remoteRecord = (file: FileEntry): FolderSyncBaselineFile => ({
  exists: !file.deleted,
  size: file.size,
  modifiedMs: file.modifiedMs,
  fingerprint: remoteFingerprint(file),
  version: file.version,
});

const missingRecord = (): FolderSyncBaselineFile => ({
  exists: false,
  size: 0,
  modifiedMs: 0,
  fingerprint: "missing",
});

const conflictPathFor = (path: string, source: string, nowMs: number): string => {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  const directory = slash < 0 ? "" : normalized.slice(0, slash + 1);
  const name = slash < 0 ? normalized : normalized.slice(slash + 1);
  const stamp = new Date(nowMs).toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14);
  return `${directory}${name}.syncpeer-conflict-${source}-${stamp}`;
};

export const compareVersionVectors = (
  left?: BepVersionVector,
  right?: BepVersionVector,
): "equal" | "before" | "after" | "concurrent" | "unknown" => {
  if (!left?.counters || !right?.counters) return "unknown";
  let a: Map<string, bigint>;
  let b: Map<string, bigint>;
  try {
    a = new Map(left.counters.map((counter) => [String(counter.id), BigInt(String(counter.value))]));
    b = new Map(right.counters.map((counter) => [String(counter.id), BigInt(String(counter.value))]));
  } catch {
    return "unknown";
  }
  const ids = new Set([...a.keys(), ...b.keys()]);
  let leftGreater = false;
  let rightGreater = false;
  for (const id of ids) {
    const av = a.get(id) ?? 0n;
    const bv = b.get(id) ?? 0n;
    leftGreater ||= av > bv;
    rightGreater ||= bv > av;
  }
  if (!leftGreater && !rightGreater) return "equal";
  if (leftGreater && !rightGreater) return "after";
  if (rightGreater && !leftGreater) return "before";
  return "concurrent";
};

export const planFolderSync = (args: {
  local: readonly LocalSyncFile[];
  remote: readonly FileEntry[];
  baseline?: FolderSyncBaseline | null;
  policy?: FolderSyncPolicy;
  nowMs?: number;
}): FolderSyncPlan => {
  const policy = args.policy ?? defaultFolderSyncPolicy();
  const nowMs = args.nowMs ?? Date.now();
  const localByPath = new Map(args.local.map((file) => [normalizePath(file.path), file]));
  const remoteByPath = new Map(args.remote.map((file) => [normalizePath(file.path), file]));
  const previous = args.baseline?.files ?? {};
  const paths = new Set([...Object.keys(previous), ...localByPath.keys(), ...remoteByPath.keys()]);
  const actions: FolderSyncAction[] = [];
  const baseline: FolderSyncBaseline = { format: 1, files: {} };

  for (const path of [...paths].filter(Boolean).sort()) {
    const local = localByPath.get(path);
    const remote = remoteByPath.get(path);
    const localState = local ? localRecord(local) : missingRecord();
    const remoteState = remote ? remoteRecord(remote) : missingRecord();
    const previousState = Object.hasOwn(previous, path) ? previous[path] : undefined;
    const localPrevious = previousState ? { ...previousState, fingerprint: previousState.localFingerprint ?? previousState.fingerprint } : undefined;
    const localChanged = localPrevious ? !sameFile(localState, localPrevious) : localState.exists;
    const remoteChanged = previousState ? !sameFile(remoteState, previousState) : remoteState.exists;
    const equalContents = local?.matchesRemote === true || sameFile(localState, remoteState);
    if (previousState && compareVersionVectors(remote?.version, previousState.version) === "before") {
      baseline.files[path] = previousState;
      continue;
    }
    if (previousState?.pending && !(previousState.pending === "upload" ? equalContents : remote?.deleted)) {
      throw new Error(`Publication outcome is unconfirmed for ${path}; refusing to replay it.`);
    }

    if (!previousState) {
      if (localState.exists && remoteState.exists && !equalContents) {
        actions.push({ kind: "conflict", path, conflictPath: conflictPathFor(path, "remote", nowMs) });
      } else if (localState.exists && !remoteState.exists) {
        actions.push({ kind: "upload", path, reason: "local-new" });
      } else if (!localState.exists && remoteState.exists) {
        actions.push({ kind: "download", path, reason: "remote-new" });
      }
    } else if (localState.exists && remoteState.exists) {
      if (equalContents) {
        baseline.files[path] = { ...remoteState, localFingerprint: localState.fingerprint };
      } else if (localChanged && remoteChanged) {
        actions.push({ kind: "conflict", path, conflictPath: conflictPathFor(path, "remote", nowMs) });
      } else if (localChanged) {
        actions.push({ kind: "upload", path, reason: "local-changed" });
      } else if (remoteChanged) {
        actions.push({ kind: "download", path, reason: "remote-changed" });
      } else {
        baseline.files[path] = previousState;
      }
    } else if (localState.exists && !remoteState.exists) {
      if (policy.externalDeletion === "propagate" && !localChanged) {
        actions.push({ kind: "delete-local", path, reason: "remote-deleted" });
      } else {
        actions.push({ kind: "upload", path, reason: "remote-deleted" });
      }
    } else if (!localState.exists && remoteState.exists) {
      if (policy.externalDeletion === "propagate" && !remoteChanged) {
        actions.push({ kind: "delete-remote", path, reason: "local-deleted" });
      } else {
        actions.push({ kind: "download", path, reason: "local-deleted" });
      }
    }
    if (!actions.some((action) => action.path === path)) {
      baseline.files[path] ??= localState.exists && remoteState.exists
        ? { ...remoteState, localFingerprint: localState.fingerprint }
        : localState.exists ? localState : remoteState;
    }
  }
  return { actions, baseline };
};

const actionError = (action: FolderSyncAction, error: unknown): Error =>
  new Error(`Folder sync ${action.kind} failed for ${action.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });

export const synchronizeFolder = async (args: {
  folderId: string;
  remote: FolderSyncRemote;
  storage: FolderSyncStorage;
  baseline?: FolderSyncBaseline | null;
  policy?: FolderSyncPolicy;
  nowMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: FolderSyncEvent) => void;
}): Promise<FolderSyncResult> => {
  if (args.storage.withLock) {
    return args.storage.withLock(() => synchronizeFolder({ ...args, storage: { ...args.storage, withLock: undefined } }));
  }
  const checkSubscribed = async () => {
    args.signal?.throwIfAborted();
    if (args.storage.isSubscribed && !await args.storage.isSubscribed()) throw new Error("Folder is unsubscribed.");
  };
  await checkSubscribed();
  const policy = args.policy ?? defaultFolderSyncPolicy();
  const remote = await args.remote.listFiles(args.folderId);
  const local = await args.storage.listFiles(remote);
  const previous = args.baseline ?? await args.storage.loadState?.();
  const plan = planFolderSync({ local, remote, baseline: previous, policy, nowMs: args.nowMs });
  const localByPath = new Map(local.map((file) => [normalizePath(file.path), file]));
  const remoteByPath = new Map(remote.map((file) => [normalizePath(file.path), file]));
  const nextBaseline = { format: 1 as const, files: { ...previous?.files, ...plan.baseline.files } };
  const checkLocal = async (path: string) => {
    await checkSubscribed();
    const current = (await args.storage.listFiles()).find(file => file.path === path);
    const expected = localByPath.get(path);
    if (!sameFile(current ? localRecord(current) : missingRecord(), expected ? localRecord(expected) : missingRecord())) {
      throw new Error("Local file changed during synchronization; retry to resolve the conflict.");
    }
  };
  const conflicts: string[] = [];
  let completed = 0;
  for (const action of plan.actions) {
    await checkSubscribed();
    args.onEvent?.({ action, status: "started" });
    try {
      if (action.kind === "upload") {
        const source = localByPath.get(action.path);
        if (!source) throw new Error("local file disappeared");
        const bytes = await args.storage.readFile(action.path);
        await checkLocal(action.path);
        nextBaseline.files[action.path] = { ...localRecord(source), pending: "upload" };
        await args.storage.saveState?.(nextBaseline);
        await args.remote.writeFileFully(args.folderId, action.path, bytes, { modifiedMs: source.modifiedMs, signal: args.signal, waitForRemote: true });
        nextBaseline.files[action.path] = localRecord(source);
      } else if (action.kind === "download") {
        const source = remoteByPath.get(action.path);
        if (!source || source.deleted) throw new Error("remote file disappeared");
        const bytes = await args.remote.readFileFully(args.folderId, action.path, args.signal);
        await checkLocal(action.path);
        if (localByPath.has(action.path)) await args.storage.archiveFile(action.path, "replace", policy, args.nowMs ?? Date.now());
        await checkLocal(action.path);
        await args.storage.writeFile(action.path, bytes, source.modifiedMs);
        const written = (await args.storage.listFiles()).find(file => file.path === action.path);
        nextBaseline.files[action.path] = { ...remoteRecord(source), localFingerprint: written?.fingerprint };
      } else if (action.kind === "delete-remote") {
        if (!args.remote.deleteFile) throw new Error("remote deletion is unavailable");
        nextBaseline.files[action.path] = { ...remoteRecord(remoteByPath.get(action.path)!), pending: "delete-remote" };
        await args.storage.saveState?.(nextBaseline);
        await args.remote.deleteFile(args.folderId, action.path, { modifiedMs: args.nowMs ?? Date.now(), waitForRemote: true, signal: args.signal });
        nextBaseline.files[action.path] = missingRecord();
      } else if (action.kind === "delete-local") {
        await checkLocal(action.path);
        if (localByPath.has(action.path)) await args.storage.archiveFile(action.path, "delete", policy, args.nowMs ?? Date.now());
        await checkLocal(action.path);
        await args.storage.removeFile(action.path);
        nextBaseline.files[action.path] = missingRecord();
      } else {
        const source = localByPath.get(action.path);
        const remoteSource = remoteByPath.get(action.path);
        if (!source || !remoteSource || remoteSource.deleted) throw new Error("conflict source disappeared");
        const bytes = await args.remote.readFileFully(args.folderId, action.path, args.signal);
        await checkLocal(action.path);
        await args.storage.writeFile(action.conflictPath, await args.storage.readFile(action.path), source.modifiedMs);
        await args.storage.archiveFile(action.path, "conflict", policy, args.nowMs ?? Date.now());
        await checkLocal(action.path);
        await args.storage.writeFile(action.path, bytes, remoteSource.modifiedMs);
        const written = (await args.storage.listFiles()).find(file => file.path === action.path);
        nextBaseline.files[action.path] = { ...remoteRecord(remoteSource), localFingerprint: written?.fingerprint };
        conflicts.push(action.conflictPath);
      }
      completed += 1;
      await args.storage.saveState?.(nextBaseline);
      args.onEvent?.({ action, status: "completed" });
    } catch (error) {
      args.onEvent?.({ action, status: "failed", message: error instanceof Error ? error.message : String(error) });
      throw actionError(action, error);
    }
  }
  const result = { actions: plan.actions, completed, conflicts, baseline: nextBaseline };
  await args.storage.saveState?.(nextBaseline);
  return result;
};

export const deleteFolderFile = async (args: {
  folderId: string;
  path: string;
  remote: Pick<FolderSyncRemote, "deleteFile">;
  storage: FolderSyncStorage;
  policy?: FolderSyncPolicy;
  nowMs?: number;
  signal?: AbortSignal;
}): Promise<FolderDeleteResult> => {
  if (args.storage.withLock) {
    return args.storage.withLock(() => deleteFolderFile({ ...args, storage: { ...args.storage, withLock: undefined } }));
  }
  const path = normalizePath(args.path);
  if (!path) throw new Error("Folder file path must not be empty.");
  if (!args.remote.deleteFile) throw new Error("Remote deletion is unavailable.");
  args.signal?.throwIfAborted();
  const local = (await args.storage.listFiles()).find((file) => normalizePath(file.path) === path);
  const policy = args.policy ?? defaultFolderSyncPolicy();
  const archivedPath = local
    ? await args.storage.archiveFile(path, "delete", policy, args.nowMs ?? Date.now())
    : null;
  args.signal?.throwIfAborted();
  await args.remote.deleteFile(args.folderId, path, { modifiedMs: args.nowMs ?? Date.now(), waitForRemote: true, signal: args.signal });
  if (local) {
    const current = (await args.storage.listFiles()).find(file => normalizePath(file.path) === path);
    if (current && (current.fingerprint !== local.fingerprint || current.size !== local.size)) {
      throw new Error("Local file changed during remote deletion; preserving the local edit.");
    }
    await args.storage.removeFile(path);
  }
  const baseline = (await args.storage.loadState?.()) ?? { format: 1 as const, files: {} };
  baseline.files[path] = missingRecord();
  await args.storage.saveState?.(baseline);
  return { path, archivedPath };
};

export const unsubscribeFolder = async (args: {
  storage: FolderSyncStorage;
  policy?: FolderSyncPolicy;
  nowMs?: number;
  signal?: AbortSignal;
}): Promise<FolderUnsubscribeResult> => {
  await args.storage.setSubscribed?.(false);
  if (args.storage.withLock) {
    return args.storage.withLock(() => unsubscribeFolder({ ...args, storage: { ...args.storage, withLock: undefined } }));
  }
  const policy = args.policy ?? defaultFolderSyncPolicy();
  const removed: string[] = [];
  const archived: string[] = [];
  for (const file of await args.storage.listFiles()) {
    args.signal?.throwIfAborted();
    const path = normalizePath(file.path);
    const archivedPath = await args.storage.archiveFile(path, "delete", policy, args.nowMs ?? Date.now());
    if (archivedPath) archived.push(archivedPath);
    await args.storage.removeFile(path);
    removed.push(path);
  }
  await args.storage.saveState?.({ format: 1, files: {} });
  return { removed, archived };
};
