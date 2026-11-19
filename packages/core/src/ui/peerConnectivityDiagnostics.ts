import { resolveGlobalDiscovery, type DiscoveredCandidate, type SyncpeerHostAdapter } from "../client.js";
import { sameDeviceId } from "./helpers.js";

export interface PeerConnectivityTarget {
  deviceId: string;
  /** Optional existing endpoint of this peer, never another peer's host. */
  knownTcp?: { host: string; port: number };
  /** Transport is already healthy; do not open another socket using the same identity. */
  activeSession?: boolean;
}

export type ConnectivityProbeOutcome = "verified" | "failed" | "skipped";
export type ConnectivityProbePath =
  "saved-lan-tcp" | "discovered-lan-tcp" | "global-ipv4-tcp" |
  "global-ipv6-tcp" | "global-ipv4-quic" | "global-relay";

export interface ConnectivityProbeAttempt {
  path: ConnectivityProbePath;
  trial: number;
  outcome: ConnectivityProbeOutcome;
  durationMs: number;
  category?: string;
}

export interface PeerConnectivityResult {
  peerNumber: number;
  localDiscovery: { tcp: number; quic: number; relay: number; status: "ok" | "failed"; category?: string };
  globalDiscovery: { tcp: number; quic: number; relay: number; status: "ok" | "failed"; category?: string };
  attempts: ConnectivityProbeAttempt[];
  activeSessionPreserved: boolean;
  /** Direct TCP for the priority peer worked on some trials but not others. */
  intermittentDirectTcp: boolean;
}

export interface PeerConnectivityReport {
  savedPeerCount: number;
  testedPeerCount: number;
  truncated: boolean;
  scope: "isolated-transport-and-tls-identity";
  note: string;
  peers: PeerConnectivityResult[];
}

const MAX_PEERS = 4;
const MAX_CANDIDATES_PER_PEER = 6;
const TLS_TIMEOUT_MS = 3500;
const LOOKUP_TIMEOUT_MS = 5500;

const classify = (error: unknown): string => {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/identity|certificate mismatch|device id/.test(message)) return "identity";
  if (/timeout|timed out|deadline|abort/.test(message)) return "timeout";
  if (/tls|handshake|ssl|certificate/.test(message)) return "tls";
  if (/refused/.test(message)) return "refused";
  if (/dns|resolve|name or service|eai_/.test(message)) return "dns";
  if (/unreachable|network|no route/.test(message)) return "unreachable";
  if (/permission|unauthoriz|denied/.test(message)) return "authorization";
  return "other";
};

const candidatesCount = (candidates: readonly DiscoveredCandidate[]) => ({
  tcp: candidates.filter(c => c.protocol === "tcp").length,
  quic: candidates.filter(c => c.protocol === "quic").length,
  relay: candidates.filter(c => c.protocol === "relay").length,
});

const ipv4 = (host: string | undefined): boolean => {
  if (!host) return false;
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every(part =>
    /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const first = Number(octets[0]);
  return first >= 1 && first < 224 && first !== 127 &&
    !(first === 169 && Number(octets[1]) === 254);
};

const ipv6 = (host: string | undefined): boolean => {
  if (!host) return false;
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  return value.includes(":") && value !== "::" && value !== "::1" &&
    !value.startsWith("fe80:") && !value.startsWith("ff");
};

const endpointValid = (candidate: DiscoveredCandidate): boolean =>
  typeof candidate.port === "number" && Number.isInteger(candidate.port) &&
  candidate.port > 0 && candidate.port <= 65535;

const probeCases = (
  target: PeerConnectivityTarget,
  local: readonly DiscoveredCandidate[],
  global: readonly DiscoveredCandidate[],
) => {
  const localTcp = local.find(c => c.protocol === "tcp" && endpointValid(c) && ipv4(c.host));
  const globalTcp4 = global.find(c => c.protocol === "tcp" && endpointValid(c) && ipv4(c.host));
  const globalTcp6 = global.find(c => c.protocol === "tcp" && endpointValid(c) && ipv6(c.host));
  const globalQuic4 = global.find(c => c.protocol === "quic" && endpointValid(c) && ipv4(c.host));
  const globalRelay = global.find(c => c.protocol === "relay" && c.address.startsWith("relay://"));
  const cases: Array<{ path: ConnectivityProbePath; host?: string; port?: number;
    address?: string; transport: "tcp" | "quic" | "relay" }> = [];
  if (target.knownTcp) {
    cases.push({ path: "saved-lan-tcp", ...target.knownTcp, transport: "tcp" });
  }
  if (localTcp && (!target.knownTcp || localTcp.host !== target.knownTcp.host ||
    localTcp.port !== target.knownTcp.port)) {
    cases.push({ path: "discovered-lan-tcp", ...localTcp, transport: "tcp" });
  }
  if (globalTcp4) cases.push({ path: "global-ipv4-tcp", ...globalTcp4, transport: "tcp" });
  if (globalTcp6) cases.push({ path: "global-ipv6-tcp", ...globalTcp6, transport: "tcp" });
  if (globalQuic4) cases.push({ path: "global-ipv4-quic", ...globalQuic4, transport: "quic" });
  if (globalRelay) cases.push({ path: "global-relay", address: globalRelay.address, transport: "relay" });
  return cases.slice(0, MAX_CANDIDATES_PER_PEER);
};

const within = async <T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Transport probe timed out"));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
};

export const runPeerConnectivityProbes = async (args: {
  adapter: SyncpeerHostAdapter;
  identity: { certPem: string; keyPem: string };
  targets: readonly PeerConnectivityTarget[];
  discoveryServer?: string;
  identifyRemote: (certificateDer: Uint8Array) => Promise<string>;
  onProgress?: (peerNumber: number, stage: string) => void;
}): Promise<PeerConnectivityReport> => {
  const targets = args.targets.slice(0, MAX_PEERS);
  const peers: PeerConnectivityResult[] = [];
  let localStatus: "ok" | "failed" = "ok";
  let localCategory: string | undefined;
  const local = await (async () => {
    try {
      return await within(2500, signal => args.adapter.discoverLocalCandidates?.({
        expectedDeviceId: "", timeoutMs: 1600, signal,
      }) ?? Promise.resolve([]));
    } catch (error) {
      localStatus = "failed";
      localCategory = classify(error);
      return [] as DiscoveredCandidate[];
    }
  })();
  for (const [index, target] of targets.entries()) {
    const peerNumber = index + 1;
    const localForPeer = local.filter(candidate => sameDeviceId(candidate.deviceId ?? "", target.deviceId));
    const result: PeerConnectivityResult = {
      peerNumber,
      localDiscovery: { ...candidatesCount(localForPeer), status: localStatus,
        ...(localCategory ? { category: localCategory } : {}) },
      globalDiscovery: { tcp: 0, quic: 0, relay: 0, status: "ok" },
      attempts: [],
      activeSessionPreserved: target.activeSession === true,
      intermittentDirectTcp: false,
    };
    args.onProgress?.(peerNumber, "global-discovery");
    let global: DiscoveredCandidate[] = [];
    try {
      // Avoid logging discovery's raw IPs/device IDs into UI diagnostic events.
      global = (await within(LOOKUP_TIMEOUT_MS, signal =>
        resolveGlobalDiscovery({ ...args.adapter, log: undefined },
          { expectedDeviceId: target.deviceId, discoveryServer: args.discoveryServer }, signal))).candidates;
      result.globalDiscovery = { ...candidatesCount(global), status: "ok" };
    } catch (error) {
      result.globalDiscovery = { ...candidatesCount(global), status: "failed", category: classify(error) };
    }
    // Even TLS-only duplicate connections can trigger remote session
    // arbitration. When already authenticated, report the live session and
    // discovery results instead of attempting a second socket.
    const cases = target.activeSession ? [] : probeCases(target, localForPeer, global);
    const repeatedDirectIndex = peerNumber === 1
      ? cases.findIndex(probe => probe.path === "saved-lan-tcp" || probe.path === "discovered-lan-tcp")
      : -1;
    // Three automatic direct-TCP trials on the priority saved peer expose
    // intermittent first-dial failures without any manual toggling on the phone.
    const scheduled = cases.flatMap((probe, i) =>
      (i === repeatedDirectIndex ? [1, 2, 3] : [1]).map(trial => ({ ...probe, trial })));
    for (const probe of scheduled) {
      if (probe.transport !== "relay" && (!probe.host || !probe.port)) continue;
      args.onProgress?.(peerNumber, `${probe.path} trial ${probe.trial}`);
      if ((probe.transport === "quic" && !args.adapter.connectQuic) ||
          (probe.transport === "relay" && !args.adapter.connectRelay)) {
        result.attempts.push({ path: probe.path, trial: probe.trial, outcome: "skipped",
          durationMs: 0, category: "unsupported" });
        continue;
      }
      const started = Date.now();
      let outcome: ConnectivityProbeOutcome = "verified";
      let category: string | undefined;
      try {
        await within(TLS_TIMEOUT_MS + 1500, async signal => {
          const socket = probe.transport === "relay"
            ? (await args.adapter.connectRelay?.({
                relayAddress: probe.address!, expectedDeviceId: target.deviceId,
                certPem: args.identity.certPem, keyPem: args.identity.keyPem,
                timeoutMs: TLS_TIMEOUT_MS, signal,
              }))?.socket
            : probe.transport === "quic"
              ? await args.adapter.connectQuic?.({
                  host: probe.host!, port: probe.port!,
                  certPem: args.identity.certPem, keyPem: args.identity.keyPem,
                  alpn: "bep/1.0", keepaliveMs: 5000, idleTimeoutMs: 5000,
                  timeoutMs: TLS_TIMEOUT_MS, signal,
                })
              : await args.adapter.connectTls({
                  host: probe.host!, port: probe.port!,
                  certPem: args.identity.certPem, keyPem: args.identity.keyPem,
                  timeoutMs: TLS_TIMEOUT_MS, signal, alpnProtocols: ["bep/1.0"],
                });
          if (!socket) throw new Error("Transport unavailable");
          try {
            const remote = await args.identifyRemote(await socket.peerCertificateDer());
            if (!sameDeviceId(remote, target.deviceId)) throw new Error("Remote identity mismatch");
          } finally {
            await socket.close().catch(() => undefined);
          }
        });
      } catch (error) {
        outcome = "failed";
        category = classify(error);
      }
      result.attempts.push({
        path: probe.path, trial: probe.trial, outcome, durationMs: Date.now() - started,
        ...(category ? { category } : {}),
      });
    }
    const directTrials = result.attempts.filter(attempt =>
      repeatedDirectIndex >= 0 && attempt.path === cases[repeatedDirectIndex]?.path);
    result.intermittentDirectTcp = directTrials.some(item => item.outcome === "verified") &&
      directTrials.some(item => item.outcome === "failed");
    peers.push(result);
  }
  return {
    savedPeerCount: args.targets.length,
    testedPeerCount: peers.length,
    truncated: args.targets.length > peers.length,
    scope: "isolated-transport-and-tls-identity",
    note: "The priority peer gets three automatic Direct TCP trials when an address is available. Already connected peers are discovery-only to avoid duplicate socket arbitration. Otherwise only short-lived transport/TLS certificate checks are attempted; no BEP, folder writes, or live-session replacement. Failed handshakes do not prove remote authorization was rejected.",
    peers,
  };
};
