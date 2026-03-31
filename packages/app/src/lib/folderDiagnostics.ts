import type {
  ConnectOptions,
  FolderSyncState,
  SessionTraceEvent,
  SyncpeerBrowserClient,
} from "@syncpeer/core/browser";
import { createSyncpeerSessionStore as createSessionStore } from "@syncpeer/core/browser";

interface FolderDiagnosticsLogEvent {
  atIso: string;
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface FolderDiagnosticsFolderResult {
  folderId: string;
  label: string;
  encrypted: boolean;
  needsPassword: boolean;
  localDevicePresentInFolder: boolean;
  stopReason: number;
  indexReceived: boolean;
  remoteIndexId: string | null;
  remoteMaxSequence: string | null;
  readDirCount: number | null;
  readDirSample: string[];
  indexPollAttempts: Array<Record<string, unknown>>;
  readDirAttempts: Array<Record<string, unknown>>;
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
  timeline: FolderDiagnosticsLogEvent[];
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
  const pollIntervalMs = Math.max(50, args.pollIntervalMs ?? 250);
  const maxPollAttempts = Math.max(1, args.maxPollAttempts ?? 16);
  const timeline: FolderDiagnosticsLogEvent[] = [];
  const log = (
    level: "info" | "warning" | "error",
    event: string,
    message: string,
    details?: Record<string, unknown>,
  ) => {
    timeline.push({
      atIso: new Date().toISOString(),
      level,
      event,
      message,
      details,
    });
  };

  const timelineToLog = (entry: SessionTraceEvent): void => {
    log(
      entry.level,
      entry.event,
      entry.message,
      entry.details,
    );
  };
  const session = createSessionStore({
    transport: args.client,
    onTrace: timelineToLog,
  });

  log("info", "diag.connect.start", "Opening session via sessionStore.connect.", {
    discoveryMode: args.options.discoveryMode,
    host: args.options.host,
    port: args.options.port,
    remoteId: args.options.remoteId,
  });
  await session.actions.disconnect();
  await session.actions.connect(args.options);
  const connectedState = session.getState();
  log("info", "diag.connect.ready", "sessionStore.connect returned with state.", {
    folderCount: connectedState.folders.length,
    connectedVia: connectedState.connectionPath,
    transportKind: connectedState.connectionTransport || "direct-tcp",
  });

  const polling: FolderDiagnosticsReport["polling"] = [];
  let latestSyncStates = connectedState.folderSyncStates;
  let foldersToCheck = connectedState.folders;

  for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
    await session.actions.refreshOverview(args.options);
    const nextState = session.getState();
    latestSyncStates = nextState.folderSyncStates;
    foldersToCheck = nextState.folders;
    polling.push({
      attempt,
      atIso: new Date().toISOString(),
      folderSyncStates: latestSyncStates,
    });
    log("info", "diag.folder_versions.poll", "Polled folder sync states.", {
      attempt,
      count: latestSyncStates.length,
      pendingFolderIds: latestSyncStates
        .filter((state) => !state.indexReceived)
        .map((state) => state.folderId),
    });
    if (latestSyncStates.every((state) => state.indexReceived)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const folderResults: FolderDiagnosticsFolderResult[] = [];
  for (const folder of foldersToCheck) {
    log("info", "diag.folder.start", "Processing folder diagnostics.", {
      folderId: folder.id,
      label: folder.label || folder.id,
      encrypted: Boolean(folder.encrypted),
      needsPassword: Boolean(folder.needsPassword),
      localDevicePresentInFolder: folder.localDevicePresentInFolder !== false,
      stopReason: Number(folder.stopReason ?? 0),
    });
    await session.actions.openFolder(folder.id, args.options);
    const folderState = session.getState();
    latestSyncStates = folderState.folderSyncStates;
    const syncState = latestSyncStates.find(
      (state) => state.folderId === folder.id,
    );
    const result: FolderDiagnosticsFolderResult = {
      folderId: folder.id,
      label: folder.label || folder.id,
      encrypted: !!folder.encrypted,
      needsPassword: !!folder.needsPassword,
      localDevicePresentInFolder: folder.localDevicePresentInFolder !== false,
      stopReason: Number(folder.stopReason ?? 0),
      indexReceived: !!syncState?.indexReceived,
      remoteIndexId: syncState?.remoteIndexId ?? null,
      remoteMaxSequence: syncState?.remoteMaxSequence ?? null,
      readDirCount: null,
      readDirSample: [],
      indexPollAttempts: [],
      readDirAttempts: [],
    };
    if (folder.needsPassword) {
      result.readDirError = "Folder is locked (missing or invalid password).";
      folderResults.push(result);
      continue;
    }
    if (!result.localDevicePresentInFolder) {
      result.readDirError =
        "Remote has not approved this local device for the folder yet (local device not listed in folder devices).";
      folderResults.push(result);
      continue;
    }
    if (result.stopReason !== 0) {
      result.readDirError = `Remote folder is stopped (stopReason=${result.stopReason}).`;
      folderResults.push(result);
      continue;
    }
    try {
      const nextEntries = folderState.entries;
      result.readDirAttempts = [
        {
          attempt: 1,
          atIso: new Date().toISOString(),
          entryCount: nextEntries.length,
        },
      ];
      result.readDirCount = nextEntries.length;
      result.readDirSample = nextEntries
        .slice(0, 20)
        .map((entry) => entry.path);
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
      connectedVia: session.getState().connectionPath,
      transportKind: session.getState().connectionTransport || "direct-tcp",
      folderCount: foldersToCheck.length,
      folderIds: foldersToCheck.map((folder) => folder.id),
      folderSyncStates: latestSyncStates,
    },
    polling,
    timeline,
    folders: folderResults,
  };
}
