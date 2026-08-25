import { randomUUID } from "node:crypto";

export const LAN_PROTOCOL_VERSION = 1;
export const LAN_DISCOVERY_GROUP = "239.255.77.77";
export const LAN_DISCOVERY_PORT = 38377;
export const LAN_COORDINATOR_PORT = 38378;

export type LanRole = "server" | "client";

export interface PeerCapabilities {
  client: boolean;
  server: boolean;
}

export interface PeerHello {
  protocolVersion: number;
  peerId: string;
  commit: string;
  pairCode: string;
  capabilities: PeerCapabilities;
  startedAtMs: number;
}

export interface PeerCandidate {
  hello: PeerHello;
  address: string;
  port: number;
}

export interface RoleAssignment {
  server: PeerCandidate;
  client: PeerCandidate;
}

export type LanPhase =
  | "direct"
  | "lan-discovery"
  | "global"
  | "relay"
  | "public-smoke"
  | "encrypted-direct";

export interface LanFixture {
  runId: string;
  serverHost: string;
  directPort: number;
  discoveryServer: string;
  remoteDeviceId: string;
  folderId: string;
  expectedFiles: Array<{ path: string; sha256: string; size: number }>;
  encryptedFolderId: string;
  encryptedPassword: string;
  encryptedExpected: { path: string; sha256: string; size: number };
}

export const createPeerHello = (args: {
  commit: string;
  pairCode?: string;
  capabilities: PeerCapabilities;
}): PeerHello => ({
  protocolVersion: LAN_PROTOCOL_VERSION,
  peerId: randomUUID(),
  commit: args.commit,
  pairCode: args.pairCode?.trim() ?? "",
  capabilities: args.capabilities,
  startedAtMs: Date.now(),
});

export const isCompatiblePeer = (local: PeerHello, remote: PeerHello): boolean =>
  local.peerId !== remote.peerId &&
  local.protocolVersion === remote.protocolVersion &&
  local.pairCode === remote.pairCode;

export const assignRoles = (candidates: PeerCandidate[]): RoleAssignment => {
  if (candidates.length !== 2) {
    throw new Error(`Expected exactly two compatible peers, got ${candidates.length}.`);
  }
  const capableServers = candidates.filter((candidate) => candidate.hello.capabilities.server);
  const capableClients = candidates.filter((candidate) => candidate.hello.capabilities.client);
  if (capableServers.length === 0 || capableClients.length === 0) {
    throw new Error("The paired peers do not provide both server and client capabilities.");
  }

  const client = capableClients.length === 1
    ? capableClients[0]
    : [...candidates].sort((left, right) => left.hello.peerId.localeCompare(right.hello.peerId))[1];
  const server = candidates.find((candidate) => candidate.hello.peerId !== client.hello.peerId);
  if (!server || !server.hello.capabilities.server) {
    throw new Error("Could not assign a server role to the paired peers.");
  }
  return { server, client };
};

export const roleForPeer = (assignment: RoleAssignment, peerId: string): LanRole => {
  if (assignment.server.hello.peerId === peerId) return "server";
  if (assignment.client.hello.peerId === peerId) return "client";
  throw new Error(`Peer ${peerId} is not part of the selected pair.`);
};

export const derivePairToken = (left: PeerHello, right: PeerHello): string => {
  const ids = [left.peerId, right.peerId].sort().join(":");
  return Buffer.from(ids + ":" + left.pairCode).toString("base64url");
};

export const deriveManualPairToken = (hello: PeerHello): string =>
  Buffer.from("manual:" + hello.pairCode).toString("base64url");

export const deriveServerCoordinatorToken = (
  serverDeviceId: string,
  pairCode = "",
): string => Buffer.from(
  "server:" + serverDeviceId.replaceAll("-", "").toUpperCase() + ":" + pairCode.trim(),
).toString("base64url");
