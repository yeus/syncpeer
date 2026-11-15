import assert from "node:assert/strict";
import test from "node:test";
import { settleDiscoveryWithin } from "../packages/core/src/sync/discoveryBudgets.ts";
import { createAbortableConcurrencyLimit } from "../packages/core/src/sync/connectionDialLimiter.ts";
import { createSyncpeerCoreClient } from "../packages/core/dist/client.js";

test("a hung optional discovery source is bounded without leaving a deadline timer", async () => {
  const start = performance.now();
  const result = await settleDiscoveryWithin(new Promise<never>(() => undefined), 18, "Global discovery");
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.match(String(result.reason), /exceeded 18 ms/);
  assert.ok(performance.now() - start < 400);
});

test("a LAN dial begins promptly while a hung global discovery is still pending", async () => {
  let dials = 0;
  let firstDialAt = 0;
  let globalCancelled = false;
  const startedAt = performance.now();
  const client = createSyncpeerCoreClient({
    connectTls: async () => {
      dials++;
      firstDialAt ||= performance.now();
      throw new Error("Synthetic LAN handshake failed");
    },
    sha256: async () => new Uint8Array(32),
    randomBytes: async size => new Uint8Array(size),
    discoverLocalCandidates: async () => [{
      address: "tcp://192.0.2.42:22000", host: "192.0.2.42", port: 22000,
      protocol: "tcp" as const, scope: "lan" as const,
    }],
    discoveryFetch: async (_url, options) => new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        globalCancelled = true;
        reject(new Error("Discovery aborted"));
      }, { once: true });
    }),
  });
  await assert.rejects(client.openSession({
    host: "", port: 22000, discoveryMode: "automatic",
    expectedDeviceId: "SYNTHETIC", certPem: "synthetic", keyPem: "synthetic",
    deviceName: "test", timeoutMs: 3000,
  }), /Synthetic LAN handshake failed/);
  assert.equal(dials, 1);
  assert.equal(globalCancelled, true, "Abandoned HTTPS lookup should be cancelled.");
  assert.ok(firstDialAt - startedAt < 1500,
    "Global discovery must not delay the first LAN dial.");
});

test("a stale LAN advertisement cannot suppress a slower valid global fallback", async () => {
  const dials: string[] = [];
  const client = createSyncpeerCoreClient({
    connectTls: async ({ host }) => {
      dials.push(host);
      throw new Error("Synthetic dial failure: " + host);
    },
    sha256: async () => new Uint8Array(32),
    randomBytes: async size => new Uint8Array(size),
    discoverLocalCandidates: async () => [{
      address: "tcp://192.0.2.42:22000", host: "192.0.2.42", port: 22000,
      protocol: "tcp" as const, scope: "lan" as const,
    }],
    discoveryFetch: async () => ({
      ok: true, status: 200, text: async () => "",
      json: () => new Promise(resolve => setTimeout(() => resolve({
        addresses: ["tcp://wan.example:22000"],
      }), 1100)),
    }),
  });
  await assert.rejects(client.openSession({
    host: "", port: 22000, discoveryMode: "automatic",
    expectedDeviceId: "SYNTHETIC", certPem: "synthetic", keyPem: "synthetic",
    deviceName: "test", timeoutMs: 4000,
  }), /Synthetic dial failure/);
  assert.ok(dials.includes("192.0.2.42"), "LAN must be tried first.");
  assert.ok(dials.includes("wan.example"), "The later global candidate must still be attempted.");
});

test("a large advertisement list never launches more than three simultaneous direct dials", async () => {
  let inFlight = 0;
  let peak = 0;
  let attempted = 0;
  const addresses = Array.from({ length: 14 }, (_, i) => `tcp://192.0.2.${i + 10}:22000`);
  const client = createSyncpeerCoreClient({
    connectTls: async () => {
      attempted++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 8));
      inFlight--;
      throw new Error("Synthetic candidate unreachable");
    },
    sha256: async () => new Uint8Array(32),
    randomBytes: async size => new Uint8Array(size),
    discoveryFetch: async () => ({
      ok: true, status: 200, text: async () => "",
      json: async () => ({ addresses }),
    }),
  });
  await assert.rejects(client.openSession({
    host: "", port: 22000, discoveryMode: "global",
    expectedDeviceId: "SYNTHETIC", certPem: "synthetic", keyPem: "synthetic",
    deviceName: "test", timeoutMs: 4000,
  }), /Synthetic candidate unreachable/);
  assert.equal(attempted, addresses.length, "Subsequent candidates should still be tried.");
  assert.ok(peak <= 3, `Started ${peak} simultaneous native TCP handshakes.`);
  assert.ok(peak >= 2, "The dialer should still race a few candidates.");
});

test("shared dial slots do not leak after cancellation and remain reusable", async () => {
  const gate = createAbortableConcurrencyLimit(2);
  const release: Array<() => void> = [];
  const blockedOne = gate.run(() => new Promise<void>(resolve => { release.push(resolve); }));
  const blockedTwo = gate.run(() => new Promise<void>(resolve => { release.push(resolve); }));
  const controller = new AbortController();
  const cancelled = gate.run(async () => {
    throw new Error("Cancelled job must not start.");
  }, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /cancelled/i);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(release.length, 2);
  release.forEach(resolve => resolve());
  await Promise.all([blockedOne, blockedTwo]);
  assert.equal(await gate.run(async () => 42), 42);
});
