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
test("Android session forwards new folder credentials to the live BEP peer without reconnecting", async () => {
  let connected = 0;
  let passwords: Record<string, string> = {};
  const folder = () => ({
    id: "camera", label: "Camera", readOnly: true, encrypted: true,
    needsPassword: passwords.camera !== "synthetic-correct-password",
    passwordError: passwords.camera && passwords.camera !== "synthetic-correct-password"
      ? "Encryption password does not match this folder." : null,
  });
  const rpc = async (request: Record<string, unknown>) => {
    switch (request.operation) {
      case "connect": connected++; return { phase: "connected" };
      case "status": return { phase: "connected", active: true };
      case "overview": return { folders: [folder()], folderSyncStates: [],
        connectedVia: "native", transportKind: "direct-tcp" };
      case "listFolders": return [folder()];
      case "updateFolderPasswords":
        passwords = { ...(request.folderPasswords as Record<string, string>) };
        return { updated: true };
      default: throw new Error("Unexpected operation " + request.operation);
    }
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never);
  try {
    assert.equal((await session.remoteFs.listFolders())[0].needsPassword, true);
    await session.updateFolderPasswords?.({ camera: "synthetic-wrong-password" });
    assert.equal((await session.remoteFs.listFolders())[0].passwordError,
      "Encryption password does not match this folder.");
    await session.updateFolderPasswords?.({ camera: "synthetic-correct-password" });
    assert.equal((await session.remoteFs.listFolders())[0].needsPassword, false);
    assert.equal(connected, 1, "password changes must not reconnect or wait for app restart");
  } finally { await session.close(); }
});

test("transient service RPC unavailability does not permanently detach a recovering peer proxy", async () => {
  let reads = 0;
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "connected" };
    if (request.operation === "overview") return {
      folders: [], folderSyncStates: [], connectedVia: "service", transportKind: "direct-tcp",
    };
    if (request.operation === "status") return { active: true, phase: "reconnecting" };
    if (request.operation === "readDir") {
      if (reads++ === 0) throw new Error("Android service session unavailable");
      return { entries: [], nextOffset: null, total: 0 };
    }
    throw new Error(`Unexpected operation: ${String(request.operation)}`);
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never);
  try {
    await assert.rejects(session.remoteFs.readDir("folder", ""), /session unavailable/);
    assert.equal(session.isClosed(), false);
    assert.deepEqual(await session.remoteFs.readDir("folder", ""), []);
    assert.equal(session.isClosed(), false);
  } finally {
    await session.close();
  }
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

test("service-owned UI remains attached while the active peer temporarily reconnects", async () => {
  let phase = "connected";
  let checks = 0;
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "connected" };
    if (request.operation === "overview") return {
      folders: [], folderSyncStates: [], connectedVia: "service", transportKind: "direct-tcp",
    };
    if (request.operation === "status") {
      checks++;
      return { active: true, phase };
    }
    throw Error("Unexpected operation.");
  };
  const session = await createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never, undefined, 20);
  try {
    for (const next of ["starting", "reconnecting", "waiting", "connected"]) {
      phase = next;
      const before = checks;
      const deadline = Date.now() + 200;
      while (checks === before && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(checks > before, `Heartbeat did not observe ${next}.`);
      assert.equal(session.isClosed(), false, `Transient ${next} detached a live service proxy.`);
    }
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
    listener!({ type: "sessionStatus", revision: 7, phase: "waiting", active: true,
      foreground: true, peerPhase: "idle" });
    assert.equal(session.isClosed(), false, "Transient idle peer during service recovery must not detach.");
    listener!({ type: "sessionStatus", revision: 8, phase: "reconnecting", active: true,
      foreground: true, peerPhase: "error", peerError: "Retrying peer session." });
    assert.equal(session.isClosed(), false, "Transient peer error during service recovery must not detach.");
    listener!({ type: "sessionStatus", revision: 9, phase: "error", active: false,
      foreground: false, error: "Peer session failed." });
    const closure = await session.closed;
    assert.equal(closure.kind, "transport");
    assert.match(closure.message, /failed/i);
    assert.equal(unsubscribed, true);
  } finally {
    await session.close();
  }
});

test("a transient service reconnect is acknowledged by pushed status without redialing", async () => {
  let listener: ((value: unknown) => void) | undefined;
  let phase = "reconnecting", connects = 0, stopped = 0;
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") { connects++; return { phase: "reconnecting" }; }
    if (request.operation === "status") return { phase, peerPhase: phase,
      revision: phase === "connected" ? 2 : 1, active: true, foreground: true };
    if (request.operation === "overview") {
      assert.equal(phase, "connected");
      return { folders: [], folderSyncStates: [], connectedVia: "test", transportKind: "direct-tcp" };
    }
    throw Error("Unexpected service command.");
  };
  const connecting = createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never, undefined, 60_000, async handler => {
    listener = handler;
    return () => { stopped++; };
  });
  for (let i = 0; i < 10 && !listener; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(listener);
  assert.equal(connects, 1);
  phase = "connected";
  listener({ type: "sessionStatus", revision: 2, phase, peerPhase: phase,
    active: true, foreground: true });
  const session = await connecting;
  try {
    assert.equal(session.transportKind, "direct-tcp");
    assert.equal(connects, 1, "A status transition must not create a competing peer session.");
    assert.ok(stopped >= 1, "Temporary status subscription must be released.");
  } finally { await session.close(); }
});

test("inactive startup and stale idle events do not reject a pending native connection", async () => {
  let listener: ((value: unknown) => void) | undefined;
  let phase = "starting", subscriptions = 0;
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "starting" };
    if (request.operation === "status") return { phase,
      active: phase === "connected", revision: phase === "connected" ? 5 : 2, foreground: false };
    if (request.operation === "overview") return { folders: [], folderSyncStates: [],
      connectedVia: "test", transportKind: "direct-tcp" };
    throw Error("Unexpected service operation.");
  };
  const connecting = createServiceOwnedSession(rpc, { remoteId: "peer" } as never,
    undefined, 60_000, async handler => {
      if (subscriptions++ === 0) {
        listener = handler;
        handler({ type: "sessionStatus", revision: 3, phase: "starting",
          active: false, foreground: false });
      }
      return () => undefined;
    });
  for (let i = 0; i < 10 && !listener; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(listener);
  listener({ type: "sessionStatus", revision: 4, phase: "idle",
    active: false, foreground: false });
  phase = "connected";
  listener({ type: "sessionStatus", revision: 5, phase: "connected", peerPhase: "reconnecting",
    active: true, foreground: false });
  const session = await connecting;
  assert.equal(session.isClosed(), false);
  await session.close();
});

test("stale idle connection reply reconciles with a live native reconnect", async () => {
  let listener: ((value: unknown) => void) | undefined;
  let phase = "reconnecting";
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "idle" };
    if (request.operation === "status") return { phase, peerPhase: phase,
      active: true, foreground: true, revision: 4 };
    if (request.operation === "overview") return { folders: [], folderSyncStates: [],
      connectedVia: "test", transportKind: "direct-tcp" };
    throw Error("Unexpected service operation.");
  };
  const connecting = createServiceOwnedSession(rpc, { remoteId: "peer" } as never,
    undefined, 60_000, async handler => {
      listener = handler;
      return () => undefined;
    });
  for (let i = 0; i < 10 && !listener; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(listener);
  phase = "connected";
  listener({ type: "sessionStatus", revision: 5, phase, peerPhase: phase,
    active: true, foreground: true });
  const session = await connecting;
  assert.equal(session.isClosed(), false);
  await session.close();
});

test("native connect cancellation is reconciled against an authenticated live session", async () => {
  let listener: ((value: unknown) => void) | undefined;
  let phase = "reconnecting";
  let connections = 0;
  let subscriptionsClosed = 0;
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") {
      connections++;
      throw new Error("Android service session unavailable: java.lang.IllegalStateException: Connection attempt was cancelled.");
    }
    if (request.operation === "status") return { phase, active: phase === "connected",
      revision: phase === "connected" ? 8 : 7, foreground: true };
    if (request.operation === "overview") {
      assert.equal(phase, "connected");
      return { folders: [], folderSyncStates: [], connectedVia: "test", transportKind: "direct-tcp" };
    }
    throw new Error("Unexpected service operation.");
  };
  // Attach a rejection handler before asserting the pushed status; the old
  // implementation rejects synchronously instead of subscribing for recovery.
  const outcome = createServiceOwnedSession(rpc, { remoteId: "peer" } as never,
    undefined, 60_000, async handler => {
      listener = handler;
      return () => { subscriptionsClosed++; };
    }).then(value => ({ value }), error => ({ error }));
  for (let i = 0; i < 10 && !listener; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(listener, "A cancelled opening must listen for an authenticated replacement.");
  phase = "connected";
  listener({ type: "sessionStatus", revision: 8, phase, active: true, foreground: true });
  const result = await outcome;
  if ("error" in result) throw result.error;
  assert.equal(connections, 1, "Recovery must not issue a second peer connect.");
  assert.equal(subscriptionsClosed, 1);
  assert.equal(result.value.isClosed(), false);
  await result.value.close();
});

test("a native recovery cannot acknowledge a different authenticated peer", async () => {
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "connected" };
    if (request.operation === "overview") return { folders: [], folderSyncStates: [],
      connectedVia: "test", transportKind: "direct-tcp",
      device: { id: "OTHERPEER", deviceName: "Peer B", clientName: "test", clientVersion: "1" } };
    throw new Error("Unexpected service operation.");
  };
  await assert.rejects(createServiceOwnedSession(rpc, {
    remoteId: "EXPECTEDPEER",
  } as never), /different authenticated peer/);
});

test("a genuine native service connect rejection is not converted to a retry", async () => {
  let subscribed = false;
  await assert.rejects(createServiceOwnedSession(async () => {
    throw new Error("Peer identity is not authorized.");
  }, { remoteId: "peer" } as never, undefined, 60_000, async () => {
    subscribed = true;
    return () => undefined;
  }), /not authorized/);
  assert.equal(subscribed, false);
});

test("a transient service connect rejects terminal status and cleans up listeners", async () => {
  let listener: ((value: unknown) => void) | undefined;
  let unsubscribed = false;
  const rpc = async (request: Record<string, unknown>) => {
    if (request.operation === "connect") return { phase: "waiting" };
    if (request.operation === "status") return { phase: "waiting", active: true, foreground: true };
    throw Error("Unexpected service command.");
  };
  const connecting = createServiceOwnedSession(rpc, {
    host: "127.0.0.1", port: 22000, remoteId: "peer",
  } as never, undefined, 60_000, async handler => {
    listener = handler;
    return () => { unsubscribed = true; };
  });
  for (let i = 0; i < 10 && !listener; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(listener);
  listener({ type: "sessionStatus", revision: 3, phase: "error", active: false,
    foreground: true, error: "Synthetic terminal disconnect." });
  await assert.rejects(connecting, /Synthetic terminal disconnect/);
  assert.equal(unsubscribed, true);
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
