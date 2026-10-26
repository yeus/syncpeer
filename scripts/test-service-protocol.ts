import assert from "node:assert/strict";
import test from "node:test";
import { SERVICE_PROTOCOL_VERSION, parseServiceCommand, parseServiceResponse,
  withServiceProtocol } from "../packages/core/src/sync/serviceProtocol.ts";

test("service commands are versioned and reject unsafe paths", () => {
  assert.equal(SERVICE_PROTOCOL_VERSION, 1);
  const connect = parseServiceCommand(withServiceProtocol({ operation: "connect",
    options: { host: "synthetic.invalid", port: 22000, deviceName: "synthetic" } }));
  assert.equal(connect.operation, "connect");
  assert.throws(() => parseServiceCommand({ operation: "status" }), /protocol/i);
  assert.throws(() => parseServiceCommand({ ...withServiceProtocol({ operation: "status" }), protocolVersion: 2 }),
    /protocol/i);
  assert.throws(() => parseServiceCommand(withServiceProtocol({ operation: "readDir",
    folderId: "folder", path: "../secret" })), /path/i);
  assert.throws(() => parseServiceCommand(withServiceProtocol({ operation: "readDir",
    folderId: "folder", path: "/absolute" })), /path/i);
  assert.throws(() => parseServiceCommand(withServiceProtocol({ operation: "unknown" })),
    /command/i);
});

test("service responses validate overviews, pages, status and transfer frames", () => {
  const overview = parseServiceResponse("overview", withServiceProtocol({ operation: "overview" }).protocolVersion
    ? { folders: [{ id: "f", label: "F", readOnly: false }], folderSyncStates: [],
      connectedVia: "synthetic", transportKind: "direct-tcp" }
    : {});
  assert.ok(overview && typeof overview === "object");
  const page = parseServiceResponse("readDir", { entries: [{ name: "a", path: "a",
    type: "file", size: 3, modifiedMs: 0 }], nextOffset: null, total: 1 });
  assert.equal((page as { entries: unknown[] }).entries.length, 1);
  const status = parseServiceResponse("status", { phase: "connected", active: true,
    revision: 4, foreground: true, peerPhase: "reconnecting" });
  assert.equal((status as { peerPhase: string }).peerPhase, "reconnecting");
  const block = { offset: 0, size: 3, hash: Array(32).fill(0) };
  const begin = parseServiceResponse("downloadPull", { type: "begin",
    metadata: { folderId: "f", path: "a", sizeBytes: 3, encrypted: false } });
  assert.equal((begin as { type: string }).type, "begin");
  assert.throws(() => parseServiceResponse("downloadPull", { type: "begin",
    metadata: { folderId: "f", path: "a", sizeBytes: 3, encrypted: false, blocks: [block] } }),
  /response/i);
  const blocks = parseServiceResponse("downloadPull", { type: "metadataBlocks", offset: 0, blocks: [block] });
  assert.equal((blocks as { blocks: unknown[] }).blocks.length, 1);
  assert.throws(() => parseServiceResponse("downloadPull", { type: "metadataBlocks", offset: 0,
    blocks: [{ ...block, hash: Array(31).fill(0) }] }), /response/i);
  assert.equal((parseServiceResponse("downloadPull", { type: "chunk", offset: 0,
    bytes: "AQID" }) as { type: string }).type, "chunk");
  assert.throws(() => parseServiceResponse("downloadPull", { type: "chunk", offset: 0,
    bytes: [1, 2, 3] }), /response/i);
  assert.equal((parseServiceResponse("uploadPoll", { type: "need", requestId: "r",
    offset: 0, size: 3 }) as { type: string }).type, "need");
  assert.equal((parseServiceResponse("uploadPoll", { type: "done" }) as { type: string }).type, "done");
  assert.throws(() => parseServiceResponse("uploadPoll", { type: "unknown" }), /response/i);
  assert.throws(() => parseServiceResponse("overview", { folders: [] }), /response/i);
});
