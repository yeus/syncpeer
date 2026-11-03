import assert from "node:assert/strict";
import test from "node:test";
import {
  expirePeerDiscovery, normalizePeerDiscovery, observePeer, peerRegistryViews,
  PEER_DISCOVERY_RETENTION_MS,
} from "../packages/core/src/peerRegistry.ts";

const A = "RXB676UZHQX3SONXROHZ7M3DY2VEMB6LCGQCAG5QJ2VIEDX4RIUQ";
const B = "55KM6B52CSRRQAU2L3GEFJBAE6MLYK4BH25GIQW3ULKGAZYHKTGA";
const T = 1_790_000_000_000;

test("LAN, introductions and manual configuration remain independent provenance", () => {
  let registry = observePeer({}, A, { kind: "lan", addresses: ["tcp://192.0.2.1:22000"], lastSeenAtMs: T });
  registry = observePeer(registry, A, { kind: "introduced", sourceDeviceId: B, folderIds: ["photos"],
    lastSeenAtMs: T + 1000 });
  registry = observePeer(registry, A, { kind: "manual", lastSeenAtMs: T + 2000 });
  assert.deepEqual(registry[A].sources.map(item => item.kind), ["manual", "introduced", "lan"]);
  assert.deepEqual(registry[A].sources[1].folderIds, ["photos"]);
  assert.equal(registry[A].sources[1].sourceDeviceId, B);
});

test("24-hour discovery expiry is strict and manual peer remains", () => {
  const registry = observePeer(observePeer({}, A, { kind: "lan", lastSeenAtMs: T }),
    A, { kind: "manual", lastSeenAtMs: T });
  const expired = expirePeerDiscovery(registry, T + PEER_DISCOVERY_RETENTION_MS);
  assert.deepEqual(expired[A].sources.map(item => item.kind), ["manual"]);
  assert.deepEqual(expirePeerDiscovery(
    observePeer({}, A, { kind: "lan", lastSeenAtMs: T }), T + PEER_DISCOVERY_RETENTION_MS,
  ), {});
});

test("multiple observations update one source without creating duplicates", () => {
  let registry = observePeer({}, A, { kind: "lan", addresses: ["tcp://192.0.2.1:22000"], lastSeenAtMs: T });
  const unchanged = observePeer(registry, A, {
    kind: "lan", addresses: ["tcp://192.0.2.1:22000"], lastSeenAtMs: T + 10_000,
  });
  assert.equal(unchanged, registry, "avoid encrypted state writes on every LAN poll");
  registry = observePeer(unchanged, A, {
    kind: "lan", addresses: ["tcp://192.0.2.2:22000"], lastSeenAtMs: T + 10_000,
  });
  assert.equal(registry[A].sources.length, 1);
  assert.deepEqual(registry[A].sources[0].addresses, ["tcp://192.0.2.2:22000"]);
});

test("different introducers remain separate and expiration removes just stale evidence", () => {
  let registry = observePeer({}, A, { kind: "introduced", sourceDeviceId: B, lastSeenAtMs: T });
  registry = observePeer(registry, A, { kind: "introduced", sourceDeviceId: A, lastSeenAtMs: T + 100 });
  assert.equal(registry[A].sources.length, 2);
  const kept = expirePeerDiscovery(registry, T + PEER_DISCOVERY_RETENTION_MS + 1);
  assert.equal(kept[A].sources.length, 1);
  assert.equal(kept[A].sources[0].sourceDeviceId, A);
});

test("normalization is bounded and rejects invalid device identities and unsafe stored records", () => {
  const registry = observePeer({}, "FAKE", { kind: "lan", lastSeenAtMs: T });
  assert.deepEqual(registry, {});
  const parsed = normalizePeerDiscovery({
    [A]: { deviceId: A, sources: [
      { kind: "lan", addresses: ["tcp://192.0.2.1:22000"], lastSeenAtMs: T },
      { kind: "incoming", lastSeenAtMs: T },
      { kind: "untrusted-admin", lastSeenAtMs: T },
      { kind: "manual", addresses: [null], lastSeenAtMs: T },
    ] },
  }, T + 1_000);
  assert.deepEqual(parsed[A].sources.map(item => item.kind), ["lan", "incoming"]);
});

test("unconfigured discovery is not approval and a configured peer is one list item", () => {
  let registry = observePeer({}, A, { kind: "lan", lastSeenAtMs: T });
  registry = observePeer(registry, A, { kind: "introduced", sourceDeviceId: B, lastSeenAtMs: T });
  const view = peerRegistryViews({
    saved: [], discovery: registry,
    advertised: [{ id: A, name: "Desktop", sourceFolderIds: ["photos"] }],
    nowMs: T + 1,
  });
  assert.equal(view.length, 1);
  assert.equal(view[0].configured, false);
  assert.equal(view[0].name, "Desktop");
  const configured = peerRegistryViews({
    saved: [{ id: A, name: "My Desktop" }], discovery: registry,
    advertised: [{ id: A, name: "Desktop", sourceFolderIds: ["photos"] }],
    connectedDeviceId: A, nowMs: T + 1,
  });
  assert.equal(configured.length, 1);
  assert.equal(configured[0].configured, true);
  assert.equal(configured[0].connected, true);
  assert.equal(configured[0].sources.length, 2);
});

test("recent authenticated incoming attempt remains a pending candidate, not a configured peer", () => {
  const registry = observePeer({}, A, { kind: "incoming", lastSeenAtMs: T });
  const view = peerRegistryViews({ saved: [], discovery: registry, advertised: [], nowMs: T + 1 });
  assert.equal(view.length, 1);
  assert.equal(view[0].configured, false);
  assert.equal(view[0].sources[0].kind, "incoming");
});
test("authenticated BEP confirmation distinguishes mutually configured peers", () => {
  const args = { saved: [{ id: A, name: "Desktop" }], discovery: {}, advertised: [] };
  assert.equal(peerRegistryViews({ ...args, nowMs: T })[0].confirmed, false);
  assert.equal(peerRegistryViews({ ...args, confirmedDeviceIds: new Set([A]), nowMs: T })[0].confirmed, true);
  assert.equal(peerRegistryViews({ ...args, connectedDeviceId: A, nowMs: T })[0].confirmed, true);
  assert.equal(peerRegistryViews({ ...args, saved: [], confirmedDeviceIds: new Set([A]), nowMs: T }).length, 0);
});
