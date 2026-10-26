import assert from "node:assert/strict";
import test from "node:test";
import { createServiceOwnedSession } from "../packages/core/src/sync/serviceRemoteFs.ts";
import { createServiceDownloadBridge } from "../packages/core/src/sync/serviceDownloadBridge.ts";
import { decodeBase64, encodeBase64 } from "../packages/core/src/transfer/base64.ts";

test("service-owned session browses, downloads and uploads without a second peer connection", async () => {
  const supplied: number[] = [];
  const packets = [
    { type: "begin", metadata: { folderId: "folder", path: "a.txt", sizeBytes: 3, encrypted: false } },
    { type: "metadataEnd", blockCount: 0, hasBlockPlan: false },
    { type: "chunk", offset: 0, bytes: encodeBase64(Uint8Array.from([1, 2, 3])) },
    { type: "commit" },
  ];
  const rpc = async (request: Record<string, unknown>): Promise<unknown> => {
    switch (request.operation) {
      case "connect": return { phase: "connected" };
      case "overview": return { folders: [{ id: "folder", label: "A", readOnly: false }],
        device: { id: "remote", deviceName: "peer", clientName: "syncthing", clientVersion: "1" },
        folderSyncStates: [], connectedVia: "synthetic", transportKind: "direct-tcp" };
      case "listFolders": return [{ id: "folder", label: "A", readOnly: false }];
      case "readDir": return { entries: [{ name: "a.txt", path: "a.txt", type: "file", size: 3, modifiedMs: 0 }],
        nextOffset: null, total: 1 };
      case "downloadStart": return { transferId: "d1" };
      case "downloadPull": return packets.shift() ?? { type: "error", message: "No frames" };
      case "uploadStart": return { uploadId: "u1" };
      case "uploadPoll": {
        if (supplied.length) return { type: "done" };
        return { type: "need", requestId: "r1", offset: 0, size: 3 };
      }
      case "uploadProvide": supplied.push(...decodeBase64(request.bytes as string)); return { accepted: true };
      default: throw Error("Unexpected service operation: " + String(request.operation));
    }
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "remote",
  } as never);
  assert.equal(session.remoteDeviceId, "remote");
  assert.equal(session.remoteFs.getRemoteDeviceInfo()?.deviceName, "peer");
  assert.equal((await session.remoteFs.readDir("folder", "")).length, 1);
  const chunks: number[] = [];
  await session.remoteFs.readFileToSink("folder", "a.txt", {
    begin: () => undefined,
    write: (_offset, bytes) => { chunks.push(...bytes); },
    commit: () => undefined,
    abort: () => undefined,
  });
  assert.deepEqual(chunks, [1, 2, 3]);
  await session.remoteFs.writeFileStream("folder", "b.txt", {
    size: 3, read: async () => new Uint8Array([4, 5, 6]),
  });
  assert.deepEqual(supplied, [4, 5, 6]);
  await session.close();
});
test("service-owned UI notices a dead background peer and emits a transport closure", async () => {
  let active = true, checks = 0;
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "connected" };
    if (request.operation === "overview") return {
      folders: [], folderSyncStates: [], connectedVia: "service", transportKind: "direct-tcp",
    };
    if (request.operation === "status") {
      checks++;
      return { active, phase: active ? "connected" : "waiting" };
    }
    throw Error("Unexpected operation.");
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never, undefined, 20);
  try {
    active = false;
    const closure = await Promise.race([
      session.closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(Error("No stale notification.")), 350)),
    ]);
    assert.equal(closure.kind, "transport");
    assert.equal(session.isClosed(), true);
    assert.ok(checks > 0);
  } finally {
    await session.close();
  }
});

test("service proxy rebuilds authenticated large block plans before beginning a sink", async () => {
  const blocks = Array.from({ length: 1024 }, (_, i) => ({
    offset: i * 512, size: 512, hash: new Uint8Array(32).fill(i % 256),
  }));
  const bridge = createServiceDownloadBridge(async (_folder, _path, sink) => {
    await sink.begin({ folderId: "folder", path: "large", sizeBytes: 1024 * 512,
      encrypted: false, blocks });
    await sink.commit();
  });
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "connected" };
    if (request.operation === "overview") return { folders: [],
      folderSyncStates: [], connectedVia: "test", transportKind: "direct-tcp" };
    if (request.operation === "downloadStart") return { transferId: bridge.start("folder", "large") };
    if (request.operation === "downloadPull") return bridge.pull(String(request.transferId));
    if (request.operation === "downloadCancel") { bridge.cancel(String(request.transferId)); return {}; }
    throw Error("Unexpected service command.");
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never);
  let received = 0;
  try {
    await session.remoteFs.readFileToSink("folder", "large", {
      begin: metadata => {
        received = metadata.blocks?.length ?? 0;
        assert.deepEqual(metadata.blocks?.[128]?.hash, blocks[128]?.hash);
      },
      write: () => undefined, commit: () => undefined, abort: () => undefined,
    });
    assert.equal(received, blocks.length);
  } finally {
    await session.close();
  }
});


const downloadSession = async (packets: unknown[], run: (
  session: Awaited<ReturnType<typeof createServiceOwnedSession>>,
) => Promise<void>) => {
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "connected" };
    if (request.operation === "overview") return { folders: [],
      folderSyncStates: [], connectedVia: "test", transportKind: "direct-tcp" };
    if (request.operation === "downloadStart") return { transferId: "d1" };
    if (request.operation === "downloadPull") return packets.shift() ?? { type: "error", message: "No frames" };
    if (request.operation === "downloadCancel") return { cancelled: true };
    throw Error("Unexpected service command.");
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never);
  try { await run(session); } finally { await session.close(); }
};

test("service proxy rejects malformed metadata sequences", async () => {
  const base = { folderId: "folder", path: "a.txt", sizeBytes: 4, encrypted: false };
  const cases: Array<{ packets: unknown[]; message: RegExp; began: boolean }> = [
    { packets: [{ type: "begin", metadata: base }, { type: "chunk", offset: 0, bytes: [1] }],
      message: /before complete metadata/i, began: false },
    { packets: [{ type: "begin", metadata: base },
      { type: "metadataBlocks", offset: 1, blocks: [{ offset: 0, size: 4, hash: Array(32).fill(0) }] }],
      message: /block offsets/i, began: false },
    { packets: [{ type: "begin", metadata: base },
      { type: "metadataEnd", blockCount: 0, hasBlockPlan: false },
      { type: "metadataEnd", blockCount: 0, hasBlockPlan: false }],
      message: /ended more than once/i, began: true },
    { packets: [{ type: "begin", metadata: base },
      { type: "metadataBlocks", offset: 0, blocks: [{ offset: 0, size: 4, hash: [1, 2, 3] }] }],
      message: /block descriptor/i, began: false },
    { packets: [{ type: "begin", metadata: base },
      { type: "metadataEnd", blockCount: 1, hasBlockPlan: true }],
      message: /end marker/i, began: false },
  ];
  for (const { packets, message, began: expectedBegan } of cases) {
    let began = false, aborted = false;
    await downloadSession(packets, async session => {
      await assert.rejects(session.remoteFs.readFileToSink("folder", "a.txt", {
        begin: () => { began = true; },
        write: () => undefined, commit: () => undefined,
        abort: () => { aborted = true; },
      }), message);
    });
    assert.equal(began, expectedBegan, "Sink begin must follow complete validated metadata.");
    assert.equal(aborted, expectedBegan, "A begun sink must be aborted on a metadata failure.");
  }
});

test("service proxy aborts a begun sink when later block chunks are malformed", async () => {
  let aborted = false;
  await downloadSession([
    { type: "begin", metadata: { folderId: "folder", path: "a.txt", sizeBytes: 4, encrypted: false } },
    { type: "metadataEnd", blockCount: 0, hasBlockPlan: false },
    { type: "chunk", offset: 0, bytes: [1, 2, 3, 4] },
    { type: "chunk", offset: 4, bytes: "!!!!" },
    { type: "commit" },
  ], async session => {
    await assert.rejects(session.remoteFs.readFileToSink("folder", "a.txt", {
      begin: () => undefined, write: () => undefined, commit: () => undefined,
      abort: () => { aborted = true; },
    }), /Invalid remote download chunk/);
  });
  assert.equal(aborted, true);
});

test("service proxy uses pushed status revisions and ignores stale replay", async () => {
  let listener: ((event: unknown) => void) | null = null;
  let unsubscribed = false;
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "connected" };
    if (request.operation === "overview") return { folders: [],
      folderSyncStates: [], connectedVia: "test", transportKind: "direct-tcp" };
    if (request.operation === "status") return { phase: "connected", active: true,
      revision: 5, foreground: true };
    throw Error("Unexpected service command.");
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never, undefined, 60_000, async subscribe => {
    listener = subscribe;
    return () => { unsubscribed = true; };
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(listener);
    listener!({ type: "sessionStatus", revision: 4, phase: "idle", active: false,
      foreground: true, error: "stale" });
    assert.equal(session.isClosed(), false);
    listener!({ type: "sessionStatus", revision: 6, phase: "connected", active: true,
      foreground: true, peerPhase: "reconnecting", peerError: "Peer is reconnecting." });
    assert.equal(session.isClosed(), false);
    listener!({ type: "sessionStatus", revision: 7, phase: "error", active: false,
      foreground: false, error: "Peer session failed." });
    const closure = await session.closed;
    assert.equal(closure.kind, "transport");
    assert.match(closure.message, /failed/i);
    assert.equal(unsubscribed, true);
  } finally {
    await session.close();
  }
});

test("service proxy orders focused-folder updates ahead of later reads", async () => {
  const calls: string[] = [];
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "connected" };
    if (request.operation === "overview") return { folders: [],
      folderSyncStates: [], connectedVia: "test", transportKind: "direct-tcp" };
    if (request.operation === "status") return { phase: "connected", active: true, revision: 1 };
    if (request.operation === "setFocusedFolder") {
      calls.push("focus:" + String(request.folderId));
      return { focused: request.folderId };
    }
    if (request.operation === "readDir") {
      calls.push("read");
      return { entries: [], nextOffset: null, total: 0 };
    }
    throw Error("Unexpected service command.");
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never);
  try {
    session.remoteFs.setFocusedFolder("folder");
    assert.deepEqual(await session.remoteFs.readDir("folder", ""), []);
    session.remoteFs.setFocusedFolder("folder");
    assert.deepEqual(calls, ["focus:folder", "read"]);
  } finally {
    await session.close();
  }
});
