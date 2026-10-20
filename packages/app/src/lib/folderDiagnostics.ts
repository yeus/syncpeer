import type {
  ConnectOptions,
  ConnectionScope,
  FolderSyncState,
  SyncpeerBrowserClient,
} from "@syncpeer/core/browser";
import {
  createSyncpeerSessionStore as createSessionStore,
  normalizeDeviceId,
} from "@syncpeer/core/browser";

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
    discoveryMode?: "automatic" | "global" | "lan" | "direct";
    remoteId?: string;
    host: string;
    port: number;
  };
  overview: {
    connectedVia: string;
    transportKind: "direct-tcp" | "direct-quic" | "relay";
    connectionScope?: ConnectionScope;
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
  advertisedDevices: {
    byFolder: Array<{
      folderId: string;
      label: string;
      encrypted: boolean;
      localDevicePresentInFolder: boolean;
      deviceIds: string[];
      devices: Array<{ id: string; name: string }>;
    }>;
    uniqueDeviceIds: string[];
    knownDeviceIds: string[];
    missingKnownDeviceIds: string[];
    expectedDeviceIds: string[];
    missingExpectedDeviceIds: string[];
  };
}

type DiagnosticsLogger = (
  level: "info" | "warning" | "error",
  event: string,
  message: string,
  details?: Record<string, unknown>,
) => void;

type DiagnosticsSession = ReturnType<typeof createSessionStore>;
type DiagnosticFolder = ReturnType<DiagnosticsSession["getState"]>["folders"][number];
type DiagnosticSyncState = FolderSyncState;

function createDiagnosticsTimeline(): {
  timeline: FolderDiagnosticsLogEvent[];
  log: DiagnosticsLogger;
} {
  const timeline: FolderDiagnosticsLogEvent[] = [];
  const log: DiagnosticsLogger = (level, event, message, details) => {
    timeline.push({ atIso: new Date().toISOString(), level, event, message, details });
  };
  return { timeline, log };
}

async function openDiagnosticsSession(
  client: SyncpeerBrowserClient,
  options: ConnectOptions,
  log: DiagnosticsLogger,
): Promise<DiagnosticsSession> {
  const session = createSessionStore({
    transport: client,
    onTrace: (entry) => log(entry.level, entry.event, entry.message, entry.details),
  });
  log("info", "diag.connect.start", "Opening session via sessionStore.connect.", {
    discoveryMode: options.discoveryMode,
    host: options.host,
    port: options.port,
    remoteId: options.remoteId,
  });
  await session.actions.disconnect();
  await session.actions.connect(options);
  const connectedState = session.getState();
  log("info", "diag.connect.ready", "sessionStore.connect returned with state.", {
    folderCount: connectedState.folders.length,
    connectedVia: connectedState.connectionPath,
    transportKind: connectedState.connectionTransport || "direct-tcp",
    connectionScope: connectedState.connectionScope || undefined,
  });
  return session;
}

async function pollFolderVersions(
  session: DiagnosticsSession,
  options: ConnectOptions,
  maxPollAttempts: number,
  pollIntervalMs: number,
  log: DiagnosticsLogger,
): Promise<{
  polling: FolderDiagnosticsReport["polling"];
  latestSyncStates: DiagnosticSyncState[];
  foldersToCheck: DiagnosticFolder[];
}> {
  const polling: FolderDiagnosticsReport["polling"] = [];
  let latestSyncStates = session.getState().folderSyncStates;
  let foldersToCheck = session.getState().folders;
  for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
    await session.actions.refreshOverview(options);
    const nextState = session.getState();
    latestSyncStates = nextState.folderSyncStates;
    foldersToCheck = nextState.folders;
    polling.push({ attempt, atIso: new Date().toISOString(), folderSyncStates: latestSyncStates });
    log("info", "diag.folder_versions.poll", "Polled folder sync states.", {
      attempt,
      count: latestSyncStates.length,
      pendingFolderIds: latestSyncStates
        .filter((state) => !state.indexReceived)
        .map((state) => state.folderId),
    });
    if (latestSyncStates.every((state) => state.indexReceived)) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { polling, latestSyncStates, foldersToCheck };
}

function createFolderResult(
  folder: DiagnosticFolder,
  syncState: DiagnosticSyncState | undefined,
): FolderDiagnosticsFolderResult {
  return {
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
}

function readFolderEntries(
  result: FolderDiagnosticsFolderResult,
  state: ReturnType<DiagnosticsSession["getState"]>,
): void {
  try {
    const nextEntries = state.entries;
    result.readDirAttempts = [{
      attempt: 1,
      atIso: new Date().toISOString(),
      entryCount: nextEntries.length,
    }];
    result.readDirCount = nextEntries.length;
    result.readDirSample = nextEntries.slice(0, 20).map((entry) => entry.path);
  } catch (error) {
    result.readDirError = error instanceof Error ? error.message : String(error);
  }
}

async function diagnoseFolder(
  session: DiagnosticsSession,
  folder: DiagnosticFolder,
  options: ConnectOptions,
  log: DiagnosticsLogger,
): Promise<{ result: FolderDiagnosticsFolderResult; syncStates: DiagnosticSyncState[] }> {
  log("info", "diag.folder.start", "Processing folder diagnostics.", {
    folderId: folder.id,
    label: folder.label || folder.id,
    encrypted: Boolean(folder.encrypted),
    needsPassword: Boolean(folder.needsPassword),
    localDevicePresentInFolder: folder.localDevicePresentInFolder !== false,
    stopReason: Number(folder.stopReason ?? 0),
  });
  await session.actions.openFolder(folder.id, options);
  const folderState = session.getState();
  const syncState = folderState.folderSyncStates.find((state) => state.folderId === folder.id);
  const result = createFolderResult(folder, syncState);
  const syncStates = folderState.folderSyncStates;
  if (folder.needsPassword) {
    result.readDirError = "Folder is locked (missing or invalid password).";
    return { result, syncStates };
  }
  if (!result.localDevicePresentInFolder) {
    result.readDirError =
      "Remote has not approved this local device for the folder yet (local device not listed in folder devices).";
    return { result, syncStates };
  }
  if (result.stopReason !== 0) {
    result.readDirError = `Remote folder is stopped (stopReason=${result.stopReason}).`;
    return { result, syncStates };
  }
  readFolderEntries(result, folderState);
  return { result, syncStates };
}

function collectAdvertisedByFolder(folders: DiagnosticFolder[]): FolderDiagnosticsReport["advertisedDevices"]["byFolder"] {
  return folders.map((folder) => {
    const devices = Array.isArray(folder.advertisedDevices) ? folder.advertisedDevices : [];
    const normalizedDevices = devices.map((device) => {
      const id = normalizeDeviceId(String(device.id ?? ""));
      return id ? { id, name: String(device.name ?? "").trim() } : null;
    }).filter((entry): entry is { id: string; name: string } => entry !== null);
    return {
      folderId: folder.id,
      label: folder.label || folder.id,
      encrypted: Boolean(folder.encrypted),
      localDevicePresentInFolder: folder.localDevicePresentInFolder !== false,
      deviceIds: normalizedDevices.map((entry) => entry.id),
      devices: normalizedDevices,
    };
  });
}

function normalizedDeviceIds(deviceIds: string[] | undefined): string[] {
  return [...new Set((deviceIds ?? [])
    .map((deviceId) => normalizeDeviceId(String(deviceId ?? "")))
    .filter((deviceId) => deviceId !== ""))].sort();
}

function summarizeAdvertisedDevices(
  args: { knownDeviceIds?: string[]; expectedDeviceIds?: string[] },
  advertisedByFolder: FolderDiagnosticsReport["advertisedDevices"]["byFolder"],
) {
  const uniqueDeviceIds = [...new Set(advertisedByFolder.flatMap((folder) => folder.deviceIds))].sort();
  const knownDeviceIds = normalizedDeviceIds(args.knownDeviceIds);
  const expectedDeviceIds = normalizedDeviceIds(args.expectedDeviceIds);
  return {
    uniqueDeviceIds,
    knownDeviceIds,
    expectedDeviceIds,
    missingKnownDeviceIds: knownDeviceIds.filter((id) => !uniqueDeviceIds.includes(id)),
    missingExpectedDeviceIds: expectedDeviceIds.filter((id) => !uniqueDeviceIds.includes(id)),
  };
}

function logAdvertisedDevices(
  log: DiagnosticsLogger,
  summary: ReturnType<typeof summarizeAdvertisedDevices>,
): void {
  if (summary.missingKnownDeviceIds.length > 0) {
    log("warning", "diag.advertised_devices.known_missing",
      "Some known device IDs are not present in advertised devices.", {
        missingKnownDeviceIds: summary.missingKnownDeviceIds,
        knownDeviceIds: summary.knownDeviceIds,
        uniqueAdvertisedIds: summary.uniqueDeviceIds,
      });
  } else {
    log("info", "diag.advertised_devices.known_present",
      "All known device IDs are present in advertised devices.", {
        knownDeviceIds: summary.knownDeviceIds,
        uniqueAdvertisedIds: summary.uniqueDeviceIds,
      });
  }
  if (summary.expectedDeviceIds.length === 0) return;
  if (summary.missingExpectedDeviceIds.length > 0) {
    log("warning", "diag.advertised_devices.expected_missing",
      "Some expected device IDs are not present in advertised devices.", {
        expectedDeviceIds: summary.expectedDeviceIds,
        missingExpectedDeviceIds: summary.missingExpectedDeviceIds,
        uniqueAdvertisedIds: summary.uniqueDeviceIds,
      });
  } else {
    log("info", "diag.advertised_devices.expected_present",
      "All expected device IDs are present in advertised devices.", {
        expectedDeviceIds: summary.expectedDeviceIds,
        uniqueAdvertisedIds: summary.uniqueDeviceIds,
      });
  }
}

function reportOverview(
  state: ReturnType<DiagnosticsSession["getState"]>,
  foldersToCheck: DiagnosticFolder[],
  folderSyncStates: DiagnosticSyncState[],
): FolderDiagnosticsReport["overview"] {
  return {
    connectedVia: state.connectionPath,
    transportKind: state.connectionTransport || "direct-tcp",
    connectionScope: state.connectionScope || undefined,
    folderCount: foldersToCheck.length,
    folderIds: foldersToCheck.map((folder) => folder.id),
    folderSyncStates,
  };
}

function buildDiagnosticsReport(args: {
  startedAtMs: number;
  startedAtIso: string;
  options: ConnectOptions;
  session: DiagnosticsSession;
  latestSyncStates: DiagnosticSyncState[];
  foldersToCheck: DiagnosticFolder[];
  polling: FolderDiagnosticsReport["polling"];
  timeline: FolderDiagnosticsLogEvent[];
  folderResults: FolderDiagnosticsFolderResult[];
  advertisedByFolder: FolderDiagnosticsReport["advertisedDevices"]["byFolder"];
  summary: ReturnType<typeof summarizeAdvertisedDevices>;
}): FolderDiagnosticsReport {
  const finishedAtMs = Date.now();
  const state = args.session.getState();
  return {
    startedAtIso: args.startedAtIso,
    finishedAtIso: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - args.startedAtMs,
    connection: {
      discoveryMode: args.options.discoveryMode,
      remoteId: args.options.remoteId,
      host: args.options.host,
      port: args.options.port,
    },
    overview: reportOverview(state, args.foldersToCheck, args.latestSyncStates),
    polling: args.polling,
    timeline: args.timeline,
    folders: args.folderResults,
    advertisedDevices: {
      byFolder: args.advertisedByFolder,
      uniqueDeviceIds: args.summary.uniqueDeviceIds,
      knownDeviceIds: args.summary.knownDeviceIds,
      missingKnownDeviceIds: args.summary.missingKnownDeviceIds,
      expectedDeviceIds: args.summary.expectedDeviceIds,
      missingExpectedDeviceIds: args.summary.missingExpectedDeviceIds,
    },
  };
}

export async function runFolderContentDiagnostics(args: {
  client: SyncpeerBrowserClient;
  options: ConnectOptions;
  knownDeviceIds?: string[];
  expectedDeviceIds?: string[];
  maxPollAttempts?: number;
  pollIntervalMs?: number;
}): Promise<FolderDiagnosticsReport> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const pollIntervalMs = Math.max(50, args.pollIntervalMs ?? 250);
  const maxPollAttempts = Math.max(1, args.maxPollAttempts ?? 16);
  const { timeline, log } = createDiagnosticsTimeline();
  const session = await openDiagnosticsSession(args.client, args.options, log);
  const { polling, foldersToCheck } = await pollFolderVersions(
    session, args.options, maxPollAttempts, pollIntervalMs, log,
  );
  let latestSyncStates = session.getState().folderSyncStates;
  const folderResults: FolderDiagnosticsFolderResult[] = [];
  for (const folder of foldersToCheck) {
    const diagnosis = await diagnoseFolder(session, folder, args.options, log);
    folderResults.push(diagnosis.result);
    latestSyncStates = diagnosis.syncStates;
  }
  const advertisedByFolder = collectAdvertisedByFolder(foldersToCheck);
  const summary = summarizeAdvertisedDevices(args, advertisedByFolder);
  logAdvertisedDevices(log, summary);
  return buildDiagnosticsReport({
    startedAtMs, startedAtIso, options: args.options, session, latestSyncStates,
    foldersToCheck, polling, timeline, folderResults, advertisedByFolder, summary,
  });
}
