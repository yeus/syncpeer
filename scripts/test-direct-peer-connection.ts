import assert from "node:assert/strict";
import test from "node:test";
import { observePeer } from "../packages/core/src/peerRegistry.ts";
import { createInitialSessionState } from "../packages/core/src/ui/sessionPolicies.ts";
import { createAppBuildInfo } from "../packages/core/src/browser.ts";
import { createConnectionActions } from "../packages/app/src/app/connectionActions.ts";
import { createDeviceActions } from "../packages/app/src/app/deviceActions.ts";
import {
  directTcpEndpointForPeer, rememberAuthenticatedTcpEndpoint,
} from "../packages/app/src/app/devicePolicies.ts";
import {
  applySensitiveAppState, createInitialState, sensitiveAppState,
} from "../packages/app/src/app/state.ts";

const A = "A".repeat(52);
const B = "B".repeat(52);
const saved = (id: string) => ({ id, name: `Peer ${id[0]}`, createdAtMs: Date.now(), isIntroducer: false });

const stateWithPeers = () => {
  const state = createInitialState(null);
  state.devices.savedDevices = [saved(A), saved(B)];
  state.connection.deviceName = "fixture-phone";
  return state;
};

const actionsFor = (
  state: ReturnType<typeof stateWithPeers>,
  onScan: () => Promise<void> = async () => {},
) => {
  const connected: Array<{ id: string; host: string; port: number; mode: string; quic: boolean }> = [];
  let scans = 0;
  const actions = createDeviceActions({
    state,
    client: {} as Parameters<typeof createDeviceActions>[0]["client"],
    sessionStore: {} as Parameters<typeof createDeviceActions>[0]["sessionStore"],
    refreshOverview: async () => {},
    refreshActiveView: async () => {},
    refreshCurrentDeviceId: async () => {},
    connectToDevice: async id => {
      connected.push({ id, host: state.connection.host, port: state.connection.port,
        mode: state.connection.discoveryMode, quic: state.connection.quicOnly });
    },
    discoverLocalDevices: async () => { scans++; await onScan(); },
  });
  return { actions, connected, scans: () => scans };
};

test("saved peer Direct TCP reuses only that peer's LAN IPv4 endpoint and bypasses scanning", async () => {
  const state = stateWithPeers();
  state.connection.remoteId = B;
  state.connection.discoveryMode = "direct";
  state.connection.host = "10.1.2.30";
  state.devices.peerDiscovery = observePeer({}, A, {
    kind: "lan", addresses: ["quic://192.168.1.20:22000", "tcp://192.168.1.20:23000",
      "tcp://[fe80::1]:22000", "tcp://203.0.113.9:22000"],
    lastSeenAtMs: Date.now(),
  });
  const { actions, connected, scans } = actionsFor(state);
  await actions.connectSavedDeviceDirectTcp(A);
  assert.equal(scans(), 0);
  assert.deepEqual(connected, [{ id: A, host: "192.168.1.20", port: 23000,
    mode: "direct", quic: false }]);
  assert.equal(state.devices.selectedSavedDeviceId, A);
  assert.equal(state.devices.directTcpPreparingDeviceId, "");
});

test("Direct TCP scans once for the selected peer then dials the discovered address", async () => {
  const state = stateWithPeers();
  const { actions, connected, scans } = actionsFor(state, async () => {
    state.devices.lanDiscoveryByDeviceId[A] = { addresses: ["tcp://172.20.1.17:22000"],
      lastSeenAtMs: Date.now() };
  });
  await actions.connectSavedDeviceDirectTcp(A);
  assert.equal(scans(), 1);
  assert.equal(connected[0]?.host, "172.20.1.17");
  assert.equal(connected[0]?.id, A);
});

test("missing LAN address opens Direct TCP host settings without dialing or borrowing another peer", async () => {
  const state = stateWithPeers();
  state.connection.remoteId = B;
  state.connection.discoveryMode = "direct";
  state.connection.host = "192.168.1.200";
  state.devices.peerDiscovery = observePeer({}, B, {
    kind: "verified", addresses: ["tcp://192.168.1.200:22000"], lastSeenAtMs: Date.now(),
  });
  const { actions, connected, scans } = actionsFor(state);
  await actions.connectSavedDeviceDirectTcp(A);
  assert.equal(scans(), 1);
  assert.deepEqual(connected, []);
  assert.equal(state.connection.remoteId, A);
  assert.equal(state.connection.host, "");
  assert.equal(state.connection.discoveryMode, "direct");
  assert.match(state.devices.directTcpNotice, /No recent LAN IPv4 address/);
});

test("outdated, WAN, link-local, QUIC and malformed addresses cannot be chosen as LAN direct TCP", () => {
  const state = stateWithPeers();
  const now = Date.now();
  state.devices.peerDiscovery = observePeer({}, A, {
    kind: "lan", addresses: ["tcp://8.8.8.8:22000", "tcp://169.254.10.2:22000",
      "tcp://256.0.0.1:22000", "quic://192.168.1.9:22000"], lastSeenAtMs: now,
  });
  assert.equal(directTcpEndpointForPeer(state, A, now), null);
  state.devices.peerDiscovery = observePeer({}, A, {
    kind: "lan", addresses: ["tcp://10.0.0.5:22000"], lastSeenAtMs: now - 25 * 60 * 60 * 1000,
  });
  assert.equal(directTcpEndpointForPeer(state, A, now), null);
});

test("authenticated TCP endpoint persists encrypted per peer for later one-click direct connections", () => {
  const state = stateWithPeers();
  state.connection.remoteId = A;
  state.session.isConnected = true;
  state.session.connectionTransport = "direct-tcp";
  state.session.connectionPath = "tcp://192.168.44.2:22001";
  rememberAuthenticatedTcpEndpoint(state, A);
  assert.deepEqual(state.devices.peerDiscovery[A]?.sources[0]?.addresses, ["tcp://192.168.44.2:22001"]);
  state.session.isConnected = false;
  assert.deepEqual(directTcpEndpointForPeer(state, A), { host: "192.168.44.2", port: 22001 });
  assert.equal(directTcpEndpointForPeer(state, B), null);
  const restored = stateWithPeers();
  assert.equal(applySensitiveAppState(restored, JSON.parse(JSON.stringify(sensitiveAppState(state)))), true);
  assert.deepEqual(directTcpEndpointForPeer(restored, A), { host: "192.168.44.2", port: 22001 });
  assert.equal(directTcpEndpointForPeer(restored, B), null);
});

test("unavailable encrypted vault does not accept an unsaved discovered peer", () => {
  const state = createInitialState(null);
  state.ui.storageUnavailable = true;
  state.devices.newSavedDeviceId = A;
  state.devices.newSavedDeviceCustomName = "Synthetic discovered peer";
  const { actions, connected } = actionsFor(state);
  actions.addSavedDevice();
  assert.equal(state.devices.savedDevices.length, 0,
    "A newly discovered peer must not become a phantom saved entry while storage is unreadable.");
  assert.equal(state.devices.newSavedDeviceId, A,
    "The user's proposed device ID should remain available to add after recovery.");
  assert.deepEqual(connected, []);
  assert.match(state.ui.recentError ?? "", /Encrypted local storage is unavailable/);
  assert.equal(state.logs.items.some(value => value.event === "peer.add.blocked_local_storage"), true);
});

test("unreadable encrypted peer roster pauses auto-connect and does not blame the remote", async () => {
  const state = stateWithPeers();
  state.ui.deviceNameConfirmed = true;
  state.connection.remoteId = A;
  const unavailable = new Error(
    "Encrypted peer permissions are unavailable. Restore local storage before connecting.");
  unavailable.name = "ProtectedPeerRosterUnavailableError";
  const sessionStore = {
    actions: {
      setFolderPasswords: async () => {},
      connect: async () => { throw unavailable; },
      disconnect: async () => {},
    },
    getState: createInitialSessionState,
  } as unknown as Parameters<typeof createConnectionActions>[0]["sessionStore"];
  const connection = createConnectionActions({
    state,
    client: {} as Parameters<typeof createConnectionActions>[0]["client"],
    sessionStore,
    transfers: { transferInProgress: () => false } as Parameters<typeof createConnectionActions>[0]["transfers"],
    syncStarredFiles: async () => {},
    loadFavoriteSyncStates: async () => {},
    appInfo: createAppBuildInfo({
      appVersion: "test", coreVersion: "test", buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z", buildMode: "development",
      runtimeEnvironment: "tauri", runtimeSurface: "android-ui",
      platform: "android", architecture: "arm64", osVersion: "synthetic",
    }),
  });
  await connection.connect(A);
  assert.equal(state.ui.autoConnectPaused, true);
  assert.equal(state.ui.recentError, unavailable.message);
  assert.equal(state.approvals.pendingApprovalPromptDeviceId, "");
  assert.equal(state.logs.items.some(entry => entry.event === "peer.connect.blocked_local_storage"), true);
  assert.equal(state.logs.items.some(entry => entry.event === "peer.connect.attempt_failed"), false,
    "Vault failures are not remote network or approval failures.");
});

test("selecting Direct TCP for an already-dialing peer replaces the automatic attempt", async () => {
  const state = stateWithPeers();
  state.ui.deviceNameConfirmed = true;
  state.connection.remoteId = A;
  state.connection.discoveryMode = "automatic";
  state.devices.peerDiscovery = observePeer({}, A, {
    kind: "lan", addresses: ["tcp://192.168.9.15:22000"], lastSeenAtMs: Date.now(),
  });
  const attempts: string[] = [];
  let cancelFirst: ((reason: Error) => void) | undefined;
  const sessionStore = {
      actions: {
        setFolderPasswords: async () => {},
        connect: async (options: { discoveryMode: string }) => {
          attempts.push(`connect:${options.discoveryMode}`);
          if (attempts.length === 1) {
            await new Promise<void>((_resolve, reject) => { cancelFirst = reject; });
          } else {
            throw new Error("fixture second dial completed");
          }
        },
        disconnect: async () => {
          attempts.push("disconnect");
          cancelFirst?.(new Error("fixture cancelled"));
        },
      },
      getState: createInitialSessionState,
  } as unknown as Parameters<typeof createConnectionActions>[0]["sessionStore"];
  const client = {} as Parameters<typeof createConnectionActions>[0]["client"];
  const connection = createConnectionActions({
    state, client, sessionStore,
    transfers: { transferInProgress: () => false } as Parameters<typeof createConnectionActions>[0]["transfers"],
    syncStarredFiles: async () => {},
    loadFavoriteSyncStates: async () => {},
    appInfo: createAppBuildInfo({
      appVersion: "test", coreVersion: "test", buildCommit: "test",
      buildTimeUtc: "2026-01-01T00:00:00.000Z", buildMode: "development",
      runtimeEnvironment: "tauri", runtimeSurface: "android-ui", platform: "android",
      architecture: "arm64", osVersion: "synthetic",
    }),
  });
  const devices = createDeviceActions({
    state, client, sessionStore,
    refreshOverview: connection.refreshOverview,
    refreshActiveView: connection.refreshActiveView,
    refreshCurrentDeviceId: connection.refreshCurrentDeviceId,
    connectToDevice: connection.connect,
    discoverLocalDevices: connection.discoverLocalDevices,
  });
  const original = connection.connect(A);
  await new Promise(resolve => setImmediate(resolve));
  await devices.connectSavedDeviceDirectTcp(A);
  await Promise.allSettled([original]);
  assert.deepEqual(attempts, ["connect:automatic", "disconnect", "connect:direct"]);
  assert.equal(state.connection.host, "192.168.9.15");
});
