import assert from "node:assert/strict";
import test from "node:test";
import { connectRelayWithRetry } from "../packages/core/dist/client.js";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";

const options = { relayAddress: "relay://synthetic.invalid:22067", expectedDeviceId: "AAAA",
  certPem: "synthetic-certificate", keyPem: "synthetic-key", timeoutMs: 2000 };
const result = { connectedVia: "synthetic", socket: {
  peerCertificateDer: async () => new Uint8Array(), read: async () => new Uint8Array(),
  write: async () => {}, close: async () => {},
} };

test("a relay join race requests a fresh session before retrying", async () => {
  let attempts = 0;
  const value = await connectRelayWithRetry({ ...createNodeHostAdapter(), connectRelay: async () => {
    if (++attempts === 1) throw new Error("Relay join failed (2): already connected");
    return result;
  } }, options);
  assert.equal(attempts, 2); assert.equal(value, result);
});

test("relay certificate rejection is never retried", async () => {
  let attempts = 0;
  await assert.rejects(connectRelayWithRetry({ ...createNodeHostAdapter(), connectRelay: async () => {
    attempts++; throw new Error("Relay certificate ID mismatch");
  } }, options), /certificate ID mismatch/);
  assert.equal(attempts, 1);
});

test("relay join retries stop after three attempts", async () => {
  let attempts = 0;
  await assert.rejects(connectRelayWithRetry({ ...createNodeHostAdapter(), connectRelay: async () => {
    attempts++; throw new Error("Relay join failed (2): already connected");
  } }, options), /Relay join failed/);
  assert.equal(attempts, 3);
});

test("aborting a relay join retry stops before another session request", async () => {
  const stop = new AbortController();
  let attempts = 0;
  await assert.rejects(connectRelayWithRetry({ ...createNodeHostAdapter(), connectRelay: async () => {
    attempts++; stop.abort(); throw new Error("Relay join failed (2): already connected");
  } }, { ...options, signal: stop.signal }), /cancelled/i);
  assert.equal(attempts, 1);
});
