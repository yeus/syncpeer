import type { ConnectOptions, RemoteFsLike, SyncpeerBrowserClient } from "@syncpeer/core/browser";
import {
  makeReadDirWithRetryFlow,
  makeWaitForFolderIndexToArriveFlow,
  makeWaitForFoldersToPopulateFlow,
  type FolderIndexPollAttempt,
  type ReadDirAttempt,
} from "@syncpeer/core/browser";
import type { FolderSyncState } from "@syncpeer/core/browser";

interface FlowLogEvent {
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  details?: Record<string, unknown>;
}

type FlowLogger = (entry: FlowLogEvent) => void;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export { FolderIndexPollAttempt, ReadDirAttempt };

export async function waitForFoldersToPopulateFlow(args: {
  client: SyncpeerBrowserClient;
  options: ConnectOptions;
  timeoutMs?: number;
  pollIntervalMs?: number;
  isConnected?: () => boolean;
  getCurrentFolderCount: () => number;
  applyOverview: (overview: {
    folders: any[];
    connectedVia: string;
    transportKind: "direct-tcp" | "relay";
  }) => void;
  logger?: FlowLogger;
}): Promise<{ populated: boolean; attempts: number; finalFolderCount: number }> {
  const flow = makeWaitForFoldersToPopulateFlow({
    sleep,
    log: args.logger,
  });
  return flow({
    timeoutMs: args.timeoutMs,
    pollIntervalMs: args.pollIntervalMs,
    isConnected: args.isConnected,
    getCurrentFolderCount: args.getCurrentFolderCount,
    pollOverview: async () => {
      const overview = await args.client.connectAndGetOverview(args.options);
      args.applyOverview(overview);
      return {
        folderCount: Array.isArray(overview.folders) ? overview.folders.length : 0,
        connectedVia: overview.connectedVia,
        transportKind: overview.transportKind,
      };
    },
  });
}

export async function waitForFolderIndexToArriveFlow(args: {
  client: SyncpeerBrowserClient;
  options: ConnectOptions;
  folderId: string;
  initialFolderSyncStates: FolderSyncState[];
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  isConnected?: () => boolean;
  onFolderSyncStates?: (states: FolderSyncState[]) => void;
  logger?: FlowLogger;
}): Promise<{ received: boolean; folderSyncStates: FolderSyncState[]; attempts: FolderIndexPollAttempt[] }> {
  const flow = makeWaitForFolderIndexToArriveFlow({
    sleep,
    log: args.logger,
  });
  return flow({
    folderId: args.folderId,
    connectOptions: args.options,
    initialFolderSyncStates: args.initialFolderSyncStates,
    fetchFolderVersions: args.client.connectAndGetFolderVersions,
    onFolderSyncStates: args.onFolderSyncStates,
    timeoutMs: args.timeoutMs,
    requestTimeoutMs: args.requestTimeoutMs,
    pollIntervalMs: args.pollIntervalMs,
    isConnected: args.isConnected,
  });
}

export async function readDirWithFrontendRetryFlow(args: {
  fs: RemoteFsLike;
  folderId: string;
  path: string;
  encrypted: boolean;
  locked: boolean;
  retryTimeoutMs?: number;
  retryIntervalMs?: number;
  logger?: FlowLogger;
}): Promise<{ entries: any[]; attempts: ReadDirAttempt[] }> {
  const flow = makeReadDirWithRetryFlow({
    sleep,
    log: args.logger,
  });
  return flow(args);
}

