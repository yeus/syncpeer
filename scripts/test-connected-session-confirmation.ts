import assert from "node:assert/strict";
import test from "node:test";
import { confirmConnectedSession } from "../packages/core/src/sync/connectedSessionConfirmation.ts";

const peer = (remoteDeviceId: string, closed = false) => ({ remoteDeviceId, isClosed: () => closed });

test("acknowledges the current live peer instead of a superseded open result", () => {
  const obsolete = peer("PEERAAAA", true);
  const replacement = peer("PEERAAAA");
  assert.equal(confirmConnectedSession(obsolete, replacement, "PEERAAAA"), replacement);
});

test("does not acknowledge an unrelated or disconnected replacement", () => {
  const original = peer("PEERAAAA", true);
  assert.throws(() => confirmConnectedSession(original, peer("PEERBBBB"), "PEERAAAA"), /replaced/);
  assert.throws(() => confirmConnectedSession(original, peer("PEERAAAA", true), "PEERAAAA"), /replaced/);
  assert.throws(() => confirmConnectedSession(original, null, "PEERAAAA"), /replaced/);
});

test("unconstrained peer connect can only acknowledge its own open result", () => {
  const original = peer("PEERAAAA");
  assert.equal(confirmConnectedSession(original, original), original);
  assert.throws(() => confirmConnectedSession(original, peer("PEERBBBB")), /replaced/);
});
