import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeDeviceId } from "../packages/core/dist/core/transport/node.js";
import { createNodeHostAdapter } from "../packages/core/dist/node.js";
import { createSyncpeerBrowserClient } from "../packages/core/dist/ui/browserClient.js";
import { createSyncpeerCoreClient, type SyncpeerSessionHandle } from "../packages/core/dist/client.js";
import { useTemporaryMetadataRoot } from "./node-storage-fixture.ts";
import { createOwnedDeviceIdentity, openOwnedDeviceSigningKey, signSpaceMembershipUpdate } from
  "../packages/core/dist/sync/personalSpaceSharing.js";

useTemporaryMetadataRoot();

const identity = async (root: string, name: string) => {
  const cert = path.join(root, `${name}.pem`), key = path.join(root, `${name}.key`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-days", "1", "-subj", "/CN=synthetic-browser-pair", "-keyout", key, "-out", cert],
  { stdio: "ignore" });
  const certPem = await readFile(cert, "utf8");
  return { certPem, keyPem: await readFile(key, "utf8"),
    deviceId: computeDeviceId(new X509Certificate(certPem).raw) };
};

test("invalid invitation setup never leaks an incoming listener", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-pairing-failure-"));
  let listening = false;
  const accepting = Promise.withResolvers<never>();
  const ownerIdentity = await identity(root, "owner");
  const owner = createSyncpeerBrowserClient({ hostAdapter: {
    ...createNodeHostAdapter(),
    listenTls: async () => { listening = true; return {
      port: 22000, accept: () => accepting.promise,
      close: async () => { listening = false; accepting.reject(new Error("Listener closed")); },
    }; },
  }, platformAdapter: { readDefaultIdentity: async () => ownerIdentity,
    exportPairingTransfer: async () => { throw new Error("Not reached"); },
  } });
  try {
    await assert.rejects(owner.startPairingInvitation({ advertisedHost: "https://invalid.example",
      confirm: async () => true }), /advertised pairing address/);
    assert.equal(listening, false);
    await assert.rejects(owner.startPairingInvitation({ advertisedHost: "127.0.0.1",
      expiresInMs: -1, confirm: async () => true }));
    assert.equal(listening, false);
  } finally {
    await owner.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

test("a service-owned Android session does not start a competing UI listener", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-service-owned-listener-"));
  const localIdentity = await identity(root, "local");
  const remoteIdentity = await identity(root, "remote");
  let listenCount = 0;
  let connectCount = 0;
  const client = createSyncpeerBrowserClient({ hostAdapter: { ...createNodeHostAdapter(),
    listenTls: async () => { listenCount++; throw new Error("UI listener must stay disabled"); },
    connectTls: async () => { connectCount++; throw new Error("Synthetic outbound stop"); },
  }, platformAdapter: {
    readDefaultIdentity: async () => localIdentity,
    incomingSessionOwnedByService: true,
  } });
  try {
    await assert.rejects(client.connectAndSync({ host: "127.0.0.1", port: 9,
      remoteId: remoteIdentity.deviceId, discoveryMode: "direct", timeoutMs: 1000 }));
    assert.equal(listenCount, 0);
    assert.equal(connectCount, 1);
  } finally {
    await client.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reused browser listener advertises current folders and adopts current connection options", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-listener-refresh-"));
  const adapter = createNodeHostAdapter();
  let port = 0;
  let listenCount = 0;
  let outgoingAttempts = 0;
  const requestedPorts: number[] = [];
  let outgoing: SyncpeerSessionHandle | undefined;
  const [ownerIdentity, joiningIdentity] = (await Promise.all([
    identity(root, "one"), identity(root, "two"),
  ])).sort((a, b) => b.deviceId.replaceAll("-", "").localeCompare(a.deviceId.replaceAll("-", "")));
  const owner = createSyncpeerBrowserClient({ hostAdapter: { ...adapter,
    connectTls: async () => { outgoingAttempts++; throw new Error("Synthetic outbound failure"); },
    listenTls: async options => {
      listenCount++;
      requestedPorts.push(options.port);
      const listener = await adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 });
      port = listener.port;
      return listener;
    },
  }, platformAdapter: { readDefaultIdentity: async () => ownerIdentity } });
  const connected = Promise.withResolvers<void>();
  const unsubscribe = owner.subscribeLifecycle(state => {
    if (state.phase === "connected") connected.resolve();
  });
  try {
    const options = { host: "127.0.0.1", port: 1, listenPort: 22999, remoteId: joiningIdentity.deviceId,
      deviceName: "synthetic-owner", discoveryMode: "direct" as const, timeoutMs: 1000 };
    for (const id of ["old-folder", "new-folder"]) {
      await assert.rejects(owner.connectAndSync({ ...options,
        folderPasswords: { [id]: "synthetic-password" },
        sharedFolders: [{ id, encryption: { mode: "plaintext" } }],
      }));
    }
    assert.equal(listenCount, 1);
    assert.equal(outgoingAttempts, 0, "The higher-ID peer should wait for its preferred incoming session.");
    assert.deepEqual(requestedPorts, [22999]);
    outgoing = await createSyncpeerCoreClient(adapter).openSession({ ...joiningIdentity,
      host: "127.0.0.1", port, expectedDeviceId: ownerIdentity.deviceId,
      deviceName: "synthetic-joiner", discoveryMode: "direct", timeoutMs: 1000,
      sharedFolders: [{ id: "new-folder", encryption: { mode: "plaintext" } }],
    });
    await connected.promise;
    assert.deepEqual((await outgoing.remoteFs.listFolders()).map(folder => folder.id), ["new-folder"]);
  } finally {
    unsubscribe();
    await outgoing?.close();
    await owner.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

test("incoming Hello uses folders prepared before listening, without reopening document storage", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-offline-folder-preparation-"));
  const adapter = createNodeHostAdapter();
  const [ownerIdentity, joiningIdentity] = (await Promise.all([
    identity(root, "one"), identity(root, "two"),
  ])).sort((a, b) => b.deviceId.replaceAll("-", "").localeCompare(a.deviceId.replaceAll("-", "")));
  let prepared = false;
  let lookups = 0;
  let port = 0;
  let revision = 0;
  let invalidate = () => {};
  const owner = createSyncpeerBrowserClient({ hostAdapter: { ...adapter,
    listenTls: async options => {
      assert.equal(prepared, true, "Local folders must be ready before the listener starts.");
      const listener = await adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 });
      port = listener.port;
      return listener;
    },
  }, platformAdapter: {
    readDefaultIdentity: async () => ownerIdentity,
    ownedDevices: async () => [
      { id: "synthetic-owner-slot", syncthingId: ownerIdentity.deviceId,
        state: "active" as const, signingKey: "synthetic-owner-key" },
      { id: "synthetic-joiner-slot", syncthingId: joiningIdentity.deviceId,
        state: "active" as const, signingKey: "synthetic-joiner-key" },
    ],
    sessionConfigurationRevision: () => revision,
    onSessionConfigurationChange: listener => { invalidate = listener; },
    sessionSharedFolders: async () => {
      lookups++;
      if (lookups > 1) throw new Error("Incoming Hello waited for a second document lookup.");
      prepared = true;
      return [{ id: "offline-folder", encryption: { mode: "plaintext" } }];
    },
  } });
  let outgoing: SyncpeerSessionHandle | undefined;
  try {
    await assert.rejects(owner.connectAndSync({ host: "127.0.0.1", port: 1,
      remoteId: joiningIdentity.deviceId, deviceName: "synthetic-owner",
      discoveryMode: "direct", timeoutMs: 1000 }));
    outgoing = await createSyncpeerCoreClient(adapter).openSession({ ...joiningIdentity,
      host: "127.0.0.1", port, expectedDeviceId: ownerIdentity.deviceId,
      deviceName: "synthetic-joiner", discoveryMode: "direct", timeoutMs: 2000,
      sharedFolders: [{ id: "offline-folder", encryption: { mode: "plaintext" } }],
    });
    assert.equal(lookups, 1);
    assert.deepEqual((await outgoing.remoteFs.listFolders()).map(folder => folder.id), ["offline-folder"]);
    revision++;
    invalidate();
    await outgoing.closed;
    assert.equal(outgoing.isClosed(), true, "A sharing change must retire the old prepared session.");
  } finally {
    await outgoing?.close();
    await owner.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

for (const direction of ["incoming", "outgoing"] as const) {
test(`${direction} session configuration invalidation reopens with the current shared-folder view`, { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-live-folder-refresh-"));
  const adapter = createNodeHostAdapter();
  const [highIdentity, lowIdentity] = (await Promise.all([
    identity(root, "high"), identity(root, "low"),
  ])).sort((a, b) => b.deviceId.replaceAll("-", "").localeCompare(a.deviceId.replaceAll("-", "")));
  const trusted = [
    { id: "high-slot", syncthingId: highIdentity.deviceId, state: "active" as const, signingKey: "high-key" },
    { id: "low-slot", syncthingId: lowIdentity.deviceId, state: "active" as const, signingKey: "low-key" },
  ];
  const internalFolder = { id: "settings", internal: true, encryption: { mode: "plaintext" as const } };
  const sharedFolder = { id: "shared", encryption: { mode: "plaintext" as const } };
  let highPort = 0;
  let revision = 0;
  let invalidate = () => {};
  let currentFolders = [internalFolder];
  const selections: number[] = [];
  const phases: string[] = [];
  const diagnostics: string[] = [];
  const onLog = (entry: { event: string; details?: Record<string, unknown> }) => {
    if (entry.event === "client.shared_folders.selected" && typeof entry.details?.count === "number") {
      selections.push(entry.details.count);
    }
  };
  const refreshingPlatform = {
    sessionConfigurationRevision: () => revision,
    onSessionConfigurationChange: (listener: () => void) => { invalidate = listener; },
  };
  const high = createSyncpeerBrowserClient({
    ...(direction === "incoming" ? { onLog } : {}), hostAdapter: { ...adapter,
    log: (event, details) => {
      if (/failed|handshake.ready|socket.closed/.test(event)) diagnostics.push(`incoming:${event}:${details?.message ?? ""}`);
    },
    listenTls: async options => {
      const listener = await adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 });
      highPort = listener.port;
      return listener;
    },
  }, platformAdapter: {
    readDefaultIdentity: async () => highIdentity,
    ownedDevices: async () => trusted,
    ...(direction === "incoming" ? refreshingPlatform : {}),
    sessionSharedFolders: async () => direction === "incoming" ? currentFolders : [internalFolder, sharedFolder],
  } });
  const low = createSyncpeerBrowserClient({ hostAdapter: { ...adapter,
    log: (event, details) => {
      if (/failed|handshake.ready|socket.closed/.test(event)) diagnostics.push(`outgoing:${event}:${details?.message ?? ""}`);
    }, },
    ...(direction === "outgoing" ? { onLog } : {}), platformAdapter: {
    readDefaultIdentity: async () => lowIdentity,
    ownedDevices: async () => trusted,
    ...(direction === "outgoing" ? refreshingPlatform : {}),
    sessionSharedFolders: async () => direction === "outgoing" ? currentFolders : [internalFolder, sharedFolder],
  } });
  const highConnected = Promise.withResolvers<void>();
  const unsubscribeHigh = high.subscribeLifecycle(state => {
    if (state.phase === "connected") highConnected.resolve();
    if (direction === "incoming") phases.push(state.phase);
  });
  const unsubscribeLow = low.subscribeLifecycle(state => {
    if (direction === "outgoing") phases.push(state.phase);
  });
  try {
    await assert.rejects(high.connectAndSync({ host: "127.0.0.1", port: 1,
      remoteId: lowIdentity.deviceId, discoveryMode: "direct", timeoutMs: 1000 }));
    await low.connectAndSync({ host: "127.0.0.1", port: highPort,
      remoteId: highIdentity.deviceId, discoveryMode: "direct", timeoutMs: 3000 });
    await highConnected.promise;
    assert.ok(selections.includes(1), `Initial shared-folder view was not observed: ${selections.join(",")}`);
    const refreshPhaseStart = phases.length;
    currentFolders = [internalFolder, sharedFolder];
    revision++;
    invalidate();
    const deadline = Date.now() + 8000;
    while ((!selections.includes(2) || !phases.slice(refreshPhaseStart).includes("connected")) &&
      Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(selections.includes(2),
      `Invalidation did not select the current shared-folder view: ${selections.join(",")}`);
    assert.ok(phases.slice(refreshPhaseStart).includes("connected"),
      `Invalidation selected fresh folders but did not complete a replacement session: ${phases.slice(refreshPhaseStart).join(",")}; ${diagnostics.join(";")}`);
  } finally {
    unsubscribeHigh();
    unsubscribeLow();
    await Promise.allSettled([low.disconnect(), high.disconnect()]);
    await rm(root, { recursive: true, force: true });
  }
});
}


test("browser clients pair over the production LAN TLS adapters and persist only after confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-browser-pairing-"));
  let handle: Awaited<ReturnType<ReturnType<typeof createSyncpeerBrowserClient>["startPairingInvitation"]>> | undefined;
  try {
    const [ownerIdentity, joiningIdentity] = await Promise.all([
      identity(root, "owner"), identity(root, "joining"),
    ]);
    const ownerSigning = await createOwnedDeviceIdentity(crypto.subtle, randomBytes, ownerIdentity.deviceId);
    let imported: unknown;
    const codes: string[] = [];
    const owner = createSyncpeerBrowserClient({ hostAdapter: createNodeHostAdapter(), platformAdapter: {
      readDefaultIdentity: async () => ownerIdentity,
      exportPairingTransfer: async (_localDeviceId, joiningDevice) => {
        const key = await openOwnedDeviceSigningKey(crypto.subtle, ownerSigning);
        const ownerDevice = { id: ownerSigning.id, syncthingId: ownerSigning.syncthingId,
          state: ownerSigning.state, signingKey: ownerSigning.signingKey };
        const genesis = await signSpaceMembershipUpdate(crypto.subtle, key,
          { sequence: 1, previous: null, signer: ownerDevice.id, devices: [ownerDevice] });
        const update = await signSpaceMembershipUpdate(crypto.subtle, key, { sequence: 2, previous: genesis.hash,
          signer: ownerDevice.id, devices: [ownerDevice, joiningDevice] });
        return { spaceId: "a".repeat(32), settingsFolderId: "b".repeat(32), rootKey: "c".repeat(64),
          trust: { genesisKey: ownerDevice.signingKey, knownHead: update.hash, updates: [genesis, update] } };
      },
    } });
    const joining = createSyncpeerBrowserClient({ hostAdapter: createNodeHostAdapter(), platformAdapter: {
      readDefaultIdentity: async () => joiningIdentity,
      importPairingTransfer: async (value, deviceIdentity, password, remember) => {
        imported = { value, deviceIdentity, password, remember };
      },
    } });
    handle = await owner.startPairingInvitation({ advertisedHost: "127.0.0.1", port: 0,
      confirm: async code => { codes.push(`owner:${code}`); return true; } });
    const joined = await joining.joinPairingInvitation({ invitation: handle.invitation,
      password: "joined-local-password", remember: false,
      confirm: async code => { codes.push(`joining:${code}`); return true; } });
    const accepted = await handle.completed;
    assert.equal(joined.remoteDeviceId.replaceAll("-", ""), ownerIdentity.deviceId.replaceAll("-", ""));
    assert.equal(accepted.remoteDeviceId, joiningIdentity.deviceId.replaceAll("-", ""));
    assert.equal(codes[0].split(":")[1], codes[1].split(":")[1]);
    const saved = imported as { value: { trust: { updates: Array<{ devices: Array<{ syncthingId: string }> }> } };
      deviceIdentity: { syncthingId: string; privateKey: string }; password: string; remember: boolean };
    assert.equal(saved.deviceIdentity.syncthingId, joiningIdentity.deviceId);
    assert.ok(saved.deviceIdentity.privateKey);
    assert.equal(saved.value.trust.updates.at(-1)?.devices.some(device =>
      device.syncthingId === joiningIdentity.deviceId), true);
    assert.equal(saved.password, "joined-local-password");
    assert.equal(saved.remember, false);
  } finally {
    await handle?.cancel().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("background handoff arms one service session and stops it once on resume", { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-background-handoff-"));
  const adapter = createNodeHostAdapter();
  const events: string[] = [];
  let stallStop = true;
  let port = 0;
  const [ownerIdentity, joiningIdentity] = (await Promise.all([
    identity(root, "one"), identity(root, "two"),
  ])).sort((a, b) => b.deviceId.replaceAll("-", "").localeCompare(a.deviceId.replaceAll("-", "")));
  const owner = createSyncpeerBrowserClient({ hostAdapter: { ...adapter,
    connectTls: async () => { throw new Error("Synthetic outbound failure"); },
    listenTls: async options => {
      const listener = await adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 });
      port = listener.port;
      return listener;
    },
  }, platformAdapter: {
    readDefaultIdentity: async () => ownerIdentity,
    prepareBackgroundSession: async () => { events.push("background:prepare"); },
    startBackgroundSession: async () => { events.push("background:start"); },
    // Stalls once, to prove the foreground resume does not wait for it.
    stopBackgroundSession: () => {
      events.push("background:stop");
      return stallStop ? new Promise<void>(() => undefined) : Promise.resolve();
    },
  } });
  const connected = Promise.withResolvers<void>();
  const unsubscribeConnected = owner.subscribeLifecycle(state => {
    if (state.phase === "connected") connected.resolve();
  });
  let unsubscribeOrdering = () => {};
  let outgoing: SyncpeerSessionHandle | undefined;
  try {
    await assert.rejects(owner.connectAndSync({ host: "127.0.0.1", port: 1, listenPort: 22998,
      remoteId: joiningIdentity.deviceId, deviceName: "synthetic-owner",
      discoveryMode: "direct", timeoutMs: 1000 }));
    outgoing = await createSyncpeerCoreClient(adapter).openSession({ ...joiningIdentity,
      host: "127.0.0.1", port, expectedDeviceId: ownerIdentity.deviceId,
      deviceName: "synthetic-joiner", discoveryMode: "direct", timeoutMs: 2000,
    });
    await connected.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    unsubscribeConnected();
    unsubscribeOrdering = owner.subscribeLifecycle(state => events.push(`state:${state.phase}`));
    await owner.startTransfer("synthetic-foreground-transfer");
    await owner.setForeground(false);
    assert.ok(events.includes("background:prepare"), "The background session was not armed while foreground.");
    assert.ok(events.includes("background:start"), "The background session was not requested.");
    assert.ok(events.indexOf("background:prepare") < events.indexOf("background:start"),
      `The background request must be armed before the handoff: ${events.join(",")}`);
    assert.ok(events.indexOf("background:start") < events.indexOf("state:suspended"),
      `The background session must start before foreground teardown: ${events.join(",")}`);
    assert.ok(events.includes("state:suspended"),
      "A foreground transfer must not keep the WebView session alive across the handoff.");
    assert.equal(events.filter(event => event === "background:start").length, 1,
      `The background session must be requested exactly once: ${events.join(",")}`);
    // The stalled native stop must not keep the lifecycle in the background: the
    // phase has to leave "suspended" while that stop is still pending. A later
    // connect would otherwise fail with "Connection is suspended or offline."
    const phases: string[] = [];
    const unsubscribePhases = owner.subscribeLifecycle(state => { phases.push(state.phase); });
    const resuming = owner.setForeground(true);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.notEqual(phases.at(-1), "suspended",
      `Returning to the foreground waited for the native stop: ${events.join(",")}`);
    assert.ok(events.includes("background:stop"), "Returning to the foreground must stop the service session.");
    assert.equal(events.filter(event => event === "background:stop").length, 1,
      `Only the session this client started may be stopped: ${events.join(",")}`);
    unsubscribePhases();
    await resuming.catch(() => undefined);
    stallStop = false;
  } finally {
    unsubscribeConnected();
    unsubscribeOrdering();
    await outgoing?.close();
    await owner.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

test("late folder credentials update the handoff without replacing a healthy session", { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-background-secrets-"));
  const adapter = createNodeHostAdapter();
  const preparedPasswords: Array<Record<string, string> | undefined> = [];
  let port = 0;
  const [ownerIdentity, joiningIdentity] = (await Promise.all([
    identity(root, "owner"), identity(root, "joining"),
  ])).sort((a, b) => b.deviceId.replaceAll("-", "").localeCompare(a.deviceId.replaceAll("-", "")));
  const owner = createSyncpeerBrowserClient({ hostAdapter: { ...adapter,
    connectTls: async () => { throw new Error("Synthetic outbound failure"); },
    listenTls: async options => {
      const listener = await adapter.listenTls!({ ...options, host: "127.0.0.1", port: 0 });
      port = listener.port;
      return listener;
    },
  }, platformAdapter: {
    readDefaultIdentity: async () => ownerIdentity,
    prepareBackgroundSession: async options => { preparedPasswords.push(options.folderPasswords); },
    ownedDevices: async () => [
      { id: "owner-slot", syncthingId: ownerIdentity.deviceId, state: "active" as const, signingKey: "owner-key" },
      { id: "joining-slot", syncthingId: joiningIdentity.deviceId, state: "active" as const, signingKey: "joining-key" },
    ],
  } });
  const connected = Promise.withResolvers<void>();
  const unsubscribe = owner.subscribeLifecycle(state => {
    if (state.phase === "connected") connected.resolve();
  });
  let outgoing: SyncpeerSessionHandle | undefined;
  try {
    await assert.rejects(owner.connectAndSync({ host: "127.0.0.1", port: 1, listenPort: 22997,
      remoteId: joiningIdentity.deviceId, deviceName: "synthetic-owner",
      discoveryMode: "direct", timeoutMs: 1000 }));
    outgoing = await createSyncpeerCoreClient(adapter).openSession({ ...joiningIdentity,
      host: "127.0.0.1", port, expectedDeviceId: ownerIdentity.deviceId,
      deviceName: "synthetic-joining", discoveryMode: "direct", timeoutMs: 2000,
    });
    await connected.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(preparedPasswords.length >= 1, "The incoming adoption must arm the background handoff.");
    assert.deepEqual(preparedPasswords.at(-1) ?? {},
      {}, "The initial handoff must reflect the options that opened the session.");
    const overview = await owner.connectAndGetOverview({ host: "127.0.0.1", port: 1,
      listenPort: 22997, remoteId: joiningIdentity.deviceId, deviceName: "synthetic-owner",
      discoveryMode: "direct", timeoutMs: 1000,
      folderPasswords: { camera: "synthetic-folder-password" } });
    assert.equal(overview.device?.id, joiningIdentity.deviceId);
    assert.equal(outgoing.isClosed(), false, "Credential hydration must not break the peer's TLS session");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(preparedPasswords.at(-1), { camera: "synthetic-folder-password" },
      "Newly loaded credentials must reach the next background handoff.");
  } finally {
    unsubscribe();
    await outgoing?.close();
    await owner.disconnect();
    await rm(root, { recursive: true, force: true });
  }
});
