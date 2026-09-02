import assert from "node:assert/strict";
import test from "node:test";
import {
  createConnectionLifecycle,
  retryDelayMs,
  type ConnectionLifecycleState,
} from "../packages/core/dist/ui/connectionLifecycle.js";
import { fromConnectionSettings } from "../packages/core/dist/ui/connectionState.js";
import { createSyncpeerSessionStore } from "../packages/core/dist/ui/sessionStore.js";
import {
  candidateCooldownMs,
  candidatePreferenceScore,
  withMetadataSession,
  type SyncpeerSessionHandle,
} from "../packages/core/dist/client.js";
import {
  createCheckpointedDownloadSink,
  RemoteMetadataChangedError,
} from "../packages/core/dist/transfer/stream.js";
import { RemoteFs } from "../packages/core/dist/core/model/remoteFs.js";
import { sanitizeDiagnosticArtifact } from "../packages/shared/modules/diagnosticSanitizer.ts";

const remoteFs = {} as SyncpeerSessionHandle["remoteFs"];

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

const session = () => {
  const closed = deferred<Awaited<SyncpeerSessionHandle["closed"]>>();
  let isClosed = false;
  const finish = (closure: Awaited<SyncpeerSessionHandle["closed"]>) => {
    isClosed = true;
    closed.resolve(closure);
  };
  return {
    remoteFs,
    connectedVia: "redacted-test-path",
    transportKind: "direct-tcp" as const,
    connectionScope: "lan" as const,
    isClosed: () => isClosed,
    close: async () => finish({ kind: "manual", message: "closed" }),
    closed: closed.promise,
    finish,
  };
};

test("legacy global discovery migrates to automatic", () => {
  const stored = fromConnectionSettings({
    host: "example.invalid",
    port: 22000,
    cert: "",
    key: "",
    remoteId: "",
    deviceName: "test",
    timeoutMs: 1000,
    discoveryMode: "global",
    discoveryServer: "",
    enableRelayFallback: true,
    autoAcceptNewDevices: false,
    autoAcceptIntroducedFolders: false,
  });
  assert.equal(stored.discoveryMode, "automatic");
  assert.equal(fromConnectionSettings(null).discoveryMode, "automatic");
});

test("retry backoff is bounded and supports deterministic jitter", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map((streak) => retryDelayMs(streak, () => 0.5)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  assert.equal(retryDelayMs(0, () => 0), 800);
  assert.equal(retryDelayMs(0, () => 1), 1200);
});

test("candidate preference and cooldown match Syncthing ordering", () => {
  const candidate = (protocol: "tcp" | "quic" | "relay", scope: "lan" | "wan") => ({
    address: `${protocol}://test.invalid:22000`,
    protocol,
    host: "test.invalid",
    port: 22000,
    scope,
  });
  assert.deepEqual([
    candidatePreferenceScore(candidate("tcp", "lan")),
    candidatePreferenceScore(candidate("quic", "lan")),
    candidatePreferenceScore(candidate("tcp", "wan")),
    candidatePreferenceScore(candidate("quic", "wan")),
    candidatePreferenceScore(candidate("relay", "wan")),
  ], [500, 400, 300, 200, 0]);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(candidateCooldownMs), [5000, 10000, 20000, 40000, 60000, 60000]);
});

test("socket closure updates state and reconnects without polling", async () => {
  const first = session();
  const second = session();
  const opened = [first, second];
  const sleeps: Array<() => void> = [];
  const lifecycle = createConnectionLifecycle<string>({
    open: async () => opened.shift()!,
    keyFor: (value) => value,
    sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
    random: () => 0.5,
  });

  await lifecycle.connect("peer");
  assert.equal(lifecycle.getState().phase, "connected");
  first.finish({ kind: "transport", message: "connection reset" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lifecycle.getState().phase, "waiting");
  assert.equal(lifecycle.getState().attempt, 1);
  sleeps.shift()?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lifecycle.getState().phase, "connected");
  await lifecycle.disconnect();
});

test("manual disconnect cancels a pending retry", async () => {
  const first = session();
  let opens = 0;
  const sleeps: Array<() => void> = [];
  const lifecycle = createConnectionLifecycle<string>({
    open: async () => { opens += 1; return first; },
    keyFor: (value) => value,
    sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
    random: () => 0.5,
  });
  await lifecycle.connect("peer");
  first.finish({ kind: "transport", message: "eof" });
  await Promise.resolve();
  await lifecycle.disconnect();
  sleeps.shift()?.();
  await Promise.resolve();
  assert.equal(opens, 1);
  assert.equal(lifecycle.getState().phase, "idle");
});

test("session store stays stopping until transport shutdown finishes", async () => {
  const shutdown = deferred<void>();
  const store = createSyncpeerSessionStore({
    transport: {
      connectAndSync: async () => remoteFs,
      connectAndGetOverview: async () => { throw new Error("not used"); },
      connectAndGetFolderVersions: async () => [],
      disconnect: () => shutdown.promise,
    },
  });

  const disconnecting = store.actions.disconnect();
  assert.equal(store.getState().phase, "stopping");
  shutdown.resolve();
  await disconnecting;
  assert.equal(store.getState().phase, "idle");
});

test("an automatic reconnect rehydrates the session overview", async () => {
  let attempts = 0;
  let timeMs = 0;
  let onLifecycle: ((state: ConnectionLifecycleState) => void) | undefined;
  const store = createSyncpeerSessionStore({
    now: () => timeMs,
    sleep: async (ms) => { timeMs += ms; },
    transport: {
      connectAndSync: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("connection closed");
        return remoteFs;
      },
      connectAndGetOverview: async () => ({
        folders: [],
        device: null,
        folderSyncStates: [],
        connectedVia: "redacted-test-path",
        transportKind: "direct-tcp",
      }),
      connectAndGetFolderVersions: async () => [],
      subscribeLifecycle: (listener) => {
        onLifecycle = listener;
        return () => undefined;
      },
    },
  });
  const options = { host: "test.invalid", port: 22000, deviceName: "test" };

  await assert.rejects(store.actions.connect(options), /connection closed/);
  onLifecycle?.({
    phase: "connected",
    attempt: 1,
    nextRetryAtMs: null,
    closureReason: null,
    upgradeStatus: "idle",
  });
  assert.equal(store.getState().phase, "reconnecting");
  for (let index = 0; index < 20 && store.getState().phase !== "connected"; index += 1) {
    await Promise.resolve();
  }
  assert.equal(store.getState().phase, "connected");
  assert.equal(store.getState().remoteFs, remoteFs);
});

test("concurrent connects share one validated opening", async () => {
  const pending = deferred<ReturnType<typeof session>>();
  let opens = 0;
  const lifecycle = createConnectionLifecycle<string>({
    open: async () => {
      opens += 1;
      return pending.promise;
    },
    keyFor: (value) => value,
  });
  const first = lifecycle.connect("peer");
  const second = lifecycle.connect("peer");
  const opened = session();
  pending.resolve(opened);
  assert.equal(await first, opened);
  assert.equal(await second, opened);
  assert.equal(opens, 1);
  assert.equal(lifecycle.getState().phase, "connected");
  await lifecycle.disconnect();
});

test("changed connection options close the old session before opening", async () => {
  const first = session();
  const second = session();
  const events: string[] = [];
  const lifecycle = createConnectionLifecycle<string>({
    open: async (options) => {
      events.push(`open:${options}`);
      return options === "first" ? first : second;
    },
    keyFor: (value) => value,
  });
  const originalClose = first.close;
  first.close = async () => {
    events.push("close:first");
    await originalClose();
  };
  await lifecycle.connect("first");
  await lifecycle.connect("second");
  assert.deepEqual(events, ["open:first", "close:first", "open:second"]);
  await lifecycle.disconnect();
});

test("metadata recovery retries transport closure but not application errors", async () => {
  const closedSession = session();
  closedSession.finish({ kind: "transport", message: "connection closed" });
  let ensures = 0;
  let operations = 0;
  await assert.rejects(withMetadataSession(
    "peer",
    async () => { ensures += 1; return closedSession; },
    null,
    async () => {
      operations += 1;
      throw new Error("Unknown folder");
    },
  ), /Unknown folder/);
  assert.deepEqual({ ensures, operations }, { ensures: 1, operations: 1 });

  operations = 0;
  await assert.rejects(withMetadataSession(
    "peer",
    async () => closedSession,
    null,
    async () => {
      operations += 1;
      throw new Error("connection closed");
    },
  ), /connection closed/);
  assert.equal(operations, 3);
});

test("background transfer defers suspension until transfer ends", async () => {
  const active = session();
  const lifecycle = createConnectionLifecycle<string>({
    open: async () => active,
    keyFor: (value) => value,
  });
  await lifecycle.connect("peer");
  lifecycle.setTransferActive(true);
  await lifecycle.setForeground(false);
  assert.equal(lifecycle.getState().phase, "connected");
  await lifecycle.setTransferActive(false);
  assert.equal(lifecycle.getState().phase, "suspended");
});

test("download checkpoints keep sinks open and skip completed ranges", async () => {
  const writes: number[] = [];
  let aborts = 0;
  const checkpointed = createCheckpointedDownloadSink({
    begin: () => undefined,
    write: (offset) => { writes.push(offset); },
    commit: () => undefined,
    abort: () => { aborts += 1; },
  });
  const metadata = { folderId: "folder", path: "file", sizeBytes: 8, encrypted: false };
  await checkpointed.sink.begin(metadata);
  await checkpointed.sink.write(0, new Uint8Array(4));
  assert.equal(checkpointed.sink.hasRange?.(0, 4), true);
  await checkpointed.sink.begin(metadata);
  await checkpointed.sink.write(0, new Uint8Array(4));
  await checkpointed.sink.write(4, new Uint8Array(4));
  assert.deepEqual(writes, [0, 4]);
  await assert.rejects(
    checkpointed.sink.begin({ ...metadata, sizeBytes: 9 }),
    RemoteMetadataChangedError,
  );
  assert.equal(aborts, 1);
});

test("remote file block offsets normalize protobuf long values", async () => {
  const longOffset = {
    valueOf: () => 131072,
    toString: () => "131072",
  };
  const folders = new Map([["folder", {
    id: "folder",
    label: "Folder",
    readOnly: true,
    advertisedDevices: [],
    encrypted: false,
    needsPassword: false,
    indexReceived: true,
    files: new Map([["blob.bin", {
      indexFile: {
        name: "blob.bin",
        size: 262144,
        blocks: [{ offset: longOffset, size: 131072, hash: new Uint8Array() }],
      },
    }]]),
  }]]);
  const fs = new RemoteFs(
    folders as never,
    async () => new Uint8Array(),
    async () => undefined,
    () => undefined,
  );

  const [entry] = await fs.readDir("folder", "");
  assert.equal(entry.blocks?.[0]?.offset, 131072);
  assert.equal(typeof entry.blocks?.[0]?.offset, "number");
});

test("generated diagnostics redact peer and filesystem metadata", () => {
  assert.deepEqual(sanitizeDiagnosticArtifact({
    host: "192.0.2.1",
    deviceId: "DEVICE",
    server_device_id: "REMOTE-DEVICE",
    output: "candidate\ttcp://192.0.2.1:22000",
    nested: { path: "/private/file", count: 2 },
  }), {
    host: "[redacted]",
    deviceId: "[redacted]",
    server_device_id: "[redacted]",
    output: "[redacted]",
    nested: { path: "[redacted]", count: 2 },
  });
});
