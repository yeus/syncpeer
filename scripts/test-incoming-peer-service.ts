import assert from "node:assert/strict";
import { test } from "node:test";
import { startIncomingPeerService } from "../packages/core/dist/sync/incomingPeerService.js";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";

test("shutdown closes a pending pairing socket before waiting for its handler", async () => {
  const reading = Promise.withResolvers<Uint8Array>();
  const entered = Promise.withResolvers<void>();
  const accepting = Promise.withResolvers<never>();
  let first = true;
  let closed = false;
  const socket = {
    peerCertificateDer: async () => new Uint8Array([1]),
    read: () => reading.promise,
    write: async () => {},
    close: async () => { closed = true; reading.resolve(new Uint8Array()); },
  };
  const service = await startIncomingPeerService({ ...createNodeHostAdapter(),
    listenTls: async () => ({ port: 22000,
      accept: async () => {
        if (!first) return accepting.promise;
        first = false;
        return { socket, alpn: "syncpeer-pairing/1", remoteAddress: "127.0.0.1", remotePort: 1 };
      },
      // Match the native adapter: closing the listener does not close accepted sockets.
      close: async () => { accepting.reject(new Error("Listener closed")); },
    }),
  }, { host: "127.0.0.1", certPem: "synthetic", keyPem: "synthetic", localDeviceId: "AAAA",
    approvedDeviceIds: [], connectionOptions: () => { throw new Error("Not a BEP test"); },
    onSession: () => {}, onPairingSocket: async accepted => {
      entered.resolve(); await accepted.socket.read(1);
    },
  });
  await entered.promise;
  const closing = service.close();
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, true);
    await closing;
  } finally {
    reading.resolve(new Uint8Array());
    await closing;
  }
});
