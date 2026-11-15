import assert from "node:assert/strict";
import test from "node:test";
import { stageServiceUpload } from "../packages/core/src/sync/serviceUploadStaging.ts";
import { decodeBase64 } from "../packages/core/src/transfer/base64.ts";

const stageId = "12345678-1234-1234-1234-123456789012";
const id = "87654321-aaaa-bbbb-cccc-123456789012";
const native = () => {
  let expectedOffset = 0;
  const chunks: Uint8Array[] = [];
  const operations: string[] = [];
  const command = async (request: Record<string, unknown>): Promise<unknown> => {
    operations.push(String(request.operation));
    assert.equal(request.protocolVersion, 1);
    if (request.operation === "transferStageBegin") return { stageId };
    if (request.operation === "transferStageCancel") return { cancelled: true };
    if (request.operation === "transferStageWrite") {
      assert.equal(request.stageId, stageId);
      assert.equal(request.offset, expectedOffset);
      const bytes = decodeBase64(request.bytes as string, 64 * 1024);
      assert.ok(bytes.length <= 64 * 1024);
      chunks.push(bytes);
      expectedOffset += bytes.length;
      return { offset: expectedOffset };
    }
    if (request.operation === "transferStageFinish") {
      assert.equal(request.folderId, "folder");
      assert.equal(request.path, "keepass.kdbx");
      assert.equal(request.peerId, "A".repeat(52));
      return { id, phase: "queued" };
    }
    throw new Error("Unexpected native staging command.");
  };
  return { command, operations, chunks };
};

test("selected-file staging streams bounded chunks without whole-file buffering or target mutation", async () => {
  const bytes = Uint8Array.from({ length: 180000 }, (_, i) => i % 251);
  const file = new Blob([bytes]);
  // Intentionally disallow whole-file materialization.
  Object.defineProperty(file, "arrayBuffer", { value: () => { throw new Error("whole file read"); } });
  const { command, operations, chunks } = native();
  const progress: number[] = [];
  assert.deepEqual(await stageServiceUpload({
    command, folderId: "folder", path: "keepass.kdbx", peerId: "A".repeat(52), file,
    modifiedMs: 123, onProgress: value => { progress.push(value); },
  }), { id, phase: "queued" });
  assert.deepEqual(chunks.map(chunk => chunk.length), [65536, 65536, 48928]);
  assert.deepEqual(new Uint8Array(Buffer.concat(chunks)), bytes);
  assert.deepEqual(progress, [65536, 131072, 180000]);
  assert.deepEqual(operations, ["transferStageBegin", "transferStageWrite",
    "transferStageWrite", "transferStageWrite", "transferStageFinish"]);
});

test("pre-publication cancellation deletes stage without ever enqueueing an upload", async () => {
  const { command, operations } = native();
  const controller = new AbortController();
  await assert.rejects(stageServiceUpload({
    command, folderId: "folder", path: "keepass.kdbx", peerId: "A".repeat(52),
    file: new Blob([new Uint8Array(70000)]), modifiedMs: 1,
    signal: controller.signal, onProgress: () => controller.abort(),
  }));
  assert.deepEqual(operations, ["transferStageBegin", "transferStageWrite", "transferStageCancel"]);
});

test("empty selected file publishes a zero-byte stage without chunk IPC", async () => {
  const { command, operations } = native();
  await stageServiceUpload({ command, folderId: "folder", path: "keepass.kdbx", peerId: "A".repeat(52),
    file: new Blob([]), modifiedMs: 1 });
  assert.deepEqual(operations, ["transferStageBegin", "transferStageFinish"]);
});

test("oversized selected file is rejected before native stage allocation", async () => {
  const { command, operations } = native();
  await assert.rejects(stageServiceUpload({ command, folderId: "folder", path: "keepass.kdbx", peerId: "A".repeat(52),
    file: { size: 512 * 1024 * 1024 + 1 } as Blob, modifiedMs: 1 }), /512 MiB/);
  assert.deepEqual(operations, []);
});
