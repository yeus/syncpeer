import assert from "node:assert/strict";
import test from "node:test";
import { settleDiscoveryWithin } from "../packages/core/src/sync/discoveryBudgets.ts";
import { createAbortableConcurrencyLimit } from "../packages/core/src/sync/connectionDialLimiter.ts";
import { createSyncpeerCoreClient } from "../packages/core/dist/client.js";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { createNodeHostAdapter, listenNodePeer } from "../packages/core/dist/node.js";
import type { SyncpeerSessionHandle } from "../packages/core/src/client.ts";

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

test("multipath network resilience regressions (real TLS/BEP)", { timeout: 22000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-multipath-"));
  const stalledSockets = new Set<net.Socket>();
  const stalledServers: net.Server[] = [];
  const incoming: SyncpeerSessionHandle[] = [];
  let listener: Awaited<ReturnType<typeof listenNodePeer>> | undefined;
  let outgoing: SyncpeerSessionHandle | undefined;
  const runCase = async (name: string, fn: () => Promise<void>) =>
    t.test(name, async () => {
      try { await fn(); }
      finally {
        await outgoing?.close().catch(() => undefined);
        outgoing = undefined;
      }
    });
  const identity = async (name: string) => {
    const cert = path.join(root, name + ".pem");
    const key = path.join(root, name + ".key");
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-nodes", "-days", "1", "-subj", "/CN=synthetic-multipath",
      "-keyout", key, "-out", cert], { stdio: "ignore" });
    const certPem = await readFile(cert, "utf8");
    return { certPem, keyPem: await readFile(key, "utf8"),
      deviceId: computeDeviceId(new X509Certificate(certPem).raw) };
  };
  const blackhole = async () => {
    const server = net.createServer(socket => {
      stalledSockets.add(socket);
      socket.on("close", () => stalledSockets.delete(socket));
      // Accept TCP and intentionally never complete TLS. This reproduces a
      // reachable but unresponsive/stale advertised LAN endpoint.
      socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    stalledServers.push(server);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  };
  try {
    const [local, peer] = await Promise.all([identity("local"), identity("remote")]);
    listener = await listenNodePeer({ ...peer, host: "127.0.0.1", port: 0,
      expectedDeviceId: local.deviceId, deviceName: "synthetic-healthy-peer",
      timeoutMs: 6000, onSession: session => { incoming.push(session); } });
    const blackholePorts = await Promise.all(Array.from({ length: 3 }, blackhole));
    const localCandidates = [
      ...blackholePorts.map(port => ({ address: `tcp://127.0.0.1:${port}`,
        host: "127.0.0.1", port, protocol: "tcp" as const, scope: "lan" as const })),
      ...Array.from({ length: 11 }, (_, i) => ({ address: `tcp://192.0.2.${i + 10}:22000`,
        host: `192.0.2.${i + 10}`, port: 22000,
        protocol: "tcp" as const, scope: "lan" as const })),
    ];
    const base = createNodeHostAdapter();
    await runCase("repeated blackholed LAN and jittered discovery reach authenticated folder metadata", async () => {
      for (let round = 0; round < 3; round++) {
        const attempted: string[] = [];
        const client = createSyncpeerCoreClient({
          ...base,
          connectTls: async options => {
            attempted.push(`${options.host}:${options.port}`);
            return base.connectTls(options);
          },
          discoverLocalCandidates: async () => localCandidates,
          discoveryFetch: async () => ({
            ok: true, status: 200, text: async () => "",
            json: async () => {
              await new Promise(resolve => setTimeout(resolve, 180 + round * 90));
              return { addresses: [`tcp://127.0.0.1:${listener!.port}`] };
            },
          }),
        });
        const start = performance.now();
        outgoing = await client.openSession({ ...local, host: "", port: 22000,
          expectedDeviceId: peer.deviceId, deviceName: "synthetic-multipath-client",
          discoveryMode: "automatic", timeoutMs: 3500, enableRelayFallback: false });
        assert.equal(outgoing.remoteDeviceId, peer.deviceId);
        assert.ok(attempted.includes(`127.0.0.1:${listener.port}`),
          "Healthy global endpoint must start even while blackholed LAN dials are pending.");
        assert.ok(Array.isArray(await outgoing.remoteFs.listFolders()), "Authenticated peer must accept a live BEP folder request.");
        const elapsed = performance.now() - start;
        assert.ok(elapsed < 2600, `Round ${round + 1}: live folder readiness delayed by ${Math.round(elapsed)} ms`);
        await outgoing.close();
        outgoing = undefined;
      }
    });
    await runCase("global discovery outage releases reserved dial slot for LAN", async () => {
    // Reverse the setup: global discovery is offline, but the third LAN
    // candidate is healthy. The reserved slot must become available to LAN
    // once global discovery finishes, not remain idle behind two blackholes.
    const healthyLan = { address: `tcp://127.0.0.1:${listener.port}`,
      host: "127.0.0.1", port: listener.port, protocol: "tcp" as const, scope: "lan" as const };
    const lanFallback = createSyncpeerCoreClient({
      ...base,
      discoverLocalCandidates: async () => [
        ...localCandidates.slice(0, 2), healthyLan, ...localCandidates.slice(2),
      ],
      discoveryFetch: async () => {
        await new Promise(resolve => setTimeout(resolve, 180));
        throw new Error("Synthetic global discovery offline");
      },
    });
    const lanStart = performance.now();
    outgoing = await lanFallback.openSession({ ...local, host: "", port: 22000,
      expectedDeviceId: peer.deviceId, deviceName: "synthetic-multipath-client",
      discoveryMode: "automatic", timeoutMs: 3500, enableRelayFallback: false });
    assert.equal(outgoing.remoteDeviceId, peer.deviceId);
    assert.ok(performance.now() - lanStart < 2600,
      "Healthy third LAN candidate was starved when global discovery was unavailable.");
    });
    await runCase("blocked QUIC does not starve healthy TCP", async () => {
    // UDP/QUIC can be filtered even when TCP works. A blocked QUIC LAN
    // candidate must not prevent the globally discovered TCP path.
    let quicAttempts = 0;
    const quicClient = createSyncpeerCoreClient({
      ...base,
      connectQuic: async () => {
        quicAttempts++;
        return new Promise<never>(() => undefined);
      },
      discoverLocalCandidates: async () => [{
        address: "quic://127.0.0.1:22000", host: "127.0.0.1",
        port: 22000, protocol: "quic" as const, scope: "lan" as const,
      }],
      discoveryFetch: async () => ({
        ok: true, status: 200, text: async () => "",
        json: async () => {
          await new Promise(resolve => setTimeout(resolve, 180));
          return { addresses: [`tcp://127.0.0.1:${listener!.port}`] };
        },
      }),
    });
    const quicStart = performance.now();
    outgoing = await quicClient.openSession({ ...local, host: "", port: 22000,
      expectedDeviceId: peer.deviceId, deviceName: "synthetic-multipath-client",
      discoveryMode: "automatic", timeoutMs: 3500, enableRelayFallback: false });
    assert.equal(outgoing.remoteDeviceId, peer.deviceId);
    assert.equal(quicAttempts, 1, "The blocked QUIC path must actually be attempted.");
    assert.ok(performance.now() - quicStart < 2600,
      "A stalled QUIC path starved the healthy discovered TCP path.");
    });
    await runCase("crowded global discovery reaches healthy endpoint after stale addresses", async () => {
    // The remote may advertise 14 obsolete WAN addresses before its working
    // address. Each native timeout must fit a fair slice of the overall
    // connection budget or the healthy address is never reached.
    const crowdedGlobal = createSyncpeerCoreClient({
      ...base,
      discoverLocalCandidates: async () => [],
      discoveryFetch: async () => ({
        ok: true, status: 200, text: async () => "",
        json: async () => ({
          addresses: [...localCandidates.map(candidate => candidate.address),
            `tcp://localhost:${listener!.port}`],
        }),
      }),
    });
    const crowdedStart = performance.now();
    outgoing = await crowdedGlobal.openSession({ ...local, host: "", port: 22000,
      expectedDeviceId: peer.deviceId, deviceName: "synthetic-multipath-client",
      discoveryMode: "global", timeoutMs: 4000, enableRelayFallback: false });
    assert.equal(outgoing.remoteDeviceId, peer.deviceId);
    assert.ok(performance.now() - crowdedStart < 3500,
      "Global connection budget expired behind stale candidates before healthy TCP was attempted.");
    });
  } finally {
    await outgoing?.close().catch(() => undefined);
    await Promise.allSettled(incoming.map(session => session.close()));
    await listener?.close();
    for (const socket of stalledSockets) socket.destroy();
    await Promise.all(stalledServers.map(server =>
      new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
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
