import { normalizeDeviceId } from "./ui/helpers.js";

/** Discovery is evidence of reachability, never an authorization grant. */
export type PeerDiscoveryKind = "lan" | "introduced" | "manual" | "incoming";
export interface PeerDiscoveryEvidence {
  kind: PeerDiscoveryKind;
  sourceDeviceId?: string;
  folderIds?: string[];
  addresses?: string[];
  lastSeenAtMs: number;
}
export interface PeerDiscoveryRecord {
  deviceId: string;
  sources: PeerDiscoveryEvidence[];
}
export type PeerDiscoveryRegistry = Record<string, PeerDiscoveryRecord>;
export const PEER_DISCOVERY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_DISCOVERED_PEERS = 256;
const MAX_SOURCES_PER_PEER = 16;

const evidenceKey = (source: PeerDiscoveryEvidence) =>
  JSON.stringify([source.kind, normalizeDeviceId(source.sourceDeviceId ?? "")]);

export const observePeer = (
  registry: PeerDiscoveryRegistry,
  deviceId: string,
  evidence: PeerDiscoveryEvidence,
): PeerDiscoveryRegistry => {
  const id = normalizeDeviceId(deviceId);
  if (!/^[A-Z2-7]{52}$/.test(id) || !Number.isFinite(evidence.lastSeenAtMs) || evidence.lastSeenAtMs < 0) return registry;
  const previous = registry[id]?.sources ?? [];
  const key = evidenceKey(evidence);
  const other = previous.filter(item => evidenceKey(item) !== key);
  const existing = previous.find(item => evidenceKey(item) === key);
  if (existing &&
      evidence.lastSeenAtMs - existing.lastSeenAtMs < 60_000 &&
      JSON.stringify([...new Set(existing.addresses ?? [])].sort()) ===
        JSON.stringify([...new Set(evidence.addresses ?? [])].sort()) &&
      JSON.stringify([...new Set(existing.folderIds ?? [])].sort()) ===
        JSON.stringify([...new Set(evidence.folderIds ?? [])].sort())) return registry;
  const sources = [...other, {
    ...evidence,
    sourceDeviceId: evidence.sourceDeviceId ? normalizeDeviceId(evidence.sourceDeviceId) : undefined,
    folderIds: [...new Set(evidence.folderIds ?? [])].sort().slice(0, 64),
    addresses: [...new Set(evidence.addresses ?? [])].sort().slice(0, 12),
  }].sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs).slice(0, MAX_SOURCES_PER_PEER);
  return { ...registry, [id]: { deviceId: id, sources } };
};

export const expirePeerDiscovery = (
  registry: PeerDiscoveryRegistry,
  nowMs: number,
  retainedIds: readonly string[] = [],
): PeerDiscoveryRegistry => {
  const retained = new Set(retainedIds.map(normalizeDeviceId));
  return Object.fromEntries(
    Object.values(registry)
      .map(record => {
        const id = normalizeDeviceId(record.deviceId);
        const sources = (record.sources ?? []).filter(source =>
          source.kind === "manual" ||
          (Number.isFinite(source.lastSeenAtMs) &&
            source.lastSeenAtMs <= nowMs &&
            nowMs - source.lastSeenAtMs < PEER_DISCOVERY_RETENTION_MS));
        return { deviceId: id, sources };
      })
      .filter(record => record.deviceId && (record.sources.length > 0 || retained.has(record.deviceId)))
      .sort((a, b) =>
        Math.max(...b.sources.map(s => s.lastSeenAtMs), 0) -
        Math.max(...a.sources.map(s => s.lastSeenAtMs), 0))
      .slice(0, MAX_DISCOVERED_PEERS)
      .map(record => [record.deviceId, record]),
  );
};

export const normalizePeerDiscovery = (value: unknown, nowMs = Date.now()): PeerDiscoveryRegistry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  let registry: PeerDiscoveryRegistry = {};
  for (const [deviceId, record] of Object.entries(value).slice(0, MAX_DISCOVERED_PEERS)) {
    if (!record || typeof record !== "object" || !Array.isArray((record as PeerDiscoveryRecord).sources)) continue;
    for (const source of (record as PeerDiscoveryRecord).sources.slice(0, MAX_SOURCES_PER_PEER)) {
      if (!source || !["lan", "introduced", "manual", "incoming"].includes(source.kind) ||
        typeof source.lastSeenAtMs !== "number" || source.lastSeenAtMs > nowMs ||
        (source.sourceDeviceId && typeof source.sourceDeviceId !== "string") ||
        (source.addresses && (!Array.isArray(source.addresses) ||
          !source.addresses.every(address => typeof address === "string"))) ||
        (source.folderIds && (!Array.isArray(source.folderIds) ||
          !source.folderIds.every(folderId => typeof folderId === "string")))) continue;
      registry = observePeer(registry, deviceId, source);
    }
  }
  return expirePeerDiscovery(registry, nowMs);
};

export interface PeerRegistryView {
  deviceId: string;
  name: string;
  configured: boolean;
  confirmed: boolean;
  connected: boolean;
  awaitingRemoteApproval: boolean;
  sources: PeerDiscoveryEvidence[];
}

export const peerRegistryViews = (args: {
  saved: readonly { id: string; name: string }[];
  discovery: PeerDiscoveryRegistry;
  advertised: readonly { id: string; name: string; sourceFolderIds: string[] }[];
  connectedDeviceId?: string;
  confirmedDeviceIds?: ReadonlySet<string>;
  awaitingRemoteApproval?: ReadonlySet<string>;
  nowMs?: number;
}): PeerRegistryView[] => {
  const records = new Map<string, PeerRegistryView>();
  const source = expirePeerDiscovery(args.discovery, args.nowMs ?? Date.now(), args.saved.map(item => item.id));
  const get = (id: string) => {
    const key = normalizeDeviceId(id);
    if (!/^[A-Z2-7]{52}$/.test(key)) return null;
    if (!records.has(key)) records.set(key, {
      deviceId: key, name: key, configured: false, confirmed: false, connected: false,
      awaitingRemoteApproval: false, sources: source[key]?.sources ?? [],
    });
    return records.get(key)!;
  };
  for (const item of Object.values(source)) get(item.deviceId);
  for (const item of args.advertised) {
    const record = get(item.id);
    if (!record) continue;
    if (record.name === record.deviceId) record.name = item.name || record.name;
  }
  for (const item of args.saved) {
    const record = get(item.id);
    if (!record) continue;
    record.configured = true;
    record.name = item.name || record.name;
  }
  for (const record of records.values()) {
    record.connected = normalizeDeviceId(args.connectedDeviceId ?? "") === record.deviceId;
    record.confirmed = record.configured &&
      (record.connected || (args.confirmedDeviceIds?.has(record.deviceId) ?? false));
    record.awaitingRemoteApproval = args.awaitingRemoteApproval?.has(record.deviceId) ?? false;
  }
  return [...records.values()].sort((a, b) =>
    Number(b.connected) - Number(a.connected) ||
    Number(b.configured) - Number(a.configured) ||
    a.name.localeCompare(b.name));
};
