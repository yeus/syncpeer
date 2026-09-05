import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createTauriAdapters } from "../packages/app/src/lib/tauriAdapters.ts";
import { RemoteFs } from "../packages/core/dist/core/model/remoteFs.js";

test("a new Tauri sink reuses verified partial bytes after suspension", async () => {
  const native = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = native.__TAURI__;
  let partial = new Uint8Array(0);
  const hash = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
  native.__TAURI__ = { core: { invoke: async (command: string, args: { request: { source?: string; offset: number; bytes: number[]; ranges: { offset: number; size: number }[] } }) => {
    const request = args.request;
    if (command === "syncpeer_cache_begin_file") return { transferId: "retained-partial" };
    if (command === "syncpeer_cache_digest_ranges") return request.source === "cached" ? [] : request.ranges.filter(range => range.offset + range.size <= partial.length).map(range => ({ ...range, hash: Array.from(hash(partial.subarray(range.offset, range.offset + range.size))) }));
    if (command === "syncpeer_cache_write_chunk") {
      const next = new Uint8Array(Math.max(partial.length, request.offset + request.bytes.length));
      next.set(partial); next.set(request.bytes, request.offset); partial = next; return;
    }
    if (command === "syncpeer_cache_commit" || command === "syncpeer_cache_suspend") return;
    throw new Error(`Unexpected native command ${command}`);
  } } };
  try {
    const adapter = createTauriAdapters().platformAdapter;
    const source = new Uint8Array([1,2,3,4,5,6]);
    const first = await adapter.createFileDownloadSink!({ folderId: "folder", path: "file", name: "file" });
    await first.begin({ folderId: "folder", path: "file", sizeBytes: 6, encrypted: false, contentId: "content" });
    await first.write(0, source.subarray(0,3));
    await first.suspend!();
    const requests: number[] = [];
    const remote = new RemoteFs(new Map([["folder", { id: "folder", indexReceived: true, files: new Map([["file", { indexFile: { name: "file", size: 6, blocks: [0,3].map(offset => ({ offset, size: 3, hash: hash(source.subarray(offset,offset+3)) })) } }]]) }]]) as never,
      async (_folder, _path, offset, size) => { requests.push(offset); return source.slice(offset, offset + size); });
    const resumed = await adapter.createFileDownloadSink!({ folderId: "folder", path: "file", name: "file" });
    await remote.readFileToSink("folder", "file", resumed);
    assert.deepEqual(requests, [3]);
    assert.deepEqual(partial, source);
  } finally { native.__TAURI__ = previous; }
});
