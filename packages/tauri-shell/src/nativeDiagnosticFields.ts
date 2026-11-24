/** Only coarse, bounded values cross into the crash-persistent Android journal. */
const enumerated = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;

const boundedCount = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(1000, Math.max(0, value)) : 0;

const boundedMilliseconds = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(120_000, Math.max(0, value)) : 0;

export const safeNativeDiscoveryDiagnostic = (details?: Record<string, unknown>) => {
  const message = typeof details?.message === "string" ? details.message : "";
  const category =
    // Suggestions about possible approval must never reclassify network errors.
    /not authorized|revoked|retired|not paired|not approved|unknown device|not configured|not in config|access denied|certificate unknown|remote peer rejected this device/i.test(message) ? "authorization" :
    /timed? ?out|deadline/i.test(message) ? "timeout" :
    /refused|unreachable|no route/i.test(message) ? "unreachable" :
    /certificate|tls|handshake|alpn|peer identity/i.test(message) ? "tls" :
    /dns|unknown host|name resolution|no such host/i.test(message) ? "dns" :
    /relay/i.test(message) ? "relay" :
    /closed|disconnected|cancelled|aborted/i.test(message) ? "disconnected" :
    message ? "other" : "none";
  return {
    category,
    directCount: boundedCount(details?.directCandidateCount),
    priorSuccessCount: boundedCount(details?.priorSuccessCount),
    cooldownCount: boundedCount(details?.cooldownCount),
    relayCount: boundedCount(details?.relayCandidateCount),
    protocol: enumerated(details?.protocol, ["tcp", "quic", "relay", "unknown"] as const, "unknown"),
    source: enumerated(details?.source, ["local", "global", "manual", "unknown"] as const, "unknown"),
    scope: enumerated(details?.scope, ["lan", "wan", "unknown"] as const, "unknown"),
    addressFamily: enumerated(details?.addressFamily, ["ipv4", "ipv6", "dns", "unknown"] as const, "unknown"),
    candidateOrdinal: boundedCount(details?.candidateOrdinal),
    durationMs: boundedMilliseconds(details?.durationMs),
    timeoutMs: boundedMilliseconds(details?.timeoutMs),
  };
};

/** Persist only fixed BEP stage/direction labels, timing and error category. */
export const safeNativeBepDiagnostic = (event: string, details?: Record<string, unknown>) => {
  const phases: Record<string, string> = {
    "core.bep.handshake.peer_cert": "peer_certificate",
    "core.bep.handshake.hello_sent": "hello_sent",
    "core.bep.handshake.hello_recv": "hello_received",
    "core.bep.handshake.ready": "ready",
  };
  const stage = event === "core.bep.handshake.failed"
    ? enumerated(details?.stage, ["peer_certificate", "hello_exchange", "cluster_config"] as const, "peer_certificate")
    : phases[event];
  if (!stage) return null;
  return {
    stage,
    direction: enumerated(details?.direction, ["incoming", "outgoing"] as const, "outgoing"),
    category: event === "core.bep.handshake.failed"
      ? safeNativeDiscoveryDiagnostic(details).category : "none",
    durationMs: boundedMilliseconds(details?.durationMs),
  };
};

const boundedPositive = (value: unknown, max: number): number =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(max, Math.max(0, value)) : 0;

/** Safe for persistent native diagnostics: never carries paths, peer IDs or error messages. */
export const safeNativeTransferDiagnostic = (details?: Record<string, unknown>) => {
  const stage = enumerated(details?.stage,
    ["queue_wait", "local_preflight", "remote_lookup", "draft_open", "first_bytes",
      "progress", "storage_write", "draft_commit", "finished", "failed",
      "blocks_start", "blocks_first", "blocks_progress", "blocks_complete", "invalid"] as const,
    "invalid");
  if (stage === "invalid") return null;
  return {
    stage,
    durationMs: boundedPositive(details?.durationMs, 86_400_000),
    bytes: boundedPositive(details?.bytes, 1_000_000_000_000),
    totalBytes: boundedPositive(details?.totalBytes, 1_000_000_000_000),
    networkBytes: boundedPositive(details?.networkBytes, 1_000_000_000_000),
    storageMs: boundedPositive(details?.storageMs, 86_400_000),
    requestMs: boundedPositive(details?.requestMs, 86_400_000),
    maxRequestMs: boundedPositive(details?.maxRequestMs, 86_400_000),
    reason: enumerated(details?.reason,
      ["network", "storage", "cancelled", "unavailable", "other", "none"] as const, "none"),
  };
};
