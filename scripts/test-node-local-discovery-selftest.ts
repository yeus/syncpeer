import crypto from "node:crypto";
import dgram from "node:dgram";
import protobuf from "protobufjs";
import { resolveNodeLocalDiscovery } from "../packages/core/src/node.ts";

const MAGIC = 0x2ea7d90b;
const ANNOUNCE = new protobuf.Type("Announce")
  .add(new protobuf.Field("id", 1, "bytes"))
  .add(new protobuf.Field("addresses", 2, "string", "repeated"))
  .add(new protobuf.Field("instance_id", 3, "int64"));

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

function createAnnouncePacket(deviceIdBytes: Uint8Array): Uint8Array {
  const encoded = ANNOUNCE.encode(
    ANNOUNCE.create({
      id: deviceIdBytes,
      addresses: ["tcp://0.0.0.0:22000"],
      instance_id: 1n,
    }),
  ).finish();
  const out = new Uint8Array(4 + encoded.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, MAGIC, false);
  out.set(encoded, 4);
  return out;
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
  const listenPort = 32127;
  const idBytes = crypto.randomBytes(32);
  const expectedDeviceId = base32NoPadding(idBytes);
  const packet = createAnnouncePacket(idBytes);

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
