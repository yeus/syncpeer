import type { ConnectOptions, RemoteFsLike } from "./browserClient.ts";
import type { FileEntry, FolderSyncState } from "../core/model/remoteFs.ts";

export interface FlowDeps {
  sleep: (ms: number) => Promise<void>;
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
      transportKind: "direct-tcp" | "relay";
    }>;
    timeoutMs?: number;
    pollIntervalMs?: number;
    isConnected?: () => boolean;
  }): Promise<{ populated: boolean; attempts: number; finalFolderCount: number }> => {
    const timeoutMs = Math.max(100, args.timeoutMs ?? 4000);
    const pollIntervalMs = Math.max(50, args.pollIntervalMs ?? 200);
    const connected = args.isConnected ?? (() => true);
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline && connected()) {
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
    const deadline = Date.now() + timeoutMs;
    let folderSyncStates = [...(args.initialFolderSyncStates ?? [])];
    const attempts: FolderIndexPollAttempt[] = [];
    const getState = (): FolderSyncState | undefined =>
      folderSyncStates.find((entry) => entry.folderId === args.folderId);
    let attempt = 0;
    while (Date.now() < deadline && connected()) {
      const existing = getState();
      if (existing?.indexReceived) {
        return { received: true, folderSyncStates, attempts };
      }
      attempt += 1;
      const versions = await Promise.race<FolderSyncState[] | null>([
        args.fetchFolderVersions(args.connectOptions),
        deps.sleep(requestTimeoutMs).then(() => null),
      ]);
      if (!versions) {
        attempts.push({
          attempt,
          timedOut: true,
          folderSyncStateCount: folderSyncStates.length,
          indexReceived: Boolean(existing?.indexReceived),
          remoteIndexId: existing?.remoteIndexId ?? null,
          remoteMaxSequence: existing?.remoteMaxSequence ?? null,
        });
        deps.log?.({
          level: "warning",
          event: "session.flow.folder_index.timeout",
          message: `Timed out fetching folder sync states for ${args.folderId}.`,
          details: { folderId: args.folderId, attempt, requestTimeoutMs },
        });
        await deps.sleep(pollIntervalMs);
        continue;
      }
      folderSyncStates = versions;
      args.onFolderSyncStates?.(versions);
      const next = getState();
      attempts.push({
        attempt,
        timedOut: false,
        folderSyncStateCount: versions.length,
        indexReceived: Boolean(next?.indexReceived),
        remoteIndexId: next?.remoteIndexId ?? null,
        remoteMaxSequence: next?.remoteMaxSequence ?? null,
      });
      if (next?.indexReceived) {
        return { received: true, folderSyncStates, attempts };
      }
      await deps.sleep(pollIntervalMs);
    }
    const finalState = getState();
    return {
      received: Boolean(finalState?.indexReceived),
      folderSyncStates,
      attempts,
    };
  };

export const makeReadDirWithRetryFlow =
  (deps: FlowDeps) =>
  async (args: {
    fs: RemoteFsLike;
    folderId: string;
    path: string;
    encrypted: boolean;
    locked: boolean;
    retryTimeoutMs?: number;
    retryIntervalMs?: number;
  }): Promise<{ entries: FileEntry[]; attempts: ReadDirAttempt[] }> => {
    const retryTimeoutMs = Math.max(100, args.retryTimeoutMs ?? 4000);
    const retryIntervalMs = Math.max(50, args.retryIntervalMs ?? 200);
    const attempts: ReadDirAttempt[] = [];
    let entries = await args.fs.readDir(args.folderId, args.path);
    attempts.push({
      attempt: 1,
      atIso: new Date().toISOString(),
      entryCount: entries.length,
    });
    if (entries.length > 0 || !args.encrypted || args.locked) {
      return { entries, attempts };
    }
    const deadline = Date.now() + retryTimeoutMs;
    let attempt = 1;
    while (Date.now() < deadline && entries.length === 0) {
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

