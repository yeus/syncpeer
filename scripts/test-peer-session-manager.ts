import assert from "node:assert/strict";
import { test } from "node:test";
import { createPeerSessionManager, preferredPeerDirection } from
  "../packages/core/dist/sync/peerSessionManager.js";

const session = () => {
  const closed = Promise.withResolvers<void>();
  let closeCount = 0;
  return {
    value: { close: async () => { closeCount += 1; closed.resolve(); }, closed: closed.promise },
    closeCount: () => closeCount,
    end: () => closed.resolve(),
  };
};

test("duplicate direction is deterministic at both ends", () => {
  assert.equal(preferredPeerDirection("A", "B"), "outgoing");
  assert.equal(preferredPeerDirection("B", "A"), "incoming");
});

test("manager keeps concurrent sessions for different approved devices", async () => {
  const manager = createPeerSessionManager("A");
  const phone = session();
  const tablet = session();
  assert.equal(await manager.admit({ remoteDeviceId: "B", direction: "outgoing",
    connectionId: "one", session: phone.value }), true);
  assert.equal(await manager.admit({ remoteDeviceId: "C", direction: "outgoing",
    connectionId: "two", session: tablet.value }), true);
  assert.deepEqual(manager.active().map(item => item.remoteDeviceId), ["B", "C"]);
  await manager.close();
  assert.equal(phone.closeCount(), 1);
  assert.equal(tablet.closeCount(), 1);
});

test("preferred duplicate replaces the other direction without dropping unrelated peers", async () => {
  const manager = createPeerSessionManager("A");
  const incoming = session();
  const outgoing = session();
  const unrelated = session();
  await manager.admit({ remoteDeviceId: "B", direction: "incoming",
    connectionId: "incoming", session: incoming.value });
  await manager.admit({ remoteDeviceId: "C", direction: "outgoing",
    connectionId: "unrelated", session: unrelated.value });
  assert.equal(await manager.admit({ remoteDeviceId: "B", direction: "outgoing",
    connectionId: "outgoing", session: outgoing.value }), true);
  assert.equal(incoming.closeCount(), 1);
  assert.deepEqual(manager.active().map(item => [item.remoteDeviceId, item.direction]), [
    ["B", "outgoing"], ["C", "outgoing"],
  ]);
});

test("non-preferred duplicates are closed and never replace the live session", async () => {
  const manager = createPeerSessionManager("A");
  const outgoing = session();
  const duplicate = session();
  await manager.admit({ remoteDeviceId: "B", direction: "outgoing",
    connectionId: "kept", session: outgoing.value });
  assert.equal(await manager.admit({ remoteDeviceId: "B", direction: "incoming",
    connectionId: "closed", session: duplicate.value }), false);
  assert.equal(duplicate.closeCount(), 1);
  assert.equal(outgoing.closeCount(), 0);
});
