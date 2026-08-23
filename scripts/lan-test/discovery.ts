import dgram from "node:dgram";
import type { PeerCandidate, PeerHello, RoleAssignment } from "./protocol.ts";
import {
  assignRoles,
  isCompatiblePeer,
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_PORT,
} from "./protocol.ts";

const ANNOUNCE_INTERVAL_MS = 500;
const SETTLE_WINDOW_MS = 2_000;

const encodeHello = (hello: PeerHello): Buffer =>
  Buffer.from(JSON.stringify(hello), "utf8");

const decodeHello = (packet: Buffer): PeerHello | null => {
  try {
    const value = JSON.parse(packet.toString("utf8")) as PeerHello;
    if (
      typeof value.peerId !== "string" ||
      typeof value.commit !== "string" ||
      typeof value.protocolVersion !== "number" ||
      typeof value.capabilities?.client !== "boolean" ||
      typeof value.capabilities?.server !== "boolean"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
};

const openMulticastSocket = async (): Promise<dgram.Socket> => {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(LAN_DISCOVERY_PORT, "0.0.0.0", () => {
      socket.off("error", reject);
      try {
        socket.addMembership(LAN_DISCOVERY_GROUP);
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(true);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  return socket;
};

const discoverCandidates = async (hello: PeerHello): Promise<PeerCandidate[]> => {
  const socket = await openMulticastSocket();
  const candidates = new Map<string, PeerCandidate>();
  const startedAt = Date.now();
  const announce = () => {
    socket.send(encodeHello(hello), LAN_DISCOVERY_PORT, LAN_DISCOVERY_GROUP);
  };
  const interval = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  announce();

  try {
    socket.on("message", (packet, remote) => {
      const remoteHello = decodeHello(packet);
      if (!remoteHello || !isCompatiblePeer(hello, remoteHello)) return;
      candidates.set(remoteHello.peerId, {
        hello: remoteHello,
        address: remote.address,
        port: remote.port,
      });
    });
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_WINDOW_MS));
    return [...candidates.values()];
  } finally {
    clearInterval(interval);
    socket.close();
  }
};

export const discoverRoleAssignment = async (args: {
  hello: PeerHello;
  manualPeer?: string;
  manualRole?: "server" | "client";
}): Promise<{ assignment: RoleAssignment; localAddress: string }> => {
  if (Boolean(args.manualPeer) !== Boolean(args.manualRole)) {
    throw new Error(
      "Set both SYNCPEER_LAN_ROLE and SYNCPEER_LAN_PEER when using manual LAN pairing.",
    );
  }
  if (args.manualPeer && args.manualRole) {
    const peer: PeerCandidate = {
      hello: {
        protocolVersion: args.hello.protocolVersion,
        peerId: `manual-${args.manualPeer}`,
        commit: args.hello.commit,
        pairCode: args.hello.pairCode,
        capabilities: { client: true, server: true },
        startedAtMs: Date.now(),
      },
      address: args.manualPeer,
      port: 0,
    };
    const local: PeerCandidate = {
      hello: args.hello,
      address: "127.0.0.1",
      port: 0,
    };
    return {
      assignment: args.manualRole === "server"
        ? { server: local, client: peer }
        : { server: peer, client: local },
      localAddress: args.manualPeer,
    };
  }

  const candidates = await discoverCandidates(args.hello);
  if (candidates.length !== 1) {
    throw new Error(
      `LAN pairing found ${candidates.length} compatible peers; expected one. ` +
      "Use SYNCPEER_LAN_ROLE and SYNCPEER_LAN_PEER when multicast is unavailable.",
    );
  }
  const local: PeerCandidate = { hello: args.hello, address: "", port: 0 };
  const assignment = assignRoles([local, candidates[0]]);
  return { assignment, localAddress: candidates[0].address };
};

export const resolveLocalAddress = async (peerAddress: string): Promise<string> => {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(9, peerAddress, () => resolve());
  });
  const address = socket.address();
  socket.close();
  if (typeof address === "string" || !address.address) {
    throw new Error("Could not determine the LAN address for the paired peer.");
  }
  return address.address;
};
