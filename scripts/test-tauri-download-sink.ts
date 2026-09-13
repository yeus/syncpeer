import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { createTauriAdapters } from "../packages/app/src/lib/tauriAdapters.ts";
import { createDocumentFilesystem, dispatchDocumentCommand } from "../packages/core/dist/filesystem.js";
import { RemoteFs } from "../packages/core/dist/core/model/remoteFs.js";
import { memoryDocumentStorage } from "./lan-test/replica-storage.ts";

const installDocumentBridge = async () => {
  const native = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = native.__TAURI__;
  const { openStorage } = memoryDocumentStorage();
  const documents = createDocumentFilesystem({ profileId: "fixture", deviceCounterId: "42", openStorage, availableBytes: async () => 1024 * 1024 * 1024,
    profile: await openStorage("profile"), randomBytes, rememberedSecret: {
      isDeviceUnlocked: async () => true, load: async () => null, save: async () => {}, remove: async () => {},
    } });
  await documents.initialize();
  await documents.createVault("synthetic-master");
  await documents.register({ id: "folder", label: "Folder", password: "synthetic-folder-password" });
  await documents.attachDownloads("folder");
  native.__TAURI__ = { core: { invoke: async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "syncpeer_list_cached_files") return [];
    if (command !== "syncpeer_document_command") throw new Error(`Unexpected native command ${command}`);
    return { result: await dispatchDocumentCommand(documents, args.request) };
  } } };
  return { documents, restore: () => { native.__TAURI__ = previous; } };
};

test("the Tauri document bridge resumes encrypted partial bytes after suspension", async () => {
  const bridge = await installDocumentBridge();
  try {
    const adapter = createTauriAdapters({ runtimePlatform: "android" }).platformAdapter;
    const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const hash = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
    const blocks = [0, 3].map(offset => ({ offset, size: 3, hash: hash(source.subarray(offset, offset + 3)) }));
    const contentId = blocks.map(block => `${block.offset}:${block.size}:${Buffer.from(block.hash).toString("hex")}`).join("|");
    const first = await adapter.createFileDownloadSink!({ folderId: "folder", path: "file", name: "file" });
    await first.begin({ folderId: "folder", path: "file", sizeBytes: 6, encrypted: false, contentId });
    await first.write(0, source.subarray(0, 3));
    await first.suspend!();
    const requests: number[] = [];
    const remote = new RemoteFs(new Map([["folder", { id: "folder", indexReceived: true,
      files: new Map([["file", { indexFile: { name: "file", size: 6,
        blocks } }]]) }]]) as never,
    async (_folder, _path, offset, size) => { requests.push(offset); return source.slice(offset, offset + size); });
    const resumed = await adapter.createFileDownloadSink!({ folderId: "folder", path: "file", name: "file" });
    await remote.readFileToSink("folder", "file", resumed);
    assert.deepEqual(requests, [3]);
    const [cached] = await adapter.listCachedFiles!();
    assert.deepEqual(await adapter.readBinaryFile!(cached.localPath!), source);
  } finally { await bridge.documents.close(); bridge.restore(); }
});

test("the Tauri document bridge forwards complete download identity", async () => {
  const native = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = native.__TAURI__;
  let beginRequest: Record<string, unknown> | null = null;
  native.__TAURI__ = { core: { invoke: async (command: string, args: { request: Record<string, unknown> }) => {
    if (command !== "syncpeer_document_command") throw new Error(`Unexpected native command ${command}`);
    if (args.request.operation === "cacheRegistrations") return { result: { folders: [{ id: "folder", label: "Folder", storageId: "0123456789abcdef0123456789abcdef", downloads: true }] } };
    if (args.request.operation === "beginDownload") { beginRequest = args.request; return { result: 1 }; }
    if (args.request.operation === "downloadRanges") return { result: [] };
    if (args.request.operation === "release") return { result: undefined };
    throw new Error(`Unexpected document operation ${args.request.operation}`);
  } } };
  try {
    const sink = await createTauriAdapters({ runtimePlatform: "android" }).platformAdapter.createFileDownloadSink!({
      folderId: "folder", path: "file", name: "file", modifiedMs: 123,
    });
    await sink.begin({ sourceDeviceId: "device", folderId: "folder", path: "file",
      sizeBytes: 6, encrypted: true, contentId: "blocks:test" });
    await sink.abort(new Error("done"));
    assert.deepEqual(beginRequest, { operation: "beginDownload", folderId: "folder", path: "file",
      size: 6, modifiedMs: 123, expectedLocalHash: undefined, encrypted: true,
      sourceDeviceId: "device", contentId: "blocks:test" });
  } finally { native.__TAURI__ = previous; }
});
