import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionActions } from "../packages/app/src/app/connectionActions.ts";
import { createInitialState, isLanDiscoveredDevice } from "../packages/app/src/app/state.ts";

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

test("a device announcing itself on the LAN still reaches the device list", async () => {
  const state = createInitialState(null);
  const actions = createConnectionActions({
    state,
    client: {
      discoverLocalDevices: async () => [
        { deviceId: LAN_PEER, addresses: ["tcp://192.0.2.7:22000"] },
        { deviceId: "LAN-ANONYMOUS-1", addresses: ["tcp://192.0.2.8:22000"], anonymous: true },
      ],
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
  assert.ok(state.devices.savedDevices.some(device => device.id === LAN_PEER),
    "A discovered peer must be offerable as a device to add.");
  assert.equal(state.devices.lanAnonymousCandidates.length, 1);
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
