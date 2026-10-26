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
  return {
    type: "sessionStatus",
    revision: Number(raw.revision),
    phase,
    active: raw.active,
    foreground: raw.foreground,
    ...(optionalText(raw.error) !== undefined ? { error: optionalText(raw.error)! } : {}),
    ...(peerPhase !== undefined ? { peerPhase } : {}),
    ...(optionalText(raw.peerError) !== undefined ? { peerError: optionalText(raw.peerError)! } : {}),
    ...(updatedAtMs !== undefined ? { updatedAtMs: Number(updatedAtMs) } : {}),
  };
};

export const serviceSessionStatusIsTerminal = (event: ServiceSessionStatusEvent): boolean =>
  !event.active || event.phase === "idle" || event.phase === "stopping" ||
  event.phase === "error" || event.peerPhase === "idle" || event.peerPhase === "error";

export const serviceSessionStatusMessage = (event: ServiceSessionStatusEvent): string =>
  event.peerError ?? event.error ??
  (event.active ? "Android service peer session is no longer connected." : "Android service is unavailable.");
