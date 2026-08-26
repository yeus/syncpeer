import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ClusterConfig,
  Close,
  encodeHelloFrame,
  encodeMessageFrame,
  FrameParser,
  Index,
  MessageTypeValues,
} from "../packages/core/dist/core/protocol/bep.js";
import {
  createSyncpeerCoreClient,
  withRecoveringSession,
} from "../packages/core/dist/client.js";
import { makeReadDirWithRetryFlow } from "../packages/core/dist/browser.js";
import type { RemoteFs } from "../packages/core/src/core/model/remoteFs.ts";
import {
  coalescePendingIndexFrame,
  type PendingIndexFrame,
} from "../packages/core/src/core/protocol/indexQueue.ts";
import { resolvePackagedAppVersion } from "../packages/app/buildInfo.ts";
import {
  classifyRuntimeEnvironment,
  detectRuntimeEnvironment,
} from "../packages/app/src/lib/runtimeInfo.ts";
import {
  getDefaultDiscoveryServer,
  normalizeDiscoveryServer,
} from "../packages/core/src/ui/discoveryServer.ts";

const defaultDiscoveryServer = getDefaultDiscoveryServer();
assert.ok(new URL(defaultDiscoveryServer).searchParams.get("id"));
assert.equal(
  normalizeDiscoveryServer("https://discovery.syncthing.net/v2/"),
  defaultDiscoveryServer,
);

const update = (
  files: Array<{ name: string; deleted?: boolean }>,
  lastSequence: number,
): PendingIndexFrame => ({
  kind: "update",
  index: {
    folder: "documents",
    files,
    last_sequence: lastSequence,
  },
});

const firstUpdate = update([{ name: "first.txt" }], 1);
const secondUpdate = update([{ name: "second.txt" }], 2);
const mergedUpdates = coalescePendingIndexFrame(firstUpdate, secondUpdate);

assert.equal(mergedUpdates.kind, "update");
assert.deepEqual(
  mergedUpdates.index.files.map((file) => file.name),
  ["first.txt", "second.txt"],
);
assert.equal(mergedUpdates.index.last_sequence, 2);

const mergedDeletion = coalescePendingIndexFrame(
  mergedUpdates,
  update([{ name: "first.txt", deleted: true }], 3),
);
assert.deepEqual(
  mergedDeletion.index.files.find((file) => file.name === "first.txt"),
  { name: "first.txt", deleted: true },
);

const replacementIndex: PendingIndexFrame = {
  kind: "index",
  index: {
    folder: "documents",
    files: [{ name: "snapshot.txt" }],
    last_sequence: 4,
  },
};
assert.deepEqual(
  coalescePendingIndexFrame(mergedDeletion, replacementIndex),
  replacementIndex,
);
const snapshotWithUpdate = coalescePendingIndexFrame(
  replacementIndex,
  update([{ name: "later.txt" }], 5),
);
assert.equal(snapshotWithUpdate.kind, "index");
assert.deepEqual(
  snapshotWithUpdate.index.files.map((file) => file.name),
  ["snapshot.txt", "later.txt"],
);

assert.equal(
  classifyRuntimeEnvironment({ hasNodeRuntime: false, hasTauriRuntime: true }),
  "tauri",
);
assert.equal(
  classifyRuntimeEnvironment({ hasNodeRuntime: true, hasTauriRuntime: false }),
  "node",
);
assert.equal(
  classifyRuntimeEnvironment({ hasNodeRuntime: false, hasTauriRuntime: false }),
  "browser",
);

const runtimeGlobal = globalThis as { __TAURI_INTERNALS__?: unknown };
const previousTauriInternals = runtimeGlobal.__TAURI_INTERNALS__;
try {
  runtimeGlobal.__TAURI_INTERNALS__ = {};
  assert.equal(detectRuntimeEnvironment(), "tauri");
} finally {
  if (previousTauriInternals === undefined) delete runtimeGlobal.__TAURI_INTERNALS__;
  else runtimeGlobal.__TAURI_INTERNALS__ = previousTauriInternals;
}

const tauriConfig = JSON.parse(
  await readFile(
    new URL("../packages/tauri-shell/src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
) as unknown;
assert.equal(resolvePackagedAppVersion(tauriConfig), "0.1.0");

const fakeCertificate =
  "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
const remoteHandshake = new Uint8Array([
  ...encodeHelloFrame({
    device_name: "fake-syncthing",
    client_name: "syncthing",
    client_version: "v1.27.8",
  }),
  ...encodeMessageFrame(
    MessageTypeValues.CLUSTER_CONFIG,
    ClusterConfig,
    {
      folders: [{ id: "documents", label: "Documents", type: 0, devices: [] }],
    },
  ),
  ...encodeMessageFrame(
    MessageTypeValues.INDEX,
    Index,
    {
      folder: "documents",
      files: [{ name: "hello.txt", type: 0, size: 1 }],
      last_sequence: 1,
    },
  ),
]);

const createFakeTlsSocket = () => {
  let handshake = remoteHandshake;
  let closed = false;
  let rejectRead: ((error: Error) => void) | null = null;
  const writes: Uint8Array[] = [];
  return {
    writes,
    socket: {
      read: async (): Promise<Uint8Array> => {
        if (handshake.length > 0) {
          const next = handshake;
          handshake = new Uint8Array();
          return next;
        }
        if (closed) throw new Error("Connection closed");
        return new Promise<Uint8Array>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
      write: async (data: Uint8Array): Promise<void> => {
        writes.push(new Uint8Array(data));
      },
      close: async (): Promise<void> => {
        closed = true;
        rejectRead?.(new Error("Connection closed"));
      },
      peerCertificateDer: async (): Promise<Uint8Array> =>
        new Uint8Array([4, 5, 6]),
    },
  };
};

const fakeSocket = createFakeTlsSocket();
const coreClient = createSyncpeerCoreClient({
  connectTls: async () => fakeSocket.socket,
  sha256: (data) => new Uint8Array(createHash("sha256").update(data).digest()),
  randomBytes: (length) => new Uint8Array(length),
  discoveryFetch: async () => {
    throw new Error("Discovery is not used by this direct transport test.");
  },
});
const fakeSession = await coreClient.openSession({
  host: "127.0.0.1",
  port: 22000,
  certPem: fakeCertificate,
  keyPem: fakeCertificate,
  deviceName: "syncpeer-regression",
  discoveryMode: "direct",
});
const initialFolderState = await fakeSession.remoteFs.getFolderSyncState("documents");
assert.equal(initialFolderState?.indexReceived, true);
await fakeSession.close();

let closeReason = "";
const closeParser = new FrameParser((type, message) => {
  if (type === MessageTypeValues.CLOSE) {
    closeReason = String((message as { reason?: unknown }).reason ?? "");
  }
});
for (const write of fakeSocket.writes.slice(1)) closeParser.feed(write);
assert.equal(closeReason, "Client closed");

const retrySocket = createFakeTlsSocket();
let discoveryCalls = 0;
let relayCalls = 0;
const retryClient = createSyncpeerCoreClient({
  connectTls: async () => retrySocket.socket,
  connectRelay: async ({ relayAddress }) => {
    relayCalls += 1;
    if (relayCalls <= 2) {
      throw new Error("Relay connect request failed (code 1): not found");
    }
    return { socket: retrySocket.socket, connectedVia: relayAddress };
  },
  sha256: () => new Uint8Array(32),
  randomBytes: (length) => new Uint8Array(length),
  discoveryFetch: async () => {
    discoveryCalls += 1;
    const relay = discoveryCalls === 1
      ? "relay://stale.example:22067/?id=stale"
      : "relay://fresh.example:22067/?id=fresh";
    const body = JSON.stringify({ addresses: [relay] });
    return {
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  },
});
const retrySession = await retryClient.openSession({
  host: "",
  port: 0,
  certPem: fakeCertificate,
  keyPem: fakeCertificate,
  expectedDeviceId: "A".repeat(52),
  deviceName: "syncpeer-regression",
  discoveryMode: "global",
  relayOnly: true,
  timeoutMs: 5_000,
});
assert.ok(discoveryCalls >= 2);
assert.ok(relayCalls >= 3);
await retrySession.close();

const keepaliveSocket = createFakeTlsSocket();
const keepaliveClient = createSyncpeerCoreClient({
  connectTls: async () => keepaliveSocket.socket,
  sha256: () => new Uint8Array(32),
  randomBytes: (length) => new Uint8Array(length),
  discoveryFetch: async () => {
    throw new Error("Discovery is not used by this keepalive test.");
  },
});
const keepaliveSession = await keepaliveClient.openSession({
  host: "127.0.0.1",
  port: 22000,
  certPem: fakeCertificate,
  keyPem: fakeCertificate,
  deviceName: "syncpeer-regression",
  discoveryMode: "direct",
  keepalive: {
    pingIntervalMs: 20,
    receiveTimeoutMs: 500,
  },
});
await new Promise((resolve) => setTimeout(resolve, 45));
let pingCount = 0;
const pingParser = new FrameParser((type) => {
  if (type === MessageTypeValues.PING) pingCount += 1;
});
for (const write of keepaliveSocket.writes.slice(1)) pingParser.feed(write);
assert.ok(pingCount >= 1);
await keepaliveSession.close();

let recoveryCalls = 0;
const staleRemoteFs = {
  listFolders: async () => {
    throw new Error("Connection closed");
  },
  setFocusedFolder: () => undefined,
} as unknown as RemoteFs;
const recoveredRemoteFs = {
  listFolders: async () => [{ id: "documents" }],
  setFocusedFolder: (folderId: string | null) => {
    assert.equal(folderId, "documents");
  },
} as unknown as RemoteFs;
const recoveredFolders = await withRecoveringSession(
  "test-options",
  async () => {
    recoveryCalls += 1;
    return recoveryCalls === 1
      ? {
          remoteFs: staleRemoteFs,
          isClosed: () => true,
        }
      : {
          remoteFs: recoveredRemoteFs,
          isClosed: () => false,
        };
  },
  "documents",
  (session) => session.remoteFs.listFolders(),
);
assert.deepEqual(recoveredFolders, [{ id: "documents" }]);
assert.equal(recoveryCalls, 2);

let readDirCalls = 0;
const readDirWithRetry = makeReadDirWithRetryFlow({
  sleep: async () => undefined,
});
const delayedFolderIndex = await readDirWithRetry({
  fs: {
    readDir: async () => {
      readDirCalls += 1;
      return readDirCalls === 1
        ? []
        : [{ name: "hello.txt", path: "hello.txt", type: "file", size: 1, modifiedMs: 0 }];
    },
  },
  folderId: "syncpeer-lan",
  path: "",
  encrypted: false,
  locked: false,
  retryEmpty: true,
  retryTimeoutMs: 100,
  retryIntervalMs: 1,
});
assert.deepEqual(
  delayedFolderIndex.entries.map((entry) => entry.name),
  ["hello.txt"],
);
assert.equal(delayedFolderIndex.attempts.length, 2);

console.log("Review regression checks passed.");
