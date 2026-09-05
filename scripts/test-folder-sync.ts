import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compareVersionVectors,
  deleteFolderFile,
  defaultFolderSyncPolicy,
  planFolderSync,
  synchronizeFolder,
  unsubscribeFolder,
  type FileEntry,
  type FolderSyncBaseline,
  type LocalSyncFile,
} from "../packages/core/dist/index.js";
import { createNodeFolderSyncStorage } from "../packages/core/dist/sync/nodeFolderStorage.js";
import { RemoteFs } from "../packages/core/dist/core/model/remoteFs.js";
import { advanceVersionVector } from "../packages/core/dist/core/protocol/versionVector.js";

test("publication advances its own counter and preserves other devices", () => {
  const previous = { counters: [{ id: "1", value: "9007199254740993" }, { id: "2", value: "3" }] };
  const next = advanceVersionVector(previous, "2");
  assert.deepEqual(next.counters, [{ id: "1", value: "9007199254740993" }, { id: "2", value: "4" }]);
  assert.equal(previous.counters[1].value, "3");
  assert.equal(compareVersionVectors(next, previous), "after");
});

test("unavailable indexes cannot masquerade as empty folders", async () => {
  const remote = new RemoteFs(new Map(), async () => new Uint8Array());
  await assert.rejects(() => remote.listFiles("missing"), /Unknown folder/);
  const pending = new RemoteFs(new Map([["folder", { id: "folder", files: new Map() }]]) as never, async () => new Uint8Array());
  pending.waitForFolderIndex = async () => false;
  await assert.rejects(() => pending.listFiles("folder"), /index/i);
});

test("stale remote vectors cannot roll back a synchronized file", () => {
  const local = { path: "file", size: 3, modifiedMs: 2, fingerprint: "new" };
  const plan = planFolderSync({ local: [local], remote: [{ ...file("file", "old"), version: { counters: [{ id: "1", value: "1" }] } }],
    baseline: { format: 1, files: { file: { ...local, exists: true, version: { counters: [{ id: "1", value: "2" }] } } } } });
  assert.equal(plan.actions.length, 0);
});

test("storage refuses symlink parents for download and restore", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-link-test-"));
  try {
    await mkdir(path.join(root, "selected"));
    await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(root, "selected", "linked"));
    const storage = await createNodeFolderSyncStorage(path.join(root, "selected"));
    await assert.rejects(() => storage.writeFile("linked/file", new Uint8Array([1])), /symlink/i);
    await storage.writeFile("file", new Uint8Array([1]));
    await storage.archiveFile("file", "replace", { ...defaultFolderSyncPolicy(), versioning: "simple" }, Date.now());
    const [version] = await storage.listVersions();
    await assert.rejects(() => storage.restoreVersion(version.archivePath, "linked/file"), /symlink/i);
    await assert.rejects(() => readFile(path.join(root, "outside", "file")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an edit during archiving is preserved before replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-archive-edit-"));
  try {
    await writeFile(path.join(root, "file"), "old");
    const storage = await createNodeFolderSyncStorage(root);
    const [local] = await storage.listFiles();
    await assert.rejects(() => synchronizeFolder({
      folderId: "folder",
      baseline: { format: 1, files: { file: { ...local, exists: true } } },
      storage: { ...storage, archiveFile: async (...args) => {
        const result = await storage.archiveFile(...args);
        await writeFile(path.join(root, "file"), "intervening edit");
        return result;
      } },
      remote: {
        listFiles: async () => [file("file", "new")],
        readFileFully: async () => new TextEncoder().encode("new"),
        writeFileFully: async () => {},
      },
    }), /changed/);
    assert.equal(await readFile(path.join(root, "file"), "utf8"), "intervening edit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("different remote block boundaries do not cause false conflicts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-block-layout-"));
  try {
    const bytes = new Uint8Array(256 * 1024).fill(7);
    await writeFile(path.join(root, "file"), bytes);
    const storage = await createNodeFolderSyncStorage(root);
    const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
    const remote = new RemoteFs(new Map([["folder", { id: "folder", indexReceived: true, files: new Map([["file", { indexFile: { name: "file", size: bytes.length, blocks: [{ offset: 0, size: bytes.length, hash }] } }]]) }]]) as never, async () => bytes);
    const result = await synchronizeFolder({ folderId: "folder", storage, remote: { listFiles: id => remote.listFiles(id), readFileFully: async () => bytes, writeFileFully: async () => assert.fail("unchanged file uploaded") } });
    assert.equal(result.completed, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("edits made during a download survive replacement", async () => {
  let content = "old";
  const archives: string[] = [];
  await assert.rejects(() => synchronizeFolder({ folderId: "folder",
    baseline: { format: 1, files: { file: { exists: true, size: 3, modifiedMs: 1, fingerprint: "old" } } },
    storage: { listFiles: async () => [{ path: "file", size: content.length, modifiedMs: 1, fingerprint: content }], readFile: async () => new TextEncoder().encode(content), writeFile: async (_, bytes) => { content = new TextDecoder().decode(bytes); }, removeFile: async () => {}, archiveFile: async () => { archives.push(content); return "archive"; } },
    remote: { listFiles: async () => [file("file", "remote")], readFileFully: async () => { content = "intervening edit"; return new TextEncoder().encode("remote"); }, writeFileFully: async () => {} },
  }), /changed/i);
  assert.equal(content, "intervening edit");
});

test("simple versioning prunes only the selected file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-prune-"));
  try {
    const storage = await createNodeFolderSyncStorage(root);
    const policy = { ...defaultFolderSyncPolicy(), versioning: "simple" as const, maxVersions: 2 };
    for (let i = 0; i < 4; i++) {
      await storage.writeFile("note", new Uint8Array([i]));
      await storage.archiveFile("note", "replace", policy, Date.UTC(2026, 0, i + 1));
    }
    assert.equal((await storage.listVersions("note")).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staggered versioning thins close revisions and retains an older revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-staggered-"));
  try {
    const storage = await createNodeFolderSyncStorage(root);
    for (const seconds of [0, 5, 10, 45]) {
      await storage.writeFile("file", new Uint8Array([seconds]));
      await storage.archiveFile("file", "replace", defaultFolderSyncPolicy(), Date.UTC(2026, 0, 1) + seconds * 1000);
    }
    assert.equal((await storage.listVersions("file")).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous publication is persisted and never blindly replayed", async () => {
  let publications = 0;
  let state: FolderSyncBaseline | null = null;
  const storage = { listFiles: async () => [{ path: "file", size: 1, modifiedMs: 1, fingerprint: "a" }], readFile: async () => new Uint8Array([1]), writeFile: async () => {}, removeFile: async () => {}, archiveFile: async () => null, loadState: async () => state, saveState: async (next: FolderSyncBaseline) => { state = structuredClone(next); } };
  const remote = { listFiles: async () => [], readFileFully: async () => new Uint8Array(), writeFileFully: async () => { publications++; throw new Error("connection closed"); } };
  await assert.rejects(() => synchronizeFolder({ folderId: "folder", storage, remote }), /connection closed/);
  await assert.rejects(() => synchronizeFolder({ folderId: "folder", storage, remote }), /unconfirmed/);
  assert.equal(publications, 1);
});

test("completed actions remain durable when a later download fails", async () => {
  let state: FolderSyncBaseline | null = null;
  const storage = { listFiles: async () => [{ path: "a", size: 1, modifiedMs: 1, fingerprint: "a" }], readFile: async () => new Uint8Array([1]), writeFile: async () => {}, removeFile: async () => {}, archiveFile: async () => null, saveState: async (next: FolderSyncBaseline) => { state = structuredClone(next); } };
  const remote = { listFiles: async () => [file("b", "b")], readFileFully: async () => { throw new Error("download failed"); }, writeFileFully: async () => {} };
  await assert.rejects(() => synchronizeFolder({ folderId: "folder", storage, remote }), /download failed/);
  assert.equal((state as FolderSyncBaseline | null)?.files.a.exists, true);
  assert.equal((state as FolderSyncBaseline | null)?.files.a.pending, undefined);
});

test("unsubscribe cancels a running replacement across storage instances", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-unsubscribe-active-"));
  try {
    await writeFile(path.join(root, "file"), "old");
    const storage = await createNodeFolderSyncStorage(root);
    const [local] = await storage.listFiles();
    await storage.saveState!({ format: 1, files: { file: { ...local, exists: true } } });
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const remote = { listFiles: async () => [file("file", "new")], readFileFully: async () => { started(); await pending; return new TextEncoder().encode("new"); }, writeFileFully: async () => {} };
    const sync = synchronizeFolder({ folderId: "folder", storage, remote });
    const rejected = assert.rejects(sync, /unsubscribed/);
    await reading;
    const second = await createNodeFolderSyncStorage(root);
    const unsubscribe = unsubscribeFolder({ storage: second });
    while (await second.isSubscribed!()) await new Promise(resolve => setTimeout(resolve, 5));
    release();
    await Promise.all([rejected, unsubscribe]);
    assert.deepEqual(await storage.listFiles(), []);
    await assert.rejects(() => synchronizeFolder({ folderId: "folder", storage, remote }), /unsubscribed/);
    assert.equal((await storage.listVersions()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const file = (pathName: string, fingerprint: string, modifiedMs = 1, size = fingerprint.length): FileEntry => ({
  name: path.basename(pathName), path: pathName, type: "file", size,
  modifiedMs, fingerprint,
});

test("version vectors distinguish ordered and concurrent edits", () => {
  assert.equal(compareVersionVectors({ counters: [{ id: "a", value: "1" }] }, { counters: [{ id: "a", value: "2" }] }), "before");
  assert.equal(compareVersionVectors({ counters: [{ id: "a", value: "2" }] }, { counters: [{ id: "a", value: "1" }] }), "after");
  assert.equal(compareVersionVectors({ counters: [{ id: "a", value: "2" }] }, { counters: [{ id: "a", value: "1" }, { id: "b", value: "1" }] }), "concurrent");
});

test("folder planner preserves local-only files and detects concurrent edits", () => {
  const local = [{ path: "local.txt", size: 1, modifiedMs: 1, fingerprint: "l" } satisfies LocalSyncFile];
  const remote = [file("remote.txt", "r"), file("same.txt", "same"), file("conflict.txt", "remote")];
  const baseline: FolderSyncBaseline = {
    format: 1,
    files: {
      "same.txt": { exists: true, size: 4, modifiedMs: 1, fingerprint: "same" },
      "conflict.txt": { exists: true, size: 4, modifiedMs: 1, fingerprint: "base" },
    },
  };
  const plan = planFolderSync({
    local: [...local, { path: "same.txt", size: 4, modifiedMs: 1, fingerprint: "same" }, { path: "conflict.txt", size: 5, modifiedMs: 2, fingerprint: "local" }],
    remote,
    baseline,
    nowMs: Date.UTC(2026, 0, 2),
  });
  assert.deepEqual(plan.actions.map((action) => action.kind), ["conflict", "upload", "download"]);
  assert.match(plan.actions[0].kind === "conflict" ? plan.actions[0].conflictPath : "", /syncpeer-conflict/);
});

test("folder synchronization downloads, uploads, archives, and persists state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-folder-sync-"));
  try {
    await writeFile(path.join(root, "local.txt"), "local");
    const storage = await createNodeFolderSyncStorage(root);
    const remoteFiles = new Map<string, { bytes: Uint8Array; entry: FileEntry }>([
      ["remote.txt", { bytes: new TextEncoder().encode("remote"), entry: file("remote.txt", "remote", 2) }],
    ]);
    const uploaded: string[] = [];
    const deleted: string[] = [];
    const remote = {
      listFiles: async () => [...remoteFiles.values()].map(({ entry }) => entry),
      readFileFully: async (_folderId: string, filePath: string) => remoteFiles.get(filePath)!.bytes,
      writeFileFully: async (_folderId: string, filePath: string, bytes: Uint8Array) => {
        uploaded.push(filePath);
        const local = (await storage.listFiles()).find((entry) => entry.path === filePath);
        remoteFiles.set(filePath, {
          bytes: new Uint8Array(bytes),
          entry: file(filePath, local?.fingerprint ?? Buffer.from(bytes).toString("hex"), local?.modifiedMs ?? 3, local?.size ?? bytes.length),
        });
      },
      deleteFile: async (_folderId: string, filePath: string) => { deleted.push(filePath); remoteFiles.delete(filePath); },
    };
    const result = await synchronizeFolder({
      folderId: "folder",
      remote,
      storage,
      policy: { ...defaultFolderSyncPolicy(), versioning: "simple" },
    });
    assert.equal(result.completed, 2);
    assert.deepEqual(uploaded, ["local.txt"]);
    assert.equal(new TextDecoder().decode(await readFile(path.join(root, "remote.txt"))), "remote");
    const state = await storage.loadState!();
    assert.ok(state?.files["remote.txt"]?.exists);
    assert.equal(deleted.length, 0);
    const syncedRemote = (await storage.listFiles()).find((entry) => entry.path === "remote.txt");
    assert.ok(syncedRemote && state);
    remoteFiles.get("remote.txt")!.entry = {
      ...remoteFiles.get("remote.txt")!.entry,
      fingerprint: syncedRemote.fingerprint,
      modifiedMs: syncedRemote.modifiedMs,
      size: syncedRemote.size,
    };
    state.files["remote.txt"] = {
      ...state.files["remote.txt"],
      fingerprint: syncedRemote.fingerprint,
      modifiedMs: syncedRemote.modifiedMs,
      size: syncedRemote.size,
    };
    await storage.saveState!(state);
    const second = await synchronizeFolder({
      folderId: "folder",
      remote,
      storage,
      policy: { ...defaultFolderSyncPolicy(), versioning: "simple" },
    });
    assert.equal(second.completed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two folder-sync peers exchange updates in both directions", async () => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), "syncpeer-folder-peer-a-"));
  const secondRoot = await mkdtemp(path.join(tmpdir(), "syncpeer-folder-peer-b-"));
  try {
    await writeFile(path.join(firstRoot, "shared.txt"), "from peer A");
    const first = await createNodeFolderSyncStorage(firstRoot);
    const second = await createNodeFolderSyncStorage(secondRoot);
    const wire = new Map<string, { bytes: Uint8Array; entry: FileEntry }>();
    const remoteFor = (storage: typeof first) => ({
      listFiles: async () => [...wire.values()].map(({ entry }) => entry),
      readFileFully: async (_folderId: string, filePath: string) => {
        const item = wire.get(filePath);
        if (!item) throw new Error(`Missing wire file: ${filePath}`);
        return new Uint8Array(item.bytes);
      },
      writeFileFully: async (_folderId: string, filePath: string, bytes: Uint8Array) => {
        const local = (await storage.listFiles()).find((entry) => entry.path === filePath);
        wire.set(filePath, {
          bytes: new Uint8Array(bytes),
          entry: file(filePath, local?.fingerprint ?? Buffer.from(bytes).toString("hex"), local?.modifiedMs ?? Date.now(), bytes.length),
        });
      },
      deleteFile: async (_folderId: string, filePath: string) => {
        wire.delete(filePath);
      },
    });
    await synchronizeFolder({ folderId: "folder", remote: remoteFor(first), storage: first });
    await synchronizeFolder({ folderId: "folder", remote: remoteFor(second), storage: second });
    assert.equal(await readFile(path.join(secondRoot, "shared.txt"), "utf8"), "from peer A");

    await writeFile(path.join(secondRoot, "shared.txt"), "from peer B");
    await synchronizeFolder({ folderId: "folder", remote: remoteFor(second), storage: second });
    await synchronizeFolder({ folderId: "folder", remote: remoteFor(first), storage: first });
    assert.equal(await readFile(path.join(firstRoot, "shared.txt"), "utf8"), "from peer B");
  } finally {
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
    ]);
  }
});

test("propagating deletions archives local files and publishes remote tombstones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-folder-delete-"));
  try {
    await writeFile(path.join(root, "remote.txt"), "same");
    const storage = await createNodeFolderSyncStorage(root);
    const remoteFiles = new Map<string, { bytes: Uint8Array; entry: FileEntry }>([
      ["remote.txt", { bytes: new TextEncoder().encode("same"), entry: file("remote.txt", "same", 1) }],
    ]);
    const remote = {
      listFiles: async () => [...remoteFiles.values()].map(({ entry }) => entry),
      readFileFully: async (_folderId: string, filePath: string) => remoteFiles.get(filePath)!.bytes,
      writeFileFully: async () => undefined,
      deleteFile: async (_folderId: string, filePath: string) => { remoteFiles.delete(filePath); },
    };
    await synchronizeFolder({ folderId: "folder", remote, storage, policy: defaultFolderSyncPolicy() });
    const current = (await storage.listFiles()).find((entry) => entry.path === "remote.txt");
    assert.ok(current);
    remoteFiles.get("remote.txt")!.entry = {
      ...remoteFiles.get("remote.txt")!.entry,
      fingerprint: current.fingerprint,
      modifiedMs: current.modifiedMs,
      size: current.size,
    };
    const state = await storage.loadState!();
    assert.ok(state);
    state.files["remote.txt"] = {
      ...state.files["remote.txt"],
      fingerprint: current.fingerprint,
      modifiedMs: current.modifiedMs,
      size: current.size,
    };
    await storage.saveState!(state);
    await rm(path.join(root, "remote.txt"));
    const result = await synchronizeFolder({
      folderId: "folder",
      remote,
      storage,
      policy: { ...defaultFolderSyncPolicy(), externalDeletion: "propagate" },
    });
    assert.deepEqual(result.actions.map((action) => action.kind), ["delete-remote"]);
    assert.equal(remoteFiles.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsubscribe is local-only while explicit delete publishes a tombstone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-folder-delete-command-"));
  try {
    await writeFile(path.join(root, "remove.txt"), "remove me");
    await writeFile(path.join(root, "keep-remote.txt"), "keep remotely");
    const storage = await createNodeFolderSyncStorage(root);
    const deleted: string[] = [];
    const policy = { ...defaultFolderSyncPolicy(), versioning: "simple" as const };
    const remote = {
      deleteFile: async (_folderId: string, filePath: string) => { deleted.push(filePath); },
    };
    const deletion = await deleteFolderFile({
      folderId: "folder",
      path: "remove.txt",
      remote,
      storage,
      policy,
      nowMs: Date.UTC(2026, 0, 2),
    });
    assert.equal(deletion.path, "remove.txt");
    assert.deepEqual(deleted, ["remove.txt"]);
    await assert.rejects(() => readFile(path.join(root, "remove.txt")));
    assert.equal((await storage.listVersions("remove.txt")).length, 1);

    const unsubscribed = await unsubscribeFolder({ storage, policy, nowMs: Date.UTC(2026, 0, 3) });
    assert.deepEqual(unsubscribed.removed, ["keep-remote.txt"]);
    assert.deepEqual(deleted, ["remove.txt"]);
    assert.deepEqual(await storage.listFiles(), []);
    assert.equal((await storage.listVersions("keep-remote.txt")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node version store lists and restores archived content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "syncpeer-folder-versions-"));
  try {
    const target = path.join(root, "note.txt");
    await writeFile(target, "old");
    const storage = await createNodeFolderSyncStorage(root);
    const archived = await storage.archiveFile("note.txt", "replace", { ...defaultFolderSyncPolicy(), versioning: "simple" }, Date.UTC(2026, 0, 2));
    assert.ok(archived);
    await writeFile(target, "new");
    const versions = await storage.listVersions("note.txt");
    assert.equal(versions.length, 1);
    await storage.restoreVersion(versions[0].archivePath);
    assert.equal(await readFile(target, "utf8"), "old");
    await assert.rejects(
      () => storage.restoreVersion(versions[0].archivePath, "../outside.txt"),
      /inside the selected root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
