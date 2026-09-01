import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ClusterConfig,
  encodeHelloFrame,
  encodeMessageFrame,
  FrameParser,
  Index,
  MessageTypeValues,
  type BepClusterConfig,
} from "../packages/core/dist/core/protocol/bep.js";
import {
  createSyncpeerCoreClient,
  withSessionTransportProgress,
  withRecoveringSession,
} from "../packages/core/dist/client.js";
import { RemoteFs as BuiltRemoteFs } from "../packages/core/dist/core/model/remoteFs.js";
import {
  createDuplexChannel,
  createPortDownloadSink,
  createSyncpeerSessionStore,
  isTransportFailure,
  makeReadDirWithRetryFlow,
  type FileTransferMessage,
  type RemoteFsLike,
} from "../packages/core/dist/browser.js";

import type { RemoteFs } from "../packages/core/src/core/model/remoteFs.ts";
import {
  coalescePendingIndexFrame,
  type PendingIndexFrame,
} from "../packages/core/src/core/protocol/indexQueue.ts";
import { deriveUntrustedFolderCrypto } from "../packages/core/src/core/model/untrusted.ts";
import { resolvePackagedAppVersion } from "../packages/app/buildInfo.ts";
import {
  classifyRuntimeEnvironment,
  detectRuntimeEnvironment,
  supportsOngoingTransferNotifications,
} from "../packages/app/src/lib/runtimeInfo.ts";
import {
  getDefaultDiscoveryServer,
  normalizeDiscoveryServer,
} from "../packages/core/src/ui/discoveryServer.ts";

assert.equal(isTransportFailure(new Error("TLS flush failed: Broken pipe")), true);
assert.equal(isTransportFailure(new Error("Request timeout for file at offset 0")), true);
assert.equal(isTransportFailure(new Error("No such file")), false);

const defaultDiscoveryServer = getDefaultDiscoveryServer();
assert.ok(new URL(defaultDiscoveryServer).searchParams.get("id"));
assert.equal(
  normalizeDiscoveryServer("https://discovery.syncthing.net/v2/"),
  defaultDiscoveryServer,
);

let decoratedProgress: unknown = null;
withSessionTransportProgress(
  {
    remoteFs: {} as RemoteFs,
    connectedVia: "relay://relay.example:22067",
    transportKind: "relay",
    isClosed: () => false,
    close: async () => undefined,
  },
  (progress) => {
    decoratedProgress = progress;
  },
)?.({ downloadedBytes: 1, totalBytes: 2 });
assert.deepEqual(decoratedProgress, {
  downloadedBytes: 1,
  totalBytes: 2,
  transportKind: "relay",
  connectedVia: "relay://relay.example:22067",
});

const transferChannel = createDuplexChannel<FileTransferMessage>();
const transferMessages: FileTransferMessage[] = [];
const stopTransferObserver = transferChannel.y.receive((message) => {
  transferMessages.push(message);
  if (message.type === "transfer.begin") {
    transferChannel.y.send({
      type: "transfer.ack",
      transferId: message.transferId,
      operation: "begin",
    });
  } else if (message.type === "transfer.chunk") {
    transferChannel.y.send({
      type: "transfer.ack",
      transferId: message.transferId,
      operation: "chunk",
      chunkId: message.chunkId,
    });
  } else if (message.type === "transfer.commit") {
    transferChannel.y.send({
      type: "transfer.ack",
      transferId: message.transferId,
      operation: "commit",
    });
  }
});
const transferSink = createPortDownloadSink(transferChannel.x, "diagnostic-transfer");
await transferSink.begin({
  folderId: "documents",
  path: "large.bin",
  sizeBytes: 3,
  encrypted: false,
});
await transferSink.write(0, new Uint8Array([1, 2, 3]));
await transferSink.commit();
stopTransferObserver();
assert.deepEqual(transferMessages.map((message) => message.type), [
  "transfer.begin",
  "transfer.chunk",
  "transfer.commit",
]);
assert.deepEqual(
  Array.from(transferMessages[1].type === "transfer.chunk" ? transferMessages[1].bytes : []),
  [1, 2, 3],
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
assert.equal(supportsOngoingTransferNotifications("android-ui"), true);
assert.equal(supportsOngoingTransferNotifications("desktop-ui"), false);
assert.equal(supportsOngoingTransferNotifications("web-ui"), false);

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
const rootPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
assert.equal(resolvePackagedAppVersion(tauriConfig), rootPackage.version);

const fakeCertificate =
  "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
const remoteHandshake = new Uint8Array([
  ...encodeHelloFrame({
    device_name: "fake-syncthing",
    client_name: "syncthing",
    client_version: "v2.1.2",
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

const createFakeTlsSocket = (initialHandshake = remoteHandshake) => {
  let handshake = initialHandshake;
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
assert.equal(fakeSession.connectionScope, "lan");
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

const timeoutSocket = createFakeTlsSocket();
const timeoutClient = createSyncpeerCoreClient({
  connectTls: async () => timeoutSocket.socket,
  sha256: (data) => new Uint8Array(createHash("sha256").update(data).digest()),
  randomBytes: (length) => new Uint8Array(length),
  discoveryFetch: async () => {
    throw new Error("Discovery is not used by this timeout test.");
  },
});
const timeoutSession = await timeoutClient.openSession({
  host: "127.0.0.1",
  port: 22000,
  certPem: fakeCertificate,
  keyPem: fakeCertificate,
  deviceName: "syncpeer-timeout-regression",
  discoveryMode: "direct",
  requestTimeoutMs: 1_000,
});
await assert.rejects(
  timeoutSession.remoteFs.readFileFully("documents", "hello.txt"),
  /Request timeout|Connection closed/,
);
assert.equal(timeoutSession.isClosed(), false);
await timeoutSession.close();

const streamPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
let streamRequests = 0;
const streamFolder = {
  id: "stream-documents",
  label: "Stream documents",
  readOnly: false,
  advertisedDevices: [],
  encrypted: false,
  needsPassword: false,
  indexReceived: true,
  files: new Map([
    ["large.bin", {
      indexFile: {
        name: "large.bin",
        type: 0,
        size: streamPayload.length,
        blocks: [
          { offset: 0, size: 3, hash: new Uint8Array() },
          { offset: 3, size: 3, hash: new Uint8Array() },
          { offset: 6, size: 3, hash: new Uint8Array() },
        ],
      },
    }],
  ]),
};
const streamFs = new BuiltRemoteFs(
  new Map([[streamFolder.id, streamFolder]]),
  async (_folderId, _path, offset, size) => {
    streamRequests += 1;
    return streamPayload.slice(offset, offset + size);
  },
  async () => undefined,
  () => undefined,
);
const streamWrites: Array<{ offset: number; bytes: number[] }> = [];
let streamBegan = false;
let streamCommitted = false;
const streamed = await streamFs.readFileToSink("stream-documents", "large.bin", {
  begin: (metadata) => {
    streamBegan = metadata.sizeBytes === streamPayload.length;
  },
  write: (offset, bytes) => {
    streamWrites.push({ offset, bytes: Array.from(bytes) });
  },
  commit: () => {
    streamCommitted = true;
  },
  abort: () => undefined,
});
assert.equal(streamRequests, 3);
assert.equal(streamBegan, true);
assert.equal(streamCommitted, true);
assert.deepEqual(streamed, { bytesWritten: 9, totalBytes: 9 });
assert.deepEqual(streamWrites, [
  { offset: 0, bytes: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
]);

const pipelinedPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
const pipelinedRequests: number[] = [];
const pipelinedResolvers = new Map<number, (bytes: Uint8Array) => void>();
const pipelinedFolder = {
  ...streamFolder,
  files: new Map([
    ["pipelined.bin", {
      indexFile: {
        name: "pipelined.bin",
        type: 0,
        size: pipelinedPayload.length,
        blocks: [...pipelinedPayload].map((_value, offset) => ({
          offset,
          size: 1,
          hash: new Uint8Array(),
        })),
      },
    }],
  ]),
};
const pipelinedFs = new BuiltRemoteFs(
  new Map([[pipelinedFolder.id, pipelinedFolder]]),
  async (_folderId, _path, offset) => {
    pipelinedRequests.push(offset);
    return new Promise<Uint8Array>((resolve) => {
      pipelinedResolvers.set(offset, resolve);
    });
  },
  async () => undefined,
  () => undefined,
);
const pipelinedDownload = pipelinedFs.readFileToSink(
  pipelinedFolder.id,
  "pipelined.bin",
  {
    begin: () => undefined,
    write: () => undefined,
    commit: () => undefined,
    abort: () => undefined,
  },
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(pipelinedRequests, [0, 1, 2, 3, 4, 5]);
pipelinedResolvers.get(1)?.(pipelinedPayload.slice(1, 2));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(pipelinedRequests, [0, 1, 2, 3, 4, 5, 6]);
for (const offset of [0, 2, 3, 4, 5, 6]) {
  pipelinedResolvers.get(offset)?.(pipelinedPayload.slice(offset, offset + 1));
}
await pipelinedDownload;

let incompleteCommitted = false;
const incompleteFs = new BuiltRemoteFs(
  new Map([[streamFolder.id, streamFolder]]),
  async (_folderId, _path, offset, size) =>
    streamPayload.slice(offset, offset + (offset === 6 ? size - 1 : size)),
  async () => undefined,
  () => undefined,
);
await assert.rejects(
  incompleteFs.readFileToSink("stream-documents", "large.bin", {
    begin: () => undefined,
    write: () => undefined,
    commit: () => {
      incompleteCommitted = true;
    },
    abort: () => undefined,
  }),
  /expected 3 bytes, received 2/,
);
assert.equal(incompleteCommitted, false);

let stalledTransferRequests = 0;
const stalledTransferFolder = {
  ...streamFolder,
  files: new Map([
    ["large.bin", {
      indexFile: {
        name: "large.bin",
        type: 0,
        size: streamPayload.length,
        blocks: [{
          offset: 0,
          size: streamPayload.length,
          hash: new Uint8Array(),
        }],
      },
    }],
  ]),
};
const stalledTransferFs = new BuiltRemoteFs(
  new Map([[stalledTransferFolder.id, stalledTransferFolder]]),
  async () => {
    stalledTransferRequests += 1;
    throw new Error("Request timeout while transport is unavailable");
  },
  async () => undefined,
  () => undefined,
);
await assert.rejects(
  stalledTransferFs.readFileToSink("stream-documents", "large.bin", {
    begin: () => undefined,
    write: () => undefined,
    commit: () => undefined,
    abort: () => undefined,
  }),
  /Request timeout/,
);
assert.equal(
  stalledTransferRequests,
  3,
  "A dead transport must not retry every compatibility mode on the same session",
);

const encryptedFolderPassword = "correct horse battery staple";
const encryptedFolderId = "encrypted-documents";
const lockedFolderId = "encrypted-photos";
const encryptedFolderCrypto = await deriveUntrustedFolderCrypto(
  encryptedFolderId,
  encryptedFolderPassword,
);
const lockedFolderCrypto = await deriveUntrustedFolderCrypto(
  lockedFolderId,
  "a different password",
);
const remoteDeviceIdBytes = new Uint8Array(
  createHash("sha256").update(Buffer.from([4, 5, 6])).digest(),
);
const encryptedRemoteHandshake = new Uint8Array([
  ...encodeHelloFrame({
    device_name: "fake-syncthing",
    client_name: "syncthing",
    client_version: "v2.1.2",
  }),
  ...encodeMessageFrame(
    MessageTypeValues.CLUSTER_CONFIG,
    ClusterConfig,
    {
      folders: [
        {
          id: encryptedFolderId,
          label: "Encrypted documents",
          type: 0,
          devices: [{
            id: remoteDeviceIdBytes,
            name: "fake-syncthing",
            encryption_password_token: encryptedFolderCrypto.passwordToken,
          }],
        },
        {
          id: lockedFolderId,
          label: "Encrypted photos",
          type: 0,
          devices: [{
            id: remoteDeviceIdBytes,
            name: "fake-syncthing",
            encryption_password_token: lockedFolderCrypto.passwordToken,
          }],
        },
      ],
    },
  ),
]);
const encryptedSocket = createFakeTlsSocket(encryptedRemoteHandshake);
const encryptedClient = createSyncpeerCoreClient({
  connectTls: async () => encryptedSocket.socket,
  sha256: (data) => new Uint8Array(createHash("sha256").update(data).digest()),
  randomBytes: (length) => new Uint8Array(length),
  discoveryFetch: async () => {
    throw new Error("Discovery is not used by this encrypted-folder test.");
  },
});
const encryptedSession = await encryptedClient.openSession({
  host: "127.0.0.1",
  port: 22000,
  certPem: fakeCertificate,
  keyPem: fakeCertificate,
  deviceName: "syncpeer-encrypted-regression",
  discoveryMode: "direct",
  folderPasswords: { [encryptedFolderId]: encryptedFolderPassword },
});
const echoedEncryptedConfigs: BepClusterConfig[] = [];
const encryptedWriteParser = new FrameParser((type, message) => {
  if (type === MessageTypeValues.CLUSTER_CONFIG) {
    echoedEncryptedConfigs.push(message);
  }
});
for (const write of encryptedSocket.writes.slice(1)) {
  encryptedWriteParser.feed(write);
}
assert.equal(echoedEncryptedConfigs.length, 1);
for (const folder of echoedEncryptedConfigs[0].folders) {
  const tokenCount = folder.devices.filter(
    (device: { encryption_password_token?: Uint8Array }) =>
      device.encryption_password_token?.length > 0,
  ).length;
  assert.equal(
    tokenCount,
    1,
    `Encrypted folder ${folder.id} must echo exactly one password token.`,
  );
}
await encryptedSession.close();

const outboundShareHandshake = new Uint8Array([
  ...encodeHelloFrame({
    device_name: "untrusted-storage",
    client_name: "syncthing",
    client_version: "v2.1.2",
  }),
  ...encodeMessageFrame(
    MessageTypeValues.CLUSTER_CONFIG,
    ClusterConfig,
    { folders: [] },
  ),
]);
const outboundShareSocket = createFakeTlsSocket(outboundShareHandshake);
const outboundShareClient = createSyncpeerCoreClient({
  connectTls: async () => outboundShareSocket.socket,
  sha256: (data) => new Uint8Array(createHash("sha256").update(data).digest()),
  randomBytes: (length) => new Uint8Array(length),
  discoveryFetch: async () => {
    throw new Error("Discovery is not used by this outbound-share test.");
  },
});
const outboundShareSession = await outboundShareClient.openSession({
  host: "127.0.0.1",
  port: 22000,
  certPem: fakeCertificate,
  keyPem: fakeCertificate,
  deviceName: "syncpeer-outbound-share",
  discoveryMode: "direct",
  sharedFolders: [
    {
      id: "encrypted-by-default",
      label: "Encrypted by default",
      encryption: { mode: "encrypted", password: "syncpeer-test-only" },
    },
    {
      id: "explicitly-plaintext",
      label: "Explicitly plaintext",
      encryption: { mode: "plaintext" },
    },
  ],
});
const outboundShareConfigs: BepClusterConfig[] = [];
const outboundShareParser = new FrameParser((type, message) => {
  if (type === MessageTypeValues.CLUSTER_CONFIG) {
    outboundShareConfigs.push(message);
  }
});
for (const write of outboundShareSocket.writes.slice(1)) {
  outboundShareParser.feed(write);
}
assert.equal(outboundShareConfigs.length, 1);
const advertisedEncryptedFolder = outboundShareConfigs[0].folders.find(
  (folder) => folder.id === "encrypted-by-default",
);
assert.ok(advertisedEncryptedFolder);
assert.equal(advertisedEncryptedFolder.type, 0);
assert.equal(advertisedEncryptedFolder.devices.length, 2);
assert.equal(
  advertisedEncryptedFolder.devices.filter(
    (device) => device.encryption_password_token?.length > 0,
  ).length,
  1,
  "An encrypted outbound share must put exactly one password token on the receiving peer.",
);
const advertisedPlaintextFolder = outboundShareConfigs[0].folders.find(
  (folder) => folder.id === "explicitly-plaintext",
);
assert.ok(advertisedPlaintextFolder);
assert.equal(
  advertisedPlaintextFolder.devices.some(
    (device) => device.encryption_password_token?.length > 0,
  ),
  false,
  "Plaintext sharing must require an explicit mode and advertise no password token.",
);
await outboundShareSession.close();

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
    if (discoveryCalls === 1) {
      const timeout = Object.assign(
        new AggregateError([
          Object.assign(new Error("connect ETIMEDOUT"), {
            code: "ETIMEDOUT",
          }),
          Object.assign(new Error("connect ENETUNREACH"), {
            code: "ENETUNREACH",
          }),
        ]),
        { code: "ETIMEDOUT" },
      );
      throw timeout;
    }
    const relay = discoveryCalls === 2
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
assert.equal(retrySession.connectionScope, "wan");
assert.ok(discoveryCalls >= 3);
assert.ok(relayCalls >= 3);
await retrySession.close();

const relayRaceSocket = createFakeTlsSocket();
const relayRaceEvents: string[] = [];
let relayRaceTimeoutMs = 0;
let relayRaceDirectSettled = 0;
const relayRaceClient = createSyncpeerCoreClient({
  connectTls: async ({ host }) => {
    relayRaceEvents.push(`direct:${host}`);
    return new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("direct connection timed out")), 7_000);
    }).finally(() => {
      relayRaceDirectSettled += 1;
    });
  },
  connectRelay: async ({ relayAddress, timeoutMs }) => {
    assert.equal(relayRaceDirectSettled, 0);
    relayRaceTimeoutMs = timeoutMs ?? 0;
    relayRaceEvents.push(`relay:${relayAddress}`);
    return { socket: relayRaceSocket.socket, connectedVia: relayAddress };
  },
  sha256: () => new Uint8Array(32),
  randomBytes: (length) => new Uint8Array(length),
  discoveryFetch: async () => {
    const body = JSON.stringify({
      addresses: [
        "tcp4://10.0.0.1:22000",
        "tcp4://203.0.113.1:22000",
        "relay://relay.example:22067/?id=relay",
      ],
    });
    return {
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  },
});
const relayRaceStartedAt = Date.now();
const relayRaceSession = await relayRaceClient.openSession({
  host: "",
  port: 0,
  certPem: fakeCertificate,
  keyPem: fakeCertificate,
  expectedDeviceId: "A".repeat(52),
  deviceName: "syncpeer-relay-race-regression",
  discoveryMode: "global",
  timeoutMs: 15_000,
});
assert.equal(relayRaceSession.connectionScope, "wan");
assert.ok(Date.now() - relayRaceStartedAt < 6_000);
assert.ok(relayRaceTimeoutMs > 0 && relayRaceTimeoutMs < 10_000);
assert.ok(relayRaceEvents.includes("relay:relay://relay.example:22067/?id=relay"));
await relayRaceSession.close();

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

let repeatedRecoveryCalls = 0;
const repeatedlyRecoveredFolders = await withRecoveringSession(
  "test-options",
  async () => {
    repeatedRecoveryCalls += 1;
    return {
      remoteFs: {
        listFolders: async () => {
          if (repeatedRecoveryCalls < 3) throw new Error("Connection closed");
          return [{ id: "documents" }];
        },
        setFocusedFolder: () => undefined,
      } as unknown as RemoteFs,
      isClosed: () => repeatedRecoveryCalls < 3,
    };
  },
  "documents",
  (session) => session.remoteFs.listFolders(),
);
assert.deepEqual(repeatedlyRecoveredFolders, [{ id: "documents" }]);
assert.equal(repeatedRecoveryCalls, 3);

let cancelledRecoveryCalls = 0;
let recoveryAllowed = true;
await assert.rejects(
  withRecoveringSession(
    "test-options",
    async () => {
      cancelledRecoveryCalls += 1;
      return {
        remoteFs: {
          listFolders: async () => {
            recoveryAllowed = false;
            throw new Error("Connection closed");
          },
          setFocusedFolder: () => undefined,
        } as unknown as RemoteFs,
        isClosed: () => true,
      };
    },
    null,
    (session) => session.remoteFs.listFolders(),
    () => recoveryAllowed,
  ),
  /Connection closed/,
);
assert.equal(cancelledRecoveryCalls, 1);

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

let fakeNow = 0;
let noIndexReadDirCalls = 0;
const noIndexFolder = {
  id: "encrypted-documents",
  label: "Encrypted documents",
  readOnly: true,
  encrypted: true,
  needsPassword: false,
};
const noIndexFs: RemoteFsLike = {
  listFolders: async () => [noIndexFolder],
  requestFolderIndex: async () => undefined,
  setFocusedFolder: () => undefined,
  readDir: async () => {
    noIndexReadDirCalls += 1;
    return [];
  },
  readFileFully: async () => {
    throw new Error("readFileFully is not used by the no-index test");
  },
  writeFileFully: async () => {
    throw new Error("writeFileFully is not used by the no-index test");
  },
};
const noIndexOverview = {
  folders: [noIndexFolder],
  device: null,
  folderSyncStates: [{
    folderId: noIndexFolder.id,
    remoteIndexId: "1",
    remoteMaxSequence: "1",
    indexReceived: false,
  }],
  connectedVia: "tcp://127.0.0.1:22000",
  transportKind: "direct-tcp" as const,
};
const noIndexStore = createSyncpeerSessionStore({
  now: () => fakeNow,
  sleep: async (ms) => {
    fakeNow += ms;
  },
  transport: {
    connectAndSync: async () => noIndexFs,
    connectAndGetOverview: async () => noIndexOverview,
    connectAndGetFolderVersions: async () => noIndexOverview.folderSyncStates,
  },
});
const noIndexOptions = {
  host: "127.0.0.1",
  port: 22000,
  deviceName: "syncpeer-no-index-regression",
  discoveryMode: "direct" as const,
};
await noIndexStore.actions.connect(noIndexOptions);
await assert.rejects(
  noIndexStore.actions.openFolder(noIndexFolder.id, noIndexOptions),
  /Folder index was not received/,
);
assert.equal(noIndexStore.getState().directory.status, "error");
assert.equal(noIndexReadDirCalls, 0);

let delayedDirectoryReadCalls = 0;
const delayedDirectoryFolder = {
  id: "documents",
  label: "Documents",
  readOnly: false,
  encrypted: false,
  needsPassword: false,
};
const delayedDirectoryFs: RemoteFsLike = {
  listFolders: async () => [delayedDirectoryFolder],
  requestFolderIndex: async () => undefined,
  setFocusedFolder: () => undefined,
  waitForFolderIndex: async () => true,
  readDir: async () => {
    delayedDirectoryReadCalls += 1;
    return delayedDirectoryReadCalls === 1
      ? []
      : [{ name: "flickr", path: "flickr", type: "directory", size: 0, modifiedMs: 0 }];
  },
  readFileFully: async () => new Uint8Array(),
  writeFileFully: async () => undefined,
};
const delayedDirectoryOverview = {
  folders: [delayedDirectoryFolder],
  device: null,
  folderSyncStates: [{
    folderId: delayedDirectoryFolder.id,
    remoteIndexId: "1",
    remoteMaxSequence: "1",
    indexReceived: true,
  }],
  connectedVia: "tcp://127.0.0.1:22000",
  transportKind: "direct-tcp" as const,
};
const delayedDirectoryStore = createSyncpeerSessionStore({
  transport: {
    connectAndSync: async () => delayedDirectoryFs,
    connectAndGetOverview: async () => delayedDirectoryOverview,
    connectAndGetFolderVersions: async () => delayedDirectoryOverview.folderSyncStates,
  },
  sleep: async () => undefined,
});
await delayedDirectoryStore.actions.connect({
  host: "127.0.0.1",
  port: 22000,
  deviceName: "syncpeer-folder-regression",
  discoveryMode: "direct",
});
await delayedDirectoryStore.actions.openFolder(delayedDirectoryFolder.id);
assert.deepEqual(
  delayedDirectoryStore.getState().entries.map((entry) => entry.name),
  ["flickr"],
);
assert.equal(delayedDirectoryReadCalls, 2);

let overviewRefreshCalls = 0;
const stableFolder = {
  id: "flickr",
  label: "Flickr",
  readOnly: false,
};
const stableOverview = {
  folders: [stableFolder],
  device: {
    id: "A".repeat(52),
    deviceName: "stable-peer",
    clientName: "syncthing",
    clientVersion: "v2.1.2",
  },
  folderSyncStates: [],
  connectedVia: "tcp://127.0.0.1:22000",
  transportKind: "direct-tcp" as const,
};
const stableFs = {
  ...delayedDirectoryFs,
  listFolders: async () => [stableFolder],
} as RemoteFsLike;
const stableStore = createSyncpeerSessionStore({
  transport: {
    connectAndSync: async () => stableFs,
    connectAndGetOverview: async () => {
      overviewRefreshCalls += 1;
      return overviewRefreshCalls === 1
        ? stableOverview
        : { ...stableOverview, folders: [] };
    },
    connectAndGetFolderVersions: async () => [],
  },
  sleep: async () => undefined,
});
await stableStore.actions.connect({
  host: "127.0.0.1",
  port: 22000,
  remoteId: "A".repeat(52),
  deviceName: "syncpeer-overview-regression",
  discoveryMode: "direct",
});
await stableStore.actions.refreshOverview();
assert.deepEqual(
  stableStore.getState().folders.map((folder) => folder.id),
  ["flickr"],
);

let refreshCancellationCalls = 0;
let resolvePendingOverview: ((overview: typeof stableOverview) => void) | null = null;
let markRefreshStarted: (() => void) | null = null;
const refreshStarted = new Promise<void>((resolve) => {
  markRefreshStarted = resolve;
});
const refreshCancellationStore = createSyncpeerSessionStore({
  transport: {
    connectAndSync: async () => stableFs,
    connectAndGetOverview: async () => {
      refreshCancellationCalls += 1;
      if (refreshCancellationCalls === 1) return stableOverview;
      markRefreshStarted?.();
      return new Promise((resolve) => {
        resolvePendingOverview = resolve;
      });
    },
    connectAndGetFolderVersions: async () => [],
  },
});
const refreshCancellationOptions = {
  host: "127.0.0.1",
  port: 22000,
  deviceName: "syncpeer-refresh-cancellation-regression",
  discoveryMode: "direct" as const,
};
await refreshCancellationStore.actions.connect(refreshCancellationOptions);
const pendingRefresh = refreshCancellationStore.actions.refreshOverview();
await refreshStarted;
const pendingDisconnect = refreshCancellationStore.actions.disconnect();
await Promise.resolve();
resolvePendingOverview?.({ ...stableOverview, folders: [] });
await Promise.all([pendingRefresh, pendingDisconnect]);
assert.equal(refreshCancellationStore.getState().phase, "idle");
assert.deepEqual(
  refreshCancellationStore.getState().folders.map((folder) => folder.id),
  ["flickr"],
);

console.log("Core diagnostics passed.");
