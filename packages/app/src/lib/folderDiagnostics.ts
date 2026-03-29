import type {
  ConnectOptions,
  FolderInfo,
  FolderSyncState,
  SyncpeerBrowserClient,
} from "@syncpeer/core/browser";

export interface FolderDiagnosticsFolderResult {
  folderId: string;
  label: string;
  encrypted: boolean;
  needsPassword: boolean;
  indexReceived: boolean;
  remoteIndexId: string | null;
  remoteMaxSequence: string | null;
  readDirCount: number | null;
  readDirSample: string[];
  readDirError?: string;
}

export interface FolderDiagnosticsReport {
  startedAtIso: string;
  finishedAtIso: string;
  durationMs: number;
  connection: {
    discoveryMode?: "global" | "direct";
    remoteId?: string;
    host: string;
    port: number;
  };
  overview: {
    connectedVia: string;
    transportKind: "direct-tcp" | "relay";
    folderCount: number;
    folderIds: string[];
    folderSyncStates: FolderSyncState[];
  };
  polling: Array<{
    attempt: number;
    atIso: string;
    folderSyncStates: FolderSyncState[];
  }>;
  folders: FolderDiagnosticsFolderResult[];
}

export async function runFolderContentDiagnostics(args: {
  client: SyncpeerBrowserClient;
  options: ConnectOptions;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
}): Promise<FolderDiagnosticsReport> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const maxPollAttempts = Math.max(1, args.maxPollAttempts ?? 12);
  const pollIntervalMs = Math.max(50, args.pollIntervalMs ?? 250);

  const fs = await args.client.connectAndSync(args.options);
  const overview = await args.client.connectAndGetOverview(args.options);
  const polling: FolderDiagnosticsReport["polling"] = [];
  let latestSyncStates = overview.folderSyncStates ?? [];

  for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
    latestSyncStates = await args.client.connectAndGetFolderVersions(args.options);
    polling.push({
      attempt,
      atIso: new Date().toISOString(),
      folderSyncStates: latestSyncStates,
    });
    if (latestSyncStates.every((state) => state.indexReceived)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const foldersToCheck: FolderInfo[] = overview.folders ?? [];
  const folderResults: FolderDiagnosticsFolderResult[] = [];
  for (const folder of foldersToCheck) {
    const syncState = latestSyncStates.find((state) => state.folderId === folder.id);
    const result: FolderDiagnosticsFolderResult = {
      folderId: folder.id,
      label: folder.label || folder.id,
      encrypted: !!folder.encrypted,
      needsPassword: !!folder.needsPassword,
      indexReceived: !!syncState?.indexReceived,
      remoteIndexId: syncState?.remoteIndexId ?? null,
      remoteMaxSequence: syncState?.remoteMaxSequence ?? null,
      readDirCount: null,
      readDirSample: [],
    };
    if (folder.needsPassword) {
      result.readDirError = "Folder is locked (missing or invalid password).";
      folderResults.push(result);
      continue;
    }
    try {
      const entries = await fs.readDir(folder.id, "");
      result.readDirCount = entries.length;
      result.readDirSample = entries.slice(0, 20).map((entry) => entry.path);
    } catch (error) {
      result.readDirError =
        error instanceof Error ? error.message : String(error);
    }
    folderResults.push(result);
  }

  const finishedAtMs = Date.now();
  return {
    startedAtIso,
    finishedAtIso: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    connection: {
      discoveryMode: args.options.discoveryMode,
      remoteId: args.options.remoteId,
      host: args.options.host,
      port: args.options.port,
    },
    overview: {
      connectedVia: overview.connectedVia,
      transportKind: overview.transportKind,
      folderCount: foldersToCheck.length,
      folderIds: foldersToCheck.map((folder) => folder.id),
      folderSyncStates: latestSyncStates,
    },
    polling,
    folders: folderResults,
  };
}
