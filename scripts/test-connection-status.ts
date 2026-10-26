import assert from "node:assert/strict";
import test from "node:test";
import { connectionStatusLabel, connectionStatusTone } from "../packages/app/src/lib/connectionStatus.ts";

test("connected Android sessions surface pushed peer phases in the header badge", () => {
  const base = { phase: "connected" as const, connected: true, paused: false };
  assert.equal(connectionStatusLabel(base), "Connected");
  assert.equal(connectionStatusLabel({ ...base, peerPhase: "reconnecting" }), "Reconnecting");
  assert.equal(connectionStatusLabel({ ...base, peerPhase: "waiting" }), "Waiting");
  assert.equal(connectionStatusLabel({ ...base, peerPhase: "error" }), "Connection error");
  assert.equal(connectionStatusLabel({ ...base, peerPhase: "connected" }), "Connected");
  assert.equal(connectionStatusTone({ ...base, peerPhase: "reconnecting" }), "offline");
  assert.equal(connectionStatusTone({ ...base, peerPhase: "error" }), "error");
  assert.equal(connectionStatusTone({ ...base, peerPhase: "connected" }), "online");
});
