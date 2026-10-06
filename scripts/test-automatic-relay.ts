import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { SyncpeerHostAdapter, SyncpeerDiscoveryFetchInit } from "../packages/core/src/client.js";
import { automaticRelayConfiguration } from "../packages/core/dist/sync/automaticRelayPresence.js";
import { startIncomingPeerService } from "../packages/core/dist/sync/incomingPeerService.js";

function fixture() {
  const announced = Promise.withResolvers<void>();
  const dropped = Promise.withResolvers<never>();
  const requests: Array<{ url: string; init?: SyncpeerDiscoveryFetchInit }> = [];
  const registrations: string[] = [];
  let closed = 0;
  const adapter: SyncpeerHostAdapter = {
    connectTls: async () => { throw new Error("Not a dialing test"); },
    sha256: async () => new Uint8Array(32), randomBytes: size => new Uint8Array(size),
    listenTls: async () => {
      const pending = Promise.withResolvers<never>();
      return { port: 12345, accept: () => pending.promise,
        close: async () => { pending.reject(new Error("Closed")); } };
    },
    listenRelay: async options => {
      registrations.push(options.relayAddress);
      const pending = registrations.length === 1 ? dropped : Promise.withResolvers<never>();
      return { port: 0, accept: () => pending.promise,
        close: async () => { closed++; pending.reject(new Error("Closed")); } };
    },
    discoveryFetch: async (input, init) => {
      requests.push({ url: String(input), init });
      if (init?.method === "POST") announced.resolve();
      return { ok: true, status: init?.method === "POST" ? 204 : 200,
        headers: { "reannounce-after": "1800" }, text: async () => "",
        json: async () => ({ relays: [{ url: "relay://127.0.0.1:22067/?id=SYNTHETIC" }] }) };
    },
  };
  const options = { host: "127.0.0.1", certPem: "synthetic-certificate", keyPem: "synthetic-key",
    localDeviceId: "AAAA", approvedDeviceIds: ["BBBB"],
    automaticRelay: { poolUrl: "https://pool.synthetic.invalid/endpoint",
      discoveryServer: "https://discovery.synthetic.invalid/v2/?id=PINNED" },
    connectionOptions: () => { throw new Error("Not a handshake test"); }, onSession: () => {},
  };
  return { adapter, options, requests, registrations, announced, dropped, closed: () => closed };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Automatic relay transition did not complete");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("ordinary incoming service registers and publishes its relay using its device certificate", async () => {
  const f = fixture();
  const service = await startIncomingPeerService(f.adapter, f.options);
  try {
    await until(() => f.requests.some(request => request.init?.method === "POST"));
    const announcement = f.requests.find(request => request.init?.method === "POST")!;
    assert.equal(service.port, 12345);
    assert.equal(announcement.url, "https://discovery.synthetic.invalid/v2/");
    assert.equal(announcement.init?.pinServerDeviceId, "PINNED");
    assert.equal(announcement.init?.certPem, f.options.certPem);
    assert.equal(announcement.init?.keyPem, f.options.keyPem);
    assert.deepEqual(JSON.parse(announcement.init?.body ?? ""), { addresses: [f.registrations[0]] });
  } finally { await service.close(); }
  assert.equal(f.closed(), 1);
});

test("dropping relay presence re-registers and announces again", async () => {
  const f = fixture();
  const service = await startIncomingPeerService(f.adapter, f.options);
  try {
    await until(() => f.requests.some(request => request.init?.method === "POST"));
    f.dropped.reject(new Error("Synthetic relay loss"));
    await until(() => f.requests.filter(request => request.init?.method === "POST").length === 2);
    assert.equal(f.registrations.length, 2);
  } finally { await service.close(); }
});

test("repeatedly dropped registrations back off until a registration stays stable", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = fixture();
  const drops: Array<ReturnType<typeof Promise.withResolvers<never>>> = [];
  f.adapter.listenRelay = async options => {
    f.registrations.push(options.relayAddress);
    const drop = Promise.withResolvers<never>(); drops.push(drop);
    return { port: 0, accept: () => drop.promise,
      close: async () => { drop.reject(new Error("Closed")); } };
  };
  const service = await startIncomingPeerService(f.adapter, f.options);
  try {
    await setImmediate();
    drops[0].reject(new Error("Synthetic unstable registration")); await setImmediate();
    t.mock.timers.tick(1000); await setImmediate();
    assert.equal(drops.length, 2);
    drops[1].reject(new Error("Synthetic unstable registration")); await setImmediate();
    t.mock.timers.tick(1000); await setImmediate();
    assert.equal(drops.length, 2, "A second unstable registration must wait two seconds");
    t.mock.timers.tick(1000); await setImmediate();
    assert.equal(drops.length, 3);
    t.mock.timers.tick(30_000);
    drops[2].reject(new Error("Synthetic loss after stable registration")); await setImmediate();
    t.mock.timers.tick(1000); await setImmediate();
    assert.equal(drops.length, 4, "A stable registration resets retry backoff");
  } finally { await service.close(); }
});

test("a failed relay does not close the direct listener and selection tries another relay", async () => {
  const f = fixture();
  const fetch = f.adapter.discoveryFetch;
  f.adapter.discoveryFetch = async (input, init) => {
    const response = await fetch(input, init);
    return init?.method === "POST" ? response : { ...response, json: async () => ({ relays: [
      { url: "relay://127.0.0.1:22068/?id=UNAVAILABLE" },
      { url: "relay://127.0.0.1:22067/?id=SYNTHETIC" },
      { url: "https://invalid.synthetic.invalid/" },
    ] }) };
  };
  const listen = f.adapter.listenRelay!;
  f.adapter.listenRelay = async options => {
    if (options.relayAddress.includes(":22068/")) throw new Error("Synthetic registration failure");
    return listen(options);
  };
  const service = await startIncomingPeerService(f.adapter, f.options);
  try {
    await until(() => f.requests.some(request => request.init?.method === "POST"));
    assert.equal(service.port, 12345);
    assert.equal(f.registrations.length, 1);
  } finally { await service.close(); }
});

test("relay selection prefers port 443 before applying the candidate cap", async () => {
  const f = fixture();
  const fetch = f.adapter.discoveryFetch;
  f.adapter.discoveryFetch = async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method === "POST") return response;
    const relays = Array.from({ length: 40 }, (_, index) => ({
      url: `relay://127.0.0.${(index % 200) + 1}:22067/?id=SYNTHETIC-${index}`,
    }));
    relays.push({ url: "relay://127.0.0.250:443/?id=SYNTHETIC-HTTPS" });
    return { ...response, json: async () => ({ relays }) };
  };
  const service = await startIncomingPeerService(f.adapter, f.options);
  try {
    await until(() => f.requests.some(request => request.init?.method === "POST"));
    assert.match(f.registrations[0] ?? "", /:443\//,
      "Firewall-friendly port 443 relays must survive the 32-candidate cap and be attempted first");
  } finally { await service.close(); }
});

test("without automatic relay configuration, direct mode never contacts the pool", async () => {
  const f = fixture();
  const options = { ...f.options, automaticRelay: undefined };
  const service = await startIncomingPeerService(f.adapter, options);
  try { assert.equal(f.requests.length, 0); assert.equal(f.registrations.length, 0); }
  finally { await service.close(); }
});

test("automatic relay remains available when the local TCP port cannot bind", async () => {
  const f = fixture();
  f.adapter.listenTls = async () => { throw new Error("Synthetic occupied local port"); };
  const service = await startIncomingPeerService(f.adapter, f.options);
  try {
    await until(() => f.requests.some(request => request.init?.method === "POST"));
    assert.equal(service.port, 0);
  } finally { await service.close(); }
});

test("announcement throttling honors Retry-After while keeping the relay registered", async () => {
  const f = fixture();
  const fetch = f.adapter.discoveryFetch;
  let announcements = 0;
  const times: number[] = [];
  f.adapter.discoveryFetch = async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method !== "POST") return response;
    times.push(Date.now());
    return ++announcements === 1 ? { ...response, ok: false, status: 429,
      headers: { "Retry-After": "1" } } : response;
  };
  const service = await startIncomingPeerService(f.adapter, f.options);
  try {
    await until(() => announcements === 2);
    assert.ok(times[1] - times[0] >= 1000);
    assert.equal(f.registrations.length, 1);
  } finally { await service.close(); }
});

test("shutdown cancels a pending relay registration", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  f.adapter.listenRelay = async options => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => options.signal!.addEventListener("abort", () =>
      reject(new Error("Synthetic cancellation")), { once: true }));
    throw new Error("The canceled registration must not complete");
  };
  const service = await startIncomingPeerService(f.adapter, f.options);
  await entered.promise;
  await service.close();
  assert.equal(f.requests.filter(request => request.init?.method === "POST").length, 0);
});

test("automatic relay configuration respects disabled fallback and local-only transports", () => {
  assert.ok(automaticRelayConfiguration({}));
  assert.ok(automaticRelayConfiguration({ discoveryMode: "global" }));
  assert.equal(automaticRelayConfiguration({ enableRelayFallback: false }), undefined);
  assert.equal(automaticRelayConfiguration({ discoveryMode: "lan" }), undefined);
  assert.equal(automaticRelayConfiguration({ discoveryMode: "direct" }), undefined);
  assert.equal(automaticRelayConfiguration({ quicOnly: true }), undefined);
});
