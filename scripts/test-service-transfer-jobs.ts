import assert from "node:assert/strict";
import test from "node:test";
import { createServiceTransferJobs, type ServiceTransferProgress } from "../packages/core/src/sync/serviceTransferJobs.ts";
import type { DocumentFilesystem } from "../packages/core/src/sync/documentFilesystem.ts";
import type { RemoteFs } from "../packages/core/src/core/model/remoteFs.ts";

const job = (id: string, direction: "download" | "upload" = "download") =>
  ({ id, direction, folderId: "folder", path: "keepass.kdbx" });
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Timed out observing service job.");
};

const fixture = () => {
  const events: string[] = [];
  const status: ServiceTransferProgress[] = [];
  const bytes = new Uint8Array([1, 2, 3]);
  const documents = {
    status: async () => ({ folders: [{ id: "folder", downloads: true, browseOnly: false }] }),
    cachedFiles: async () => [],
    digestCachedFiles: async () => [{ hash: "a".repeat(64) }],
    beginDownload: async () => { events.push("begin"); return 7; },
    write: async (_handle: number, _offset: number, chunk: Uint8Array) => {
      events.push("write:" + chunk.length);
    },
    finishDownload: async () => { events.push("commit"); },
    release: async (_id: number, abort?: boolean) => { events.push(abort ? "abort" : "release"); },
  } as unknown as DocumentFilesystem;
  const remote = {
    readDir: async () => [{ path: "keepass.kdbx", type: "file", modifiedMs: 120 }],
    readFileToSink: async (_folder: string, _path: string, sink: {
      begin: (value: unknown) => Promise<void> | void; write: (offset: number, bytes: Uint8Array) => Promise<void> | void;
      commit: () => Promise<void> | void;
    }, onProgress: (value: { downloadedBytes: number; totalBytes: number }) => void) => {
      await sink.begin({ folderId: "folder", path: "keepass.kdbx", sizeBytes: bytes.length, encrypted: false });
      await sink.write(0, bytes);
      onProgress({ downloadedBytes: bytes.length, totalBytes: bytes.length });
      await sink.commit();
    },
  } as unknown as RemoteFs;
  const executor = createServiceTransferJobs({ documents, remoteFs: () => remote, progress: p => { status.push(p); } });
  return { events, status, documents, remote, executor };
};

test("native download completes without WebView chunk polling, into an encrypted document draft", async () => {
  const { executor, status, events } = fixture();
  assert.deepEqual(executor.start(job("12345678-abcd")), { started: true });
  await wait(() => status.some(p => p.phase === "completed"));
  assert.deepEqual(events, ["begin", "write:3", "commit"]);
  assert.equal(status.at(-1)?.transferredBytes, 3);
});

test("duplicate native job ID does not launch a second download", async () => {
  const { executor, status, events } = fixture();
  const request = job("87654321-abcd");
  executor.start(request);
  assert.deepEqual(executor.start(request), { started: false });
  await wait(() => status.some(p => p.phase === "completed"));
  assert.deepEqual(executor.start(request), { started: false });
  assert.equal(events.filter(v => v === "begin").length, 1);
});

test("cancelled download releases its draft and cannot publish a partially written file", async () => {
  const { executor, status, events, remote } = fixture();
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  remote.readFileToSink = (async (_folder: string, _path: string, sink: {
    begin: (metadata: unknown) => Promise<void>; write: (offset: number, bytes: Uint8Array) => Promise<void>;
    commit: () => Promise<void>;
  }) => {
    await sink.begin({ folderId: "folder", path: "keepass.kdbx", sizeBytes: 3, encrypted: false });
    await sink.write(0, new Uint8Array([1]));
    await gate;
    await sink.commit();
  }) as never;
  executor.start(job("aaaaaaaa-1234"));
  await wait(() => events.includes("write:1"));
  executor.cancel("aaaaaaaa-1234");
  resume();
  await wait(() => status.some(p => p.phase === "cancelled"));
  assert.ok(events.includes("abort"));
  assert.ok(!events.includes("commit"), "Cancellation must not publish a truncated document.");
});

test("native jobs reject internal replica targets before any document access", () => {
  const { executor } = fixture();
  assert.throws(() => executor.start({ ...job("bbbbbbbb-4321"), path: ".syncpeer-secret" }),
    /Private documents/);
});

test("upload job reads the existing encrypted document rather than WebView bytes", async () => {
  const { documents, events, status } = fixture();
  documents.cachedFiles = (async () => [{
    folderId: "folder", path: "keepass.kdbx", localPath: 'syncpeer-document:["stored","keepass.kdbx"]',
    modifiedMs: 123,
  }]) as never;
  documents.open = (async () => { events.push("open"); return 8; }) as never;
  documents.size = (async () => 3) as never;
  documents.read = (async () => new Uint8Array([1, 2, 3])) as never;
  const remote = { writeFileStream: async (_folder: string, _path: string, source: {
    read: (offset: number, size: number) => Promise<Uint8Array>;
  }) => { assert.deepEqual(await source.read(0, 3), new Uint8Array([1, 2, 3])); events.push("uploaded"); } } as unknown as RemoteFs;
  const executor = createServiceTransferJobs({ documents, remoteFs: () => remote,
    progress: p => { status.push(p); } });
  executor.start(job("cccccccc-4321", "upload"));
  await wait(() => status.some(p => p.phase === "completed"));
  assert.deepEqual(events, ["open", "uploaded", "release"]);
});

test("upload without a native encrypted source fails safely", async () => {
  const { documents, status } = fixture();
  const remote = { writeFileStream: async () => { throw new Error("Must not be called"); } } as unknown as RemoteFs;
  const executor = createServiceTransferJobs({ documents, remoteFs: () => remote,
    progress: p => { status.push(p); } });
  executor.start(job("dddddddd-1234", "upload"));
  await wait(() => status.some(p => p.phase === "failed"));
  assert.equal(status.at(-1)?.phase, "failed");
});

test("service-owned staged upload uses immutable native source in bounded reads", async () => {
  const { documents, status } = fixture();
  const bytes = Uint8Array.from({ length: 150000 }, (_, i) => i % 233);
  const reads: number[] = [];
  const remote = { writeFileStream: async (_folder: string, _path: string,
    source: { size: number; read: (offset: number, length: number) => Promise<Uint8Array> },
    options: { expectedHash?: string; modifiedMs?: number }) => {
    assert.equal(source.size, bytes.length);
    assert.equal(options.expectedHash, "a".repeat(64));
    assert.equal(options.modifiedMs, 123456);
    assert.deepEqual(await source.read(4096, 140000), bytes.slice(4096, 144096));
  } } as unknown as RemoteFs;
  const executor = createServiceTransferJobs({ documents, remoteFs: () => remote,
    readStaged: async (_id, size, offset, count) => {
      assert.equal(size, bytes.length);
      assert.ok(count <= 64 * 1024);
      reads.push(count);
      return bytes.slice(offset, offset + count);
    },
    progress: p => { status.push(p); } });
  executor.start({ ...job("eeeeeeee-1234", "upload"),
    stageId: "00000000-aaaa-bbbb-cccc-111111111111", sizeBytes: bytes.length,
    modifiedMs: 123456, sha256: "a".repeat(64) });
  await wait(() => status.some(p => p.phase === "completed"));
  assert.deepEqual(reads, [65536, 65536, 8928]);
  assert.equal(status.at(-1)?.transferredBytes, bytes.length);
});

test("transient network failure can restart same durable ID at a higher attempt", async () => {
  const { documents, status } = fixture();
  let calls = 0;
  const remote = { readDir: async () => [{ path: "keepass.kdbx", type: "file", modifiedMs: 120 }],
    readFileToSink: async (_folder: string, _path: string, sink: {
      begin: (value: unknown) => Promise<void>; write: (offset: number, bytes: Uint8Array) => Promise<void>;
      commit: () => Promise<void>;
    }) => {
      calls++;
      if (calls === 1) throw new Error("socket disconnected");
      await sink.begin({ folderId: "folder", path: "keepass.kdbx", sizeBytes: 1, encrypted: false });
      await sink.write(0, new Uint8Array([1]));
      await sink.commit();
    },
  } as unknown as RemoteFs;
  const executor = createServiceTransferJobs({ documents, remoteFs: () => remote,
    progress: value => { status.push(value); } });
  const durable = job("ffffffff-1234");
  executor.start({ ...durable, attempts: 0 });
  await wait(() => status.some(p => p.phase === "failed" && p.reason === "network"));
  // The terminal failure does not permanently blacklist an ID that native
  // journaling has explicitly scheduled for another attempt.
  await wait(() => !executor.hasActive(durable.id));
  assert.deepEqual(executor.start({ ...durable, attempts: 1 }), { started: true });
  await wait(() => status.some(p => p.phase === "completed"));
  assert.equal(calls, 2);
  assert.deepEqual(status.filter(p => p.phase === "failed" || p.phase === "completed")
    .map(p => [p.phase, p.attempt]), [["failed", 0], ["completed", 1]]);
});

test("native durable transfer refuses a different authenticated peer despite identical folder IDs", async () => {
  const { documents, status } = fixture();
  let touchedRemote = false;
  const remote = { readDir: async () => { touchedRemote = true; return []; } } as unknown as RemoteFs;
  const executor = createServiceTransferJobs({ documents, remoteFs: () => remote,
    peerId: () => "B".repeat(52), progress: p => { status.push(p); } });
  executor.start({ ...job("abcddcba-4444"), peerId: "A".repeat(52) });
  await wait(() => status.some(p => p.phase === "failed"));
  assert.equal(touchedRemote, false);
  assert.equal(status.at(-1)?.reason, "other");
});
