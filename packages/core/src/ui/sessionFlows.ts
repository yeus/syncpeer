import type { ConnectOptions, RemoteFsLike } from "./browserClient.js";
import type { FileEntry, FolderSyncState } from "../core/model/remoteFs.js";

export interface FlowDeps {
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (entry: {
    level: "info" | "warning" | "error";
    event: string;
    message: string;
    details?: Record<string, unknown>;
  }) => void;
}

export interface FolderIndexPollAttempt {
  attempt: number;
  timedOut: boolean;
  folderSyncStateCount: number;
  indexReceived: boolean;
  remoteIndexId: string | null;
  remoteMaxSequence: string | null;
}

export interface ReadDirAttempt {
  attempt: number;
  atIso: string;
  entryCount: number;
}

export const makeWaitForFoldersToPopulateFlow =
  (deps: FlowDeps) =>
  async (args: {
    getCurrentFolderCount: () => number;
    pollOverview: () => Promise<{
      folderCount: number;
      connectedVia: string;
      transportKind: "direct-tcp" | "direct-quic" | "relay";
    }>;
    timeoutMs?: number;
    pollIntervalMs?: number;
    isConnected?: () => boolean;
  }): Promise<{ populated: boolean; attempts: number; finalFolderCount: number }> => {
    const timeoutMs = Math.max(100, args.timeoutMs ?? 4000);
    const pollIntervalMs = Math.max(50, args.pollIntervalMs ?? 200);
    const connected = args.isConnected ?? (() => true);
    const now = deps.now ?? (() => Date.now());
    const deadline = now() + timeoutMs;
    let attempts = 0;
    while (now() < deadline && connected()) {
      const count = args.getCurrentFolderCount();
      if (count > 0) return { populated: true, attempts, finalFolderCount: count };
      attempts += 1;
      const overview = await args.pollOverview();
      deps.log?.({
        level: "info",
        event: "session.flow.overview.poll",
        message: "Polled overview while waiting for folders to populate.",
        details: {
          attempt: attempts,
          folderCount: overview.folderCount,
          connectedVia: overview.connectedVia,
          transportKind: overview.transportKind,
        },
      });
      if (overview.folderCount > 0) {
        return { populated: true, attempts, finalFolderCount: overview.folderCount };
      }
      await deps.sleep(pollIntervalMs);
    }
    const finalFolderCount = args.getCurrentFolderCount();
    return {
      populated: finalFolderCount > 0,
      attempts,
      finalFolderCount,
    };
  };

export const makeWaitForFolderIndexToArriveFlow =
  (deps: FlowDeps) =>
  async (args: {
    folderId: string;
    connectOptions: ConnectOptions;
    initialFolderSyncStates: FolderSyncState[];
    fetchFolderVersions: (connectOptions: ConnectOptions) => Promise<FolderSyncState[]>;
    onFolderSyncStates?: (states: FolderSyncState[]) => void;
    timeoutMs?: number;
    requestTimeoutMs?: number;
    pollIntervalMs?: number;
    isConnected?: () => boolean;
  }): Promise<{ received: boolean; folderSyncStates: FolderSyncState[]; attempts: FolderIndexPollAttempt[] }> => {
    const timeoutMs = Math.max(100, args.timeoutMs ?? 3500);
    const requestTimeoutMs = Math.max(100, args.requestTimeoutMs ?? 1200);
    const pollIntervalMs = Math.max(50, args.pollIntervalMs ?? 150);
    const connected = args.isConnected ?? (() => true);
    const now = deps.now ?? (() => Date.now());
    const startedAtMs = now();
    const deadline = startedAtMs + timeoutMs;
    let folderSyncStates = [...(args.initialFolderSyncStates ?? [])];
    const attempts: FolderIndexPollAttempt[] = [];
    const getState = (): FolderSyncState | undefined =>
      folderSyncStates.find((entry) => entry.folderId === args.folderId);
    let attempt = 0;
    while (now() < deadline && connected()) {
      const existing = getState();
      if (existing?.indexReceived) return { received: true, folderSyncStates, attempts };
      attempt += 1;
      const startedPollAtMs = now();
      // Never issue a second native metadata query while the prior one is pending.
      // The old race timed out its *caller* but leaked the in-flight request,
      // stacking multiple service RPCs behind one blocked Android session.
      const pending = args.fetchFolderVersions(args.connectOptions).then(
        versions => ({ versions, error: null as unknown }),
        error => ({ versions: null, error }),
      );
      const firstWaitMs = Math.min(requestTimeoutMs, Math.max(1, deadline - now()));
      let response = await Promise.race([
        pending, deps.sleep(firstWaitMs).then(() => null),
      ]);
      if (response === null) {
        deps.log?.({
          level: "warning", event: "session.flow.folder_index.request_slow",
          message: "Remote folder metadata request is slow; waiting without starting another request.",
          details: { attempt, elapsedMs: now() - startedPollAtMs, requestTimeoutMs },
        });
        response = await Promise.race([
          pending, deps.sleep(Math.max(1, deadline - now())).then(() => null),
        ]);
      }
      if (response === null) {
        attempts.push({ attempt, timedOut: true,
          folderSyncStateCount: folderSyncStates.length,
          indexReceived: Boolean(existing?.indexReceived),
          remoteIndexId: existing?.remoteIndexId ?? null,
          remoteMaxSequence: existing?.remoteMaxSequence ?? null });
        break;
      }
      if (response.error != null) throw response.error;
      const versions = response.versions!;
      folderSyncStates = versions;
      args.onFolderSyncStates?.(versions);
      const next = getState();
      attempts.push({ attempt, timedOut: false,
        folderSyncStateCount: versions.length,
        indexReceived: Boolean(next?.indexReceived),
        remoteIndexId: next?.remoteIndexId ?? null,
        remoteMaxSequence: next?.remoteMaxSequence ?? null });
      if (next?.indexReceived) {
        deps.log?.({ level: "info", event: "session.flow.folder_index.ready",
          message: "Remote folder index became available.",
          details: { attempt, elapsedMs: now() - startedAtMs, stateCount: versions.length } });
        return { received: true, folderSyncStates, attempts };
      }
      await deps.sleep(pollIntervalMs);
    }
    deps.log?.({ level: "warning", event: "session.flow.folder_index.unavailable",
      message: "Remote folder index remains unavailable; no concurrent metadata polls were issued.",
      details: { attempt, elapsedMs: now() - startedAtMs, connected: connected(),
        timedOut: attempts.some(value => value.timedOut), stateCount: folderSyncStates.length } });
    const finalState = getState();
    return { received: Boolean(finalState?.indexReceived), folderSyncStates, attempts };
  };

export const makeReadDirWithRetryFlow =
  (deps: FlowDeps) =>
  async (args: {
    fs: RemoteFsLike;
    folderId: string;
    path: string;
    encrypted: boolean;
    locked: boolean;
    retryEmpty?: boolean;
    retryTimeoutMs?: number;
    retryIntervalMs?: number;
  }): Promise<{ entries: FileEntry[]; attempts: ReadDirAttempt[] }> => {
    const retryTimeoutMs = Math.max(100, args.retryTimeoutMs ?? 4000);
    const retryIntervalMs = Math.max(50, args.retryIntervalMs ?? 200);
    const now = deps.now ?? (() => Date.now());
    const attempts: ReadDirAttempt[] = [];
    let entries = await args.fs.readDir(args.folderId, args.path);
    attempts.push({
      attempt: 1,
      atIso: new Date().toISOString(),
      entryCount: entries.length,
    });
    if (entries.length > 0 || !args.retryEmpty || args.locked) {
      return { entries, attempts };
    }
    const deadline = now() + retryTimeoutMs;
    let attempt = 1;
    while (now() < deadline && entries.length === 0) {
      await deps.sleep(retryIntervalMs);
      attempt += 1;
      entries = await args.fs.readDir(args.folderId, args.path);
      attempts.push({
        attempt,
        atIso: new Date().toISOString(),
        entryCount: entries.length,
      });
    }
    return { entries, attempts };
  };
