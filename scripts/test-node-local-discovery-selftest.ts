import crypto from "node:crypto";
import dgram from "node:dgram";

type ResolveNodeLocalDiscovery = (args: {
  expectedDeviceId?: string;
  timeoutMs?: number;
  listenPort?: number;
}) => Promise<{
  candidates: Array<{ protocol?: string; host?: string; port?: number }>;
}>;
type CreateAnnouncement = (certDer: Uint8Array, port: number, instanceId?: number) => Uint8Array;

const loadLocalDiscovery = async (): Promise<{
  resolve: ResolveNodeLocalDiscovery;
  announce: CreateAnnouncement;
}> => {
  try {
    const mod = (await import("../packages/core/dist/node.js")) as {
      resolveNodeLocalDiscovery?: ResolveNodeLocalDiscovery;
      createNodeLocalDiscoveryAnnouncement?: CreateAnnouncement;
    };
    if (typeof mod.resolveNodeLocalDiscovery === "function" &&
      typeof mod.createNodeLocalDiscoveryAnnouncement === "function") {
      return { resolve: mod.resolveNodeLocalDiscovery, announce: mod.createNodeLocalDiscoveryAnnouncement };
    }
  } catch {
    // Fall back to the TypeScript source when the build is unavailable.
  }
  const mod = (await import("../packages/core/src/node.ts")) as {
    resolveNodeLocalDiscovery?: ResolveNodeLocalDiscovery;
    createNodeLocalDiscoveryAnnouncement?: CreateAnnouncement;
  };
  if (typeof mod.resolveNodeLocalDiscovery !== "function" ||
    typeof mod.createNodeLocalDiscoveryAnnouncement !== "function") {
    throw new Error("Node local discovery exports not found");
  }
  return { resolve: mod.resolveNodeLocalDiscovery, announce: mod.createNodeLocalDiscoveryAnnouncement };
};

function base32NoPadding(input: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

async function sendOnce(port: number, packet: Uint8Array): Promise<void> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.send(packet, port, "127.0.0.1", (error) => {
      socket.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const { resolve: resolveNodeLocalDiscovery, announce } = await loadLocalDiscovery();
  const listenPort = 32127;
  const certificate = crypto.randomBytes(256);
  const idBytes = crypto.createHash("sha256").update(certificate).digest();
  const expectedDeviceId = base32NoPadding(idBytes);
  const packet = announce(certificate, 22000, 1);

  const discoveryPromise = resolveNodeLocalDiscovery({
    expectedDeviceId,
    timeoutMs: 1200,
    listenPort,
  });
  setTimeout(() => {
    void sendOnce(listenPort, packet);
  }, 150);

  const result = await discoveryPromise;
  const match = result.candidates.find(
    (candidate) => candidate.protocol === "tcp" &&
      candidate.host === "127.0.0.1" &&
      candidate.port === 22000,
  );
  if (!match) {
    throw new Error("Self-test failed: expected tcp://127.0.0.1:22000 candidate not found");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        listenPort,
        expectedDeviceId,
        candidateCount: result.candidates.length,
        matchedCandidate: match,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
