import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionActions } from "../packages/app/src/app/connectionActions.ts";
import { createDeviceActions } from "../packages/app/src/app/deviceActions.ts";
import { createInitialState, isLanDiscoveredDevice } from "../packages/app/src/app/state.ts";
import { hasAutoConnectTarget } from "../packages/app/src/app/syncPolicies.ts";
import { createInitialSessionState } from "../packages/core/src/ui/sessionPolicies.ts";

const LAN_PEER = "RXB676UZHQX3SONXROHZ7M3DY2VEMB6LCGQCAG5QJ2VIEDX4RIUQ";
const OWNED_PEER = "55KM6B52CSRRQAU2L3GEFJBAE6MLYK4BH25GIQW3ULKGAZYHKTGA";

type Call = { command: string; args?: Record<string, unknown> };

const installFakeTauri = (respond: (call: Call) => unknown) => {
  const calls: Call[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
  });
  Object.defineProperty(globalThis, "__TAURI__", {
    configurable: true,
    value: {
      core: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          const call = { command, args };
          calls.push(call);
          return respond(call);
        },
      },
    },
  });
  return calls;
};

const { createTauriAdapters } = await import("../packages/app/src/lib/tauriAdapters.ts");

const documentOperations = (calls: Call[]) => calls
  .filter(call => call.command === "syncpeer_document_command")
  .map(call => (call.args?.request as { operation?: string } | undefined)?.operation ?? "");

const discoveryPayload = () => ({
  candidates: [{
    address: `tcp://192.0.2.7:22000`,
    protocol: "tcp",
    host: "192.0.2.7",
    port: 22000,
    deviceId: LAN_PEER,
  }],
  diagnostics: {
    timeoutMs: 50, socketsBound: 2, bindErrors: [], packetsReceived: 1,
    packetsBySocketUdp4: 1, packetsBySocketUdp6: 0, packetsMagicMismatch: 0,
    packetsDecodeFailed: 0, packetsMissingId: 0, packetsFilteredExpectedId: 0,
    announcementsAccepted: 1, discoveredDeviceIds: [LAN_PEER],
    syncthingLanAvailable: true, syncpeerLanActive: true,
    statusMessage: "LAN discovery active",
  },
});

test("the trust roster is read once and reused across connects", async () => {
  const calls = installFakeTauri(() => ({ result: { devices: [{ syncthingId: OWNED_PEER }] } }));
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  const first = await adapters.platformAdapter.ownedDevices!();
  const second = await adapters.platformAdapter.ownedDevices!();
  assert.deepEqual(first, second);
  assert.equal(documentOperations(calls).filter(operation => operation === "ownedDevices").length, 1,
    "The second connect must reuse the cached trust roster.");
});

test("a membership change invalidates the cached trust roster", async () => {
  let roster = [{ syncthingId: OWNED_PEER }];
  const calls = installFakeTauri(({ command, args }) => {
    const operation = (args?.request as { operation?: string } | undefined)?.operation;
    if (command === "syncpeer_document_command" && operation === "revokeOwnedDevice") {
      roster = [];
      return { result: null };
    }
    if (command === "syncpeer_document_command" && operation === "ownedDevices") {
      return { result: { devices: roster } };
    }
    return { result: null };
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  assert.deepEqual(await adapters.platformAdapter.ownedDevices!(), [{ syncthingId: OWNED_PEER }]);
  await adapters.documentCommand({ operation: "revokeOwnedDevice", deviceId: OWNED_PEER });
  // A stale cache here would keep accepting a peer whose membership was just revoked.
  assert.deepEqual(await adapters.platformAdapter.ownedDevices!(), []);
  assert.equal(documentOperations(calls).filter(operation => operation === "ownedDevices").length, 2,
    "Revoking a device must force the next connect to re-read the roster.");
});

test("a failed trust-roster read is not cached", async () => {
  let failNext = true;
  const calls = installFakeTauri(({ args }) => {
    const operation = (args?.request as { operation?: string } | undefined)?.operation;
    if (operation === "ownedDevices" && failNext) {
      failNext = false;
      throw new Error("Document runtime unavailable.");
    }
    return { result: { devices: [] } };
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  await assert.rejects(adapters.platformAdapter.ownedDevices!(), /unavailable/);
  assert.deepEqual(await adapters.platformAdapter.ownedDevices!(), []);
  assert.equal(documentOperations(calls).filter(operation => operation === "ownedDevices").length, 2,
    "A transient failure must not be remembered as an empty trust roster.");
});

test("LAN announcements are still discovered while the roster is cached", async () => {
  const calls = installFakeTauri(({ command }) => {
    if (command === "syncpeer_android_enable_multicast_lock") return true;
    if (command === "syncpeer_discovery_local") return discoveryPayload();
    if (command === "syncpeer_document_command") return { result: { devices: [] } };
    return null;
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  await adapters.platformAdapter.ownedDevices!();
  const candidates = await adapters.hostAdapter.discoverLocalCandidates!({ expectedDeviceId: "", timeoutMs: 50 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.deviceId, LAN_PEER);
  assert.equal(calls.some(call => call.command === "syncpeer_discovery_local"), true);
});

test("LAN discovery does not create saved or auto-connect targets, even when announcements disappear", async () => {
  const state = createInitialState(null);
  let discoveryRound = 0;
  const actions = createConnectionActions({
    state,
    client: {
      discoverLocalDevices: async () => ++discoveryRound === 1 ? [
        { deviceId: LAN_PEER, addresses: ["tcp://192.0.2.7:22000"] },
        { deviceId: "LAN-ANONYMOUS-1", addresses: ["tcp://192.0.2.8:22000"], anonymous: true },
      ] : [],
    } as never,
    sessionStore: {} as never,
    transfers: { transferInProgress: () => false } as never,
    syncStarredFiles: async () => undefined,
    loadFavoriteSyncStates: async () => undefined,
    appInfo: { appName: "Syncpeer" } as never,
  });
  await actions.discoverLocalDevices({ timeoutMs: 10 });
  assert.equal(isLanDiscoveredDevice(state, LAN_PEER), true,
    "A discovered peer must stay visible even though it is not in the trusted roster yet.");
  assert.ok(state.devices.lanDiscoveryByDeviceId[LAN_PEER],
    "An observed LAN peer must remain available as a selectable candidate.");
  assert.ok(!state.devices.savedDevices.some(device => device.id === LAN_PEER),
    "Observing an unauthenticated LAN advertisement must not save the device.");
  assert.equal(hasAutoConnectTarget(state), false,
    "A fresh installation must not begin connecting just because a peer announces itself.");
  assert.equal(state.devices.lanAnonymousCandidates.length, 1);
  await actions.discoverLocalDevices({ timeoutMs: 10 });
  assert.equal(state.devices.lanDiscoveredDeviceIds.size, 0);
  assert.deepEqual(state.devices.savedDevices, []);
  assert.equal(hasAutoConnectTarget(state), false,
    "A temporarily missing LAN broadcast must not turn a candidate into an auto-connect target.");
});

test("Use explicitly selects a discovered device even while a connect is pending", () => {
  const state = createInitialState(null);
  state.session.isConnecting = true;
  state.devices.lanDiscoveryByDeviceId[LAN_PEER] = {
    addresses: ["tcp://192.0.2.7:22000"], lastSeenAtMs: 0,
  };
  const selected: string[] = [];
  const actions = createDeviceActions({
    state,
    client: {} as never,
    sessionStore: {} as never,
    refreshOverview: async () => undefined,
    refreshActiveView: async () => undefined,
    refreshCurrentDeviceId: async () => undefined,
    connectToDevice: async id => { selected.push(id); },
  });
  actions.useSavedDevice(LAN_PEER);
  assert.deepEqual(selected, [LAN_PEER]);
  assert.equal(state.devices.selectedSavedDeviceId, LAN_PEER);
  assert.equal(state.connection.remoteId, LAN_PEER);
  assert.equal(hasAutoConnectTarget(state), true);
  assert.ok(state.devices.savedDevices.some(device => device.id === LAN_PEER));
});


test("removing an active peer drops confirmed trust and stops its connection", async () => {
  const state = createInitialState(null);
  state.devices.savedDevices = [{
    id: LAN_PEER, name: "Synthetic peer", isIntroducer: false, createdAtMs: Date.now(),
  }];
  state.devices.confirmedPeerIds.add(LAN_PEER);
  state.connection.remoteId = LAN_PEER;
  state.session.isConnected = true;
  let disconnected = 0;
  const actions = createDeviceActions({
    state, client: {} as never, sessionStore: {} as never,
    refreshOverview: async () => undefined, refreshActiveView: async () => undefined,
    refreshCurrentDeviceId: async () => undefined,
    connectToDevice: async () => undefined,
    disconnectPeer: async () => { disconnected += 1; },
  });
  actions.removeSavedDevice(LAN_PEER);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(disconnected, 1);
  assert.equal(state.connection.remoteId, "");
  assert.equal(state.devices.confirmedPeerIds.has(LAN_PEER), false);
  assert.equal(hasAutoConnectTarget(state), false);
});

test("only explicitly configured devices qualify for automatic reconnection", () => {
  const state = createInitialState(null);
  state.connection.remoteId = LAN_PEER;
  assert.equal(hasAutoConnectTarget(state), false);
  state.devices.savedDevices = [{
    id: OWNED_PEER, name: "Another peer", isIntroducer: false, createdAtMs: Date.now(),
  }];
  assert.equal(hasAutoConnectTarget(state), false);
  state.devices.selectedSavedDeviceId = OWNED_PEER;
  state.connection.remoteId = "";
  assert.equal(hasAutoConnectTarget(state), true);
});
test("a new peer selection cancels an in-flight connection before switching", async () => {
  const state = createInitialState(null);
  state.connection.deviceName = "Synthetic Android peer";
  state.ui.deviceNameConfirmed = true;
  const attempted: string[] = [];
  let cancelFirst: (() => void) | null = null;
  const sessionStore = {
    actions: {
      setFolderPasswords: async () => undefined,
      disconnect: async () => { cancelFirst?.(); },
      connect: async ({ remoteId }: { remoteId?: string }) => {
        attempted.push(remoteId ?? "");
        if (attempted.length === 1) {
          await new Promise<void>((_resolve, reject) => {
            cancelFirst = () => reject(new Error("Connection attempt was cancelled."));
          });
        }
      },
    },
    getState: () => ({ ...createInitialSessionState(), phase: "connected", remoteFs: {} }),
  };
  const actions = createConnectionActions({
    state, client: {} as never, sessionStore: sessionStore as never,
    transfers: { transferInProgress: () => false } as never,
    syncStarredFiles: async () => undefined, loadFavoriteSyncStates: async () => undefined,
    appInfo: { appName: "Syncpeer" } as never,
  });
  const first = actions.connect(OWNED_PEER);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(attempted, [OWNED_PEER]);
  await actions.connect(LAN_PEER);
  await first;
  assert.deepEqual(attempted, [OWNED_PEER, LAN_PEER]);
  assert.equal(state.connection.remoteId, LAN_PEER);
});

test("second peer dials after disconnect even if the first native connect promise never settled", async () => {
  const state = createInitialState({ deviceName: "Device" });
  const attempts: string[] = [];
  let finishFirst!: () => void;
  let disconnects = 0;
  const sessionStore = {
    actions: {
      setFolderPasswords: async () => undefined,
      disconnect: async () => { disconnects++; },
      connect: async ({ remoteId }: { remoteId?: string }) => {
        attempts.push(remoteId ?? "");
        if (attempts.length === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
      },
    },
    getState: () => ({ ...createInitialSessionState(), phase: "connected", remoteFs: {} }),
  };
  const actions = createConnectionActions({
    state, client: {} as never, sessionStore: sessionStore as never,
    transfers: { transferInProgress: () => false } as never,
    syncStarredFiles: async () => undefined, loadFavoriteSyncStates: async () => undefined,
    appInfo: { appName: "Syncpeer" } as never,
  });
  const first = actions.connect(OWNED_PEER);
  await new Promise<void>(resolve => setImmediate(resolve));
  await actions.connect(LAN_PEER);
  assert.deepEqual(attempts, [OWNED_PEER, LAN_PEER]);
  assert.equal(disconnects, 1);
  finishFirst();
  await first;
  assert.equal(state.connection.remoteId, LAN_PEER,
    "A stale response must not overwrite the later peer selection.");
});

test("an unpaired peer fails safely without repeated automatic reconnects", async () => {
  const state = createInitialState(null);
  state.connection.deviceName = "Synthetic Android peer";
  state.ui.deviceNameConfirmed = true;
  const actions = createConnectionActions({
    state, client: {} as never,
    sessionStore: {
      actions: {
        setFolderPasswords: async () => undefined,
        connect: async () => { throw new Error("This peer is not paired. Pair it in General settings."); },
      },
    } as never,
    transfers: { transferInProgress: () => false } as never,
    syncStarredFiles: async () => undefined, loadFavoriteSyncStates: async () => undefined,
    appInfo: { appName: "Syncpeer" } as never,
  });
  await actions.connect(LAN_PEER);
  assert.equal(state.ui.autoConnectPaused, true);
  assert.match(state.ui.recentError ?? "", /not paired/);
});

test("the background session request reads profile settings once", async () => {
  const calls = installFakeTauri(({ command, args }) => {
    const operation = (args?.request as { operation?: string } | undefined)?.operation;
    if (command === "syncpeer_document_command" && operation === "profileSettings") {
      return { result: { profile: { allowMetered: true, keepSyncingInBackground: true } } };
    }
    if (command === "syncpeer_android_prepare_background_session") return null;
    return { result: null };
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  const options = { host: "127.0.0.1", port: 22000, deviceName: "synthetic" } as never;
  await adapters.platformAdapter.prepareBackgroundSession!(options);
  await adapters.platformAdapter.prepareBackgroundSession!(options);
  assert.equal(documentOperations(calls).filter(operation => operation === "profileSettings").length, 1,
    "Arming the background session must not re-read profile settings each time.");
  const requests = calls
    .filter(call => call.command === "syncpeer_android_prepare_background_session")
    .map(call => (call.args?.request as { options?: { allowMetered?: boolean } } | undefined)?.options);
  assert.deepEqual(requests.map(request => request?.allowMetered), [true, true]);
});

test("changing profile settings refreshes the metered policy", async () => {
  let allowMetered = true;
  const calls = installFakeTauri(({ command, args }) => {
    const operation = (args?.request as { operation?: string } | undefined)?.operation;
    if (command === "syncpeer_document_command" && operation === "profileSettings") {
      return { result: { profile: { allowMetered, keepSyncingInBackground: true } } };
    }
    if (command === "syncpeer_document_command" && operation === "saveProfileSettings") {
      allowMetered = false;
      return { result: null };
    }
    return { result: null };
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  const options = { host: "127.0.0.1", port: 22000, deviceName: "synthetic" } as never;
  await adapters.platformAdapter.prepareBackgroundSession!(options);
  await adapters.documentCommand({ operation: "saveProfileSettings", settings: { profile: { keepSyncingInBackground: true } } });
  await adapters.platformAdapter.prepareBackgroundSession!(options);
  assert.equal(documentOperations(calls).filter(operation => operation === "profileSettings").length, 2,
    "Saving profile settings must force the next request to re-read the policy.");
  const last = calls.filter(call => call.command === "syncpeer_android_prepare_background_session").at(-1);
  assert.equal((last?.args?.request as { options?: { allowMetered?: boolean } }).options?.allowMetered, false);
});

test("a locked vault does not pin metered networking off", async () => {
  let locked = true;
  const calls = installFakeTauri(({ command, args }) => {
    const operation = (args?.request as { operation?: string } | undefined)?.operation;
    if (command === "syncpeer_document_command" && operation === "profileSettings") {
      if (locked) throw new Error("Vault is locked.");
      return { result: { profile: { allowMetered: true, keepSyncingInBackground: true } } };
    }
    return { result: null };
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  const options = { host: "127.0.0.1", port: 22000, deviceName: "synthetic" } as never;
  await adapters.platformAdapter.prepareBackgroundSession!(options);
  locked = false;
  await adapters.platformAdapter.prepareBackgroundSession!(options);
  const requests = calls
    .filter(call => call.command === "syncpeer_android_prepare_background_session")
    .map(call => (call.args?.request as { options?: { allowMetered?: boolean } } | undefined)?.options);
  assert.deepEqual(requests.map(request => request?.allowMetered), [true],
    "A locked vault must not opt into background sync; after unlock it respects the saved policy.");
});

test("Android folder sharing mutations invalidate prepared peer views after success", async () => {
  installFakeTauri(() => ({ result: null }));
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  const revision = adapters.platformAdapter.sessionConfigurationRevision!();

  await adapters.documentCommand({ operation: "register", id: "synthetic", label: "Synthetic folder" });
  await adapters.documentCommand({ operation: "attachDownloads", id: "synthetic" });

  // register publishes folder credentials and attachDownloads changes the
  // exported folder set: suppressing either invalidation would be unsafe.
  assert.equal(adapters.platformAdapter.sessionConfigurationRevision!(), revision + 2);
  await adapters.documentCommand({ operation: "status" });
  await adapters.documentCommand({ operation: "cachedStatuses", folderId: "synthetic", paths: [] });
  assert.equal(adapters.platformAdapter.sessionConfigurationRevision!(), revision + 2,
    "Read-only document operations must not reconnect the peer.");
});

test("failed Android folder mutation must not invalidate a live session", async () => {
  installFakeTauri(({ args }) => {
    if ((args?.request as { operation?: string } | undefined)?.operation === "attachDownloads") {
      throw new Error("Synthetic storage failure.");
    }
    return { result: null };
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  const revision = adapters.platformAdapter.sessionConfigurationRevision!();
  await assert.rejects(adapters.documentCommand({ operation: "attachDownloads", id: "synthetic" }),
    /Synthetic storage failure/);
  assert.equal(adapters.platformAdapter.sessionConfigurationRevision!(), revision,
    "A rejected mutation cannot change advertised peer folders.");
});

test("Android UI can query its service-owned peer without dialing another peer", async () => {
  const calls = installFakeTauri(({ command, args }) => {
    if (command === "syncpeer_android_session_command") {
      return { result: { phase: (args?.request as { operation: string }).operation } };
    }
    throw new Error("Unexpected native command: " + command);
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  const service = adapters.platformAdapter.serviceSessionCommand!;
  assert.deepEqual(await service({ operation: "status" }), { phase: "status" });
  assert.deepEqual(await service({ operation: "overview" }), { phase: "overview" });
  assert.deepEqual(calls.map(call => call.command),
    ["syncpeer_android_session_command", "syncpeer_android_session_command"]);
});
test("background opt-out stops the single native session without restarting a peer", async () => {
  const calls = installFakeTauri(({ command, args }) => {
    if (command === "syncpeer_document_command" &&
      (args?.request as { operation?: string })?.operation === "profileSettings") {
      return { result: { profile: { allowMetered: false, keepSyncingInBackground: false } } };
    }
    if (command === "syncpeer_android_session_command") return { result: { phase: "idle" } };
    if (command === "syncpeer_android_start_background_session") {
      throw Error("Background service must not be started without opt-in.");
    }
    return { result: null };
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  await adapters.platformAdapter.startBackgroundSession!({
    host: "127.0.0.1", port: 22000, remoteId: LAN_PEER,
  });
  assert.ok(calls.some(call => call.command === "syncpeer_android_stop_background_session"));
  assert.ok(!calls.some(call => call.command === "syncpeer_android_start_background_session"));
});
test("turning off background sync disarms restart without interrupting the visible peer", async () => {
  const calls = installFakeTauri(({ command, args }) => {
    if (command === "syncpeer_document_command" &&
      (args?.request as { operation?: string })?.operation === "saveProfileSettings") {
      return { result: null };
    }
    if (command === "syncpeer_android_session_command") return { result: { disarmed: true } };
    if (command === "syncpeer_android_stop_background_session") {
      throw Error("Saving the preference must not disconnect the visible peer.");
    }
    return { result: null };
  });
  const adapters = createTauriAdapters({ runtimePlatform: "android" });
  await adapters.documentCommand({ operation: "saveProfileSettings",
    settings: { profile: { keepSyncingInBackground: false } } });
  assert.equal(calls.filter(call => call.command === "syncpeer_android_session_command" &&
    (call.args?.request as { operation?: string })?.operation === "disarmBackground").length, 1);
});
