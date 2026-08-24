import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  discoverCandidates,
  type DiscoverySocket,
} from "./lan-test/discovery.ts";
import { createPeerHello } from "./lan-test/protocol.ts";

class FakeDiscoverySocket extends EventEmitter {
  close(): void {}

  send(): void {}

  addMembership(): void {}

  setMulticastTTL(): void {}
}

async function main(): Promise<void> {
  const local = createPeerHello({
    commit: "test-commit",
    capabilities: { client: true, server: true },
  });
  const remote = createPeerHello({
    commit: local.commit,
    capabilities: { client: true, server: true },
  });
  const socket = new FakeDiscoverySocket();
  const socketFactory = async (): Promise<DiscoverySocket> => {
    setTimeout(() => {
      socket.emit(
        "message",
        Buffer.from(JSON.stringify(remote)),
        { address: "192.168.1.22", port: 38377 },
      );
    }, 2100);
    return socket as unknown as DiscoverySocket;
  };

  const candidates = await discoverCandidates(local, { socketFactory });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.hello.peerId, remote.peerId);
  console.log("LAN discovery delayed-peer test passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
