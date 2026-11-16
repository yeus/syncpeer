/** Only coarse, bounded values cross into the crash-persistent Android journal. */
const enumerated = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;

const boundedCount = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(1000, Math.max(0, value)) : 0;

export const safeNativeDiscoveryDiagnostic = (details?: Record<string, unknown>) => {
  const message = typeof details?.message === "string" ? details.message : "";
  const category =
    /not authorized|revoked|retired|not paired|approval/i.test(message) ? "authorization" :
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
    relayCount: boundedCount(details?.relayCandidateCount),
    protocol: enumerated(details?.protocol, ["tcp", "quic", "relay", "unknown"] as const, "unknown"),
    source: enumerated(details?.source, ["local", "global", "manual", "unknown"] as const, "unknown"),
    scope: enumerated(details?.scope, ["lan", "wan", "unknown"] as const, "unknown"),
    addressFamily: enumerated(details?.addressFamily, ["ipv4", "ipv6", "dns", "unknown"] as const, "unknown"),
  };
};
