/** Probe the TypeScript service-owned session, not the native status bus.
 * The service's "status" command has phase/active but no peerPhase field.
 * TLS/BEP authentication is proved by a successful current-session overview
 * followed by a live remote folder query. Never accept phase alone.
 */
export const probeServiceReadiness = async ({
  call, expectedDeviceId, expectedFolderId, normalizeDeviceId,
}) => {
  let status;
  try { status = await call("status"); }
  catch { return { phase: "status-unavailable", nativeConnected: false, stage: "status" }; }
  const phase = status?.peerPhase ?? status?.phase ?? "unknown";
  const nativeConnected = status?.phase === "connected" && status.active === true;
  if (!nativeConnected || (status.peerPhase != null && status.peerPhase !== "connected")) {
    return { phase, nativeConnected, stage: "lifecycle" };
  }
  let overview;
  try { overview = await call("overview"); }
  catch { return { phase, nativeConnected, authenticated: false, stage: "overview" }; }
  if (!overview || !["direct-tcp", "direct-quic", "relay"].includes(overview.transportKind)) {
    return { phase, nativeConnected, authenticated: false, stage: "overview" };
  }
  if (overview.device?.id &&
    normalizeDeviceId(overview.device.id) !== normalizeDeviceId(expectedDeviceId)) {
    throw new Error("Authenticated Android session belongs to an unexpected synthetic peer.");
  }
  let folders;
  try { folders = await call("listFolders"); }
  catch { return { phase, nativeConnected, authenticated: true, folderReady: false, stage: "folder" }; }
  return { phase, nativeConnected, authenticated: true,
    folderReady: Array.isArray(folders) && folders.some(folder => folder.id === expectedFolderId),
    stage: "folder" };
};

/** Authenticated Android session and first *live* folder operation latency gate.
 * A native/UI "connected" flag alone never counts as success.
 */
export const measureConnectionReadiness = async ({
  probe,
  now = () => performance.now(),
  startedAtMs,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollIntervalMs = 250,
  authenticationBudgetMs = 20_000,
  folderBudgetMs = 25_000,
  stableWindowMs = 2_000,
}) => {
  if ([pollIntervalMs, authenticationBudgetMs, folderBudgetMs, stableWindowMs]
    .some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Connection performance budgets must be positive finite milliseconds.");
  }
  const started = startedAtMs ?? now();
  let authenticatedMs = null;
  let folderMs = null;
  let stableSinceMs = null;
  let previousAuthenticated = false;
  let flaps = 0;
  let prematureConnected = 0;
  let probes = 0;
  while (true) {
    const observation = await probe();
    probes++;
    const elapsedMs = Math.max(0, now() - started);
    const authenticated = observation.authenticated === true;
    const folderReady = authenticated && observation.folderReady === true;
    const lastPhase = observation.phase ?? "unknown";
    const context = `phase=${lastPhase} stage=${observation.stage ?? "unknown"} ` +
      `serviceConnected=${observation.nativeConnected === true} ` +
      `authenticated=${authenticated} folderReady=${folderReady} probes=${probes}`;
    if (observation.nativeConnected && !authenticated) prematureConnected++;
    if (previousAuthenticated && !authenticated) flaps++;
    previousAuthenticated = authenticated;
    if (authenticated && authenticatedMs === null) authenticatedMs = elapsedMs;
    if (folderReady && folderMs === null) folderMs = elapsedMs;
    stableSinceMs = folderReady ? stableSinceMs ?? elapsedMs : null;

    if (flaps > 0) throw new Error(`Authenticated Android session flapped before stability (${context}).`);
    if ((authenticatedMs ?? elapsedMs) > authenticationBudgetMs) {
      throw new Error(`Authenticated connection exceeded ${authenticationBudgetMs}ms (${context}).`);
    }
    if ((folderMs ?? elapsedMs) > folderBudgetMs) {
      throw new Error(`Live folder operation exceeded ${folderBudgetMs}ms (${context}).`);
    }
    if (stableSinceMs !== null && elapsedMs - stableSinceMs >= stableWindowMs) {
      return { authenticatedMs, folderMs, stableMs: elapsedMs,
        prematureConnected, probes, flaps };
    }
    if (elapsedMs > folderBudgetMs + stableWindowMs + pollIntervalMs) {
      throw new Error("Authenticated Android folder session did not remain stable within its budget.");
    }
    await sleep(pollIntervalMs);
  }
};
