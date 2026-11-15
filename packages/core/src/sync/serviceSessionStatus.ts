/** Status snapshots pushed by the Android service that owns the peer session. */
export type ServiceSessionPhase =
  | "idle"
  | "starting"
  | "connected"
  | "waiting"
  | "reconnecting"
  | "suspended"
  | "stopping"
  | "error";

export type ServiceFavoriteSyncStatus = {
  runId: number;
  stage: "starting" | "index" | "storage" | "listing" | "planning" | "processing"
    | "download" | "upload" | "delete" | "folder_done" | "complete" | "completed" | "failed";
  folderOrdinal: number;
  folderCount: number;
  itemOrdinal: number;
  itemCount: number;
  resultCount: number;
  problemCount: number;
  waitingCount: number;
  elapsedMs: number;
  idleMs: number;
  stalled: boolean;
  transferredBytes: number;
  totalBytes: number;
};

export type ServiceSessionStatusEvent = {
  type: "sessionStatus";
  revision: number;
  phase: ServiceSessionPhase;
  active: boolean;
  foreground: boolean;
  error?: string;
  /** Lifecycle phase reported by the TypeScript session owner inside the service. */
  peerPhase?: ServiceSessionPhase;
  peerError?: string;
  updatedAtMs?: number;
  sync?: ServiceFavoriteSyncStatus;
};

const phases: readonly ServiceSessionPhase[] = [
  "idle", "starting", "connected", "waiting", "reconnecting", "suspended", "stopping", "error",
];

const optionalText = (value: unknown, maximum = 4096): string | undefined =>
  typeof value === "string" && value.length <= maximum ? value : undefined;

const parsePhase = (value: unknown): ServiceSessionPhase | undefined =>
  typeof value === "string" && phases.includes(value as ServiceSessionPhase)
    ? value as ServiceSessionPhase
    : undefined;

const syncStages: readonly ServiceFavoriteSyncStatus["stage"][] = [
  "starting", "index", "storage", "listing", "planning", "processing", "download",
  "upload", "delete", "folder_done", "complete", "completed", "failed",
];

/** Drop unrecognized native telemetry rather than copying arbitrary strings into logs. */
export const parseServiceFavoriteSyncStatus = (value: unknown): ServiceFavoriteSyncStatus | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const stage = data.stage;
  if (typeof stage !== "string" || !syncStages.includes(stage as ServiceFavoriteSyncStatus["stage"]) ||
    typeof data.stalled !== "boolean") return null;
  const fields = ["runId", "folderOrdinal", "folderCount", "itemOrdinal", "itemCount",
    "resultCount", "problemCount", "waitingCount", "elapsedMs", "idleMs",
    "transferredBytes", "totalBytes"] as const;
  for (const key of fields) {
    const maximum = key === "elapsedMs" || key === "idleMs" ? 7 * 24 * 60 * 60 * 1000
      : key === "runId" || key === "transferredBytes" || key === "totalBytes"
        ? Number.MAX_SAFE_INTEGER : 1_000_000;
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0 ||
      (data[key] as number) > maximum) return null;
  }
  return { stage: stage as ServiceFavoriteSyncStatus["stage"], stalled: data.stalled,
    runId: data.runId as number, folderOrdinal: data.folderOrdinal as number,
    folderCount: data.folderCount as number, itemOrdinal: data.itemOrdinal as number,
    itemCount: data.itemCount as number, resultCount: data.resultCount as number,
    problemCount: data.problemCount as number, waitingCount: data.waitingCount as number,
    elapsedMs: data.elapsedMs as number, idleMs: data.idleMs as number,
    transferredBytes: data.transferredBytes as number, totalBytes: data.totalBytes as number };
};

/** Rejects malformed native event payloads instead of trusting the IPC boundary. */
export const parseServiceSessionStatusEvent = (
  value: unknown,
): ServiceSessionStatusEvent | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const phase = parsePhase(raw.phase);
  if (raw.type !== "sessionStatus" || phase === undefined ||
    !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 ||
    typeof raw.active !== "boolean" || typeof raw.foreground !== "boolean") {
    return null;
  }
  const peerPhase = raw.peerPhase === undefined ? undefined : parsePhase(raw.peerPhase);
  if (raw.peerPhase !== undefined && peerPhase === undefined) return null;
  const updatedAtMs = raw.updatedAtMs;
  if (updatedAtMs !== undefined && (!Number.isSafeInteger(updatedAtMs) || Number(updatedAtMs) < 0)) {
    return null;
  }
  const sync = raw.sync === undefined ? null : parseServiceFavoriteSyncStatus(raw.sync);
  return {
    type: "sessionStatus",
    revision: Number(raw.revision),
    phase,
    active: raw.active,
    foreground: raw.foreground,
    ...(optionalText(raw.error) !== undefined ? { error: optionalText(raw.error)! } : {}),
    ...(peerPhase !== undefined ? { peerPhase } : {}),
    ...(optionalText(raw.peerError) !== undefined ? { peerError: optionalText(raw.peerError)! } : {}),
    ...(sync !== null ? { sync } : {}),
    ...(updatedAtMs !== undefined ? { updatedAtMs: Number(updatedAtMs) } : {}),
  };
};

// A peer runtime can briefly report idle/error while the owning native service
// is starting or reconnecting. The native service phase and active flag are
// authoritative for whether the UI must detach its still-live RPC proxy.
export const serviceSessionStatusIsTerminal = (event: ServiceSessionStatusEvent): boolean =>
  !event.active || event.phase === "idle" || event.phase === "stopping" ||
  event.phase === "error";

export const serviceSessionStatusMessage = (event: ServiceSessionStatusEvent): string =>
  event.peerError ?? event.error ??
  (event.active ? "Android service peer session is no longer connected." : "Android service is unavailable.");
