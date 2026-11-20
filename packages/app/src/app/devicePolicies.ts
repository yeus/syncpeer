import {
  observePeer,
  PEER_DISCOVERY_RETENTION_MS,
  normalizeDeviceId,
  sameDeviceId,
} from "@syncpeer/core/browser";
import {
  advertisedDevices,
  type AppState,
} from "./state.ts";
import { temporarySavedDeviceName } from "./suggestedNames.ts";

const sortByName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((left, right) => left.name.localeCompare(right.name));

export const normalizeCandidateDeviceId = (deviceId: string) =>
  normalizeDeviceId(deviceId);

const SYNCTHING_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const luhn32CheckDigit = (value: string): string => {
  let factor = 1;
  let sum = 0;
  for (const character of value) {
    const codepoint = SYNCTHING_ID_ALPHABET.indexOf(character);
    if (codepoint < 0) return "";
    let addend = factor * codepoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return SYNCTHING_ID_ALPHABET[(32 - (sum % 32)) % 32];
};

/**
 * Render a canonical 52-character device ID in the grouped form Syncthing
 * shows (Luhn check digits plus 7-character groups). Values that are not
 * device IDs, such as anonymous LAN placeholders, pass through.
 */
export const formatSyncthingDeviceId = (deviceId: string): string => {
  const normalized = normalizeDeviceId(deviceId);
  const canonical = normalized.length === 56
    ? [...normalized].filter((_, index) => (index + 1) % 14 !== 0).join("")
    : normalized;
  if (canonical.length !== 52) return String(deviceId ?? "").trim();
  let grouped = "";
  for (let index = 0; index < 4; index += 1) {
    const chunk = canonical.slice(index * 13, (index + 1) * 13);
    grouped += chunk + luhn32CheckDigit(chunk);
  }
  return grouped.match(/.{1,7}/g)?.join("-") ?? grouped;
};

export const normalizeCandidateAddresses = (addresses: string[]) =>
  [...new Set(addresses.map((item) => String(item ?? "").trim()).filter(Boolean))].sort();

export const parseTcpAddress = (
  address: string,
): { host: string; port: number } | null => {
  const trimmed = String(address ?? "").trim();
  if (!trimmed.startsWith("tcp://")) return null;
  try {
    const parsed = new URL(trimmed);
    const port = Number(parsed.port);
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
};

const privateIpv4 = (host: string): boolean => {
  const parts = host.split(".");
  const octets = parts.map(Number);
  if (octets.length !== 4 || parts.some((part, i) => !/^\d{1,3}$/.test(part) || octets[i]! > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
};

const lanTcpEndpoint = (address: string) => {
  const endpoint = parseTcpAddress(address);
  return endpoint && privateIpv4(endpoint.host) ? endpoint : null;
};

/** Direct TCP uses a known address for the *selected* peer; a device ID alone
 * cannot be translated to an IP without discovery. Never reuse another peer's
 * manual host or silently fall back to WAN/relay.
 */
export const directTcpEndpointForPeer = (
  state: AppState, deviceId: string, nowMs = Date.now(),
): { host: string; port: number } | null => {
  const id = normalizeDeviceId(deviceId);
  if (!id) return null;
  if (state.session.isConnected && sameDeviceId(state.session.remoteDevice?.id ?? "", id) &&
      state.session.connectionTransport === "direct-tcp") {
    const connected = lanTcpEndpoint(state.session.connectionPath);
    if (connected) return connected;
  }
  // An explicit host entered for this same peer remains a valid direct choice.
  if (sameDeviceId(state.connection.remoteId, id) && state.connection.discoveryMode === "direct") {
    const existing = lanTcpEndpoint(`tcp://${state.connection.host}:${state.connection.port}`);
    if (existing) return existing;
  }
  const sources = [
    ...(state.devices.peerDiscovery[id]?.sources ?? [])
      .filter(source => (source.kind === "verified" || source.kind === "lan") &&
        source.lastSeenAtMs <= nowMs && nowMs - source.lastSeenAtMs < PEER_DISCOVERY_RETENTION_MS),
    ...(state.devices.lanDiscoveryByDeviceId[id]
      ? [{ kind: "lan" as const, ...state.devices.lanDiscoveryByDeviceId[id] }] : [])
      .filter(source => source.lastSeenAtMs <= nowMs && nowMs - source.lastSeenAtMs < PEER_DISCOVERY_RETENTION_MS),
  ].sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
  for (const source of sources) {
    for (const address of source.addresses ?? []) {
      const endpoint = lanTcpEndpoint(address);
      if (endpoint) return endpoint;
    }
  }
  return null;
};

/** Remember only an authenticated LAN TCP path, in the encrypted peer registry. */
export const rememberAuthenticatedTcpEndpoint = (
  state: AppState, deviceId: string, nowMs = Date.now(),
): void => {
  const id = normalizeDeviceId(deviceId);
  if (!id || !state.session.isConnected ||
      !sameDeviceId(state.session.remoteDevice?.id ?? state.connection.remoteId, id) ||
      state.session.connectionTransport !== "direct-tcp") return;
  const endpoint = lanTcpEndpoint(state.session.connectionPath);
  if (!endpoint) return;
  state.devices.peerDiscovery = observePeer(state.devices.peerDiscovery, id, {
    kind: "verified", addresses: [`tcp://${endpoint.host}:${endpoint.port}`], lastSeenAtMs: nowMs,
  });
};

/** Explicit direct addresses belong to one peer; selecting a different peer
 * returns to discovery without accidentally dialing that old endpoint.
 */
export const preferredConnectionForDevice = (
  connection: AppState["connection"],
  deviceId: string,
): Pick<AppState["connection"], "remoteId" | "discoveryMode" | "host" | "quicOnly"> => {
  const preserveDirect = connection.discoveryMode === "direct" &&
    sameDeviceId(connection.remoteId, deviceId) &&
    connection.host.trim().length > 0 &&
    Number.isSafeInteger(Number(connection.port)) &&
    Number(connection.port) > 0 && Number(connection.port) <= 65535;
  return {
    remoteId: normalizeDeviceId(deviceId),
    discoveryMode: preserveDirect ? "direct" : "automatic",
    host: preserveDirect ? connection.host : "",
    // QUIC-only is a Direct-mode choice. It must not leak to another peer's
    // automatic connection, where it would suppress TCP and relay fallback.
    quicOnly: preserveDirect ? connection.quicOnly : false,
  };
};

export const suggestedSavedDeviceName = (state: AppState, deviceId: string) => {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) return "";
  const advertised = advertisedDevices(state).find((item) => sameDeviceId(item.id, normalized));
  if (advertised?.name.trim()) return advertised.name.trim();
  const existing = state.devices.savedDevices.find((item) => sameDeviceId(item.id, normalized));
  if (existing?.name.trim()) return existing.name.trim();
  return temporarySavedDeviceName(normalized);
};

export const upsertSavedDevice = (
  state: AppState,
  deviceId: string,
  name?: string,
  options?: { customName?: boolean; isIntroducer?: boolean },
) => {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) return false;
  const existing = state.devices.savedDevices.find((item) => item.id === normalized);
  const nextEntry = {
    id: normalized,
    name: (name ?? "").trim() || temporarySavedDeviceName(normalized),
    createdAtMs: existing?.createdAtMs ?? Date.now(),
    isIntroducer: options?.isIntroducer ?? existing?.isIntroducer ?? false,
    customName: options?.customName ?? existing?.customName ?? false,
  };
  state.devices.savedDevices = sortByName(
    existing
      ? state.devices.savedDevices.map((item) =>
          item.id === normalized ? nextEntry : item,
        )
      : [...state.devices.savedDevices, nextEntry],
  );
  return true;
};

export const syncConnectedDeviceSavedName = (
  state: AppState,
  deviceId: string,
  advertisedName?: string,
) => {
  const normalized = normalizeDeviceId(deviceId);
  const nextName = (advertisedName ?? "").trim();
  if (!normalized || !nextName) return;
  const existing = state.devices.savedDevices.find((item) =>
    sameDeviceId(item.id, normalized),
  );
  if (!existing || existing.customName || existing.name.trim() === nextName) return;
  upsertSavedDevice(state, normalized, nextName, { customName: false });
};

/** A peer's cluster configuration is discovery evidence, not consent. */
export const recordAdvertisedPeerSuggestions = (state: AppState, sourceDeviceId: string) => {
  if (!sourceDeviceId) return;
  let discovery = state.devices.peerDiscovery;
  for (const device of advertisedDevices(state)) {
    if (device.id === sourceDeviceId || device.id === state.devices.currentDeviceId) continue;
    discovery = observePeer(discovery, device.id, {
      kind: "introduced", sourceDeviceId, folderIds: device.sourceFolderIds,
      lastSeenAtMs: Date.now(),
    });
  }
  state.devices.peerDiscovery = discovery;
};
