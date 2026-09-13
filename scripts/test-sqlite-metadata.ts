import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createNodeMetadataStorage } from "../packages/core/dist/sync/nodeMetadataStorage.js";
import { createNodeFolderReplica } from "../packages/core/dist/sync/nodeReplica.js";
import { encodeReplicaIndex } from "../packages/core/dist/sync/replicaPersistence.js";

test("process death rolls back partial SQLite changes and unchanged rows retain their revisions", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "syncpeer-sqlite-crash-"));
  try {
    const root = path.join(temp, "files");
    await mkdir(root);
    const store = await createNodeMetadataStorage(root, path.join(temp, "state"));
    const records = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), value: new Uint8Array([index % 256]) }));
    store.replace("fixture", records);
    store.replace("fixture", records);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.env.SYNCPEER_FIXTURE_DB);
      db.exec("BEGIN IMMEDIATE; DELETE FROM records WHERE namespace = 'fixture'");
      process.exit(71);
    `], { env: { ...process.env, SYNCPEER_FIXTURE_DB: store.databasePath }, stdio: "pipe" });
    assert.equal(child.status, 71);
    assert.deepEqual(store.entries("fixture"), [...records].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const db = new DatabaseSync(store.databasePath);
    try {
      assert.equal(db.prepare("SELECT max(revision) AS revision FROM records WHERE namespace = 'fixture'").get()!.revision, 1);
      db.exec("PRAGMA user_version = 999");
    } finally { db.close(); }
    await assert.rejects(createNodeMetadataStorage(root, path.join(temp, "state")), /version/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("SQLite metadata transactions roll back, retain binary data and support consistent backups", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "syncpeer-sqlite-"));
  try {
    const root = path.join(temp, "files");
    await mkdir(root);
    const store = await createNodeMetadataStorage(root, path.join(temp, "state"));
    store.replace("fixture", [{ id: "record", value: new Uint8Array([0, 255, 1]) }]);
    assert.deepEqual(store.entries("fixture"), [{ id: "record", value: new Uint8Array([0, 255, 1]) }]);
    assert.throws(() => store.replace("fixture", [{ id: "duplicate", value: new Uint8Array() }, { id: "duplicate", value: new Uint8Array() }]));
    assert.equal(store.entries("fixture")[0].id, "record");
    const backup = path.join(temp, "backup.sqlite3");
    store.backup(backup);
    const db = new DatabaseSync(backup, { readOnly: true });
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE namespace = 'fixture'").get()!.n, 1); }
    finally { db.close(); }
    const reopened = await createNodeMetadataStorage(root, path.join(temp, "state"));
    assert.deepEqual(reopened.entries("fixture"), store.entries("fixture"));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("legacy replica history migrates outside the folder and survives deletion and reopen", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "syncpeer-sqlite-migration-"));
  try {
    const root = path.join(temp, "files"), stateRoot = path.join(temp, "state");
    await mkdir(root);
    await writeFile(path.join(root, ".syncpeer-folder-marker"), "");
    const history = { format: 1 as const, sequence: 7, files: {
      removed: { revision: "deleted", info: { name: "removed", type: 0, size: 0, deleted: true,
        version: { counters: [{ id: "1", value: "7" }] } } },
    } };
    await writeFile(path.join(root, ".syncpeer-replica.json"), encodeReplicaIndex(history));
    const replica = await createNodeFolderReplica(root, "1", { stateRoot });
    assert.equal((await replica.scan())[0].deleted, true);
    assert.deepEqual(await readdir(root), [".stfolder"]);
    const reopened = await createNodeFolderReplica(root, "1", { stateRoot });
    assert.deepEqual((await reopened.scan())[0].version, history.files.removed.info.version);
    await reopened.pause();
    assert.equal((await createNodeFolderReplica(root, "1", { stateRoot })).isPaused(), true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("a complete restart rejects replacement storage and a missing database", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "syncpeer-sqlite-root-"));
  try {
    const root = path.join(temp, "files"), stateRoot = path.join(temp, "state");
    await mkdir(root);
    await (await createNodeFolderReplica(root, "1", { stateRoot })).scan();
    await rename(root, path.join(temp, "original"));
    await mkdir(root);
    await mkdir(path.join(root, ".stfolder"));
    await assert.rejects(createNodeFolderReplica(root, "1", { stateRoot }), /replaced|identity/i);
    await rm(root, { recursive: true });
    await rename(path.join(temp, "original"), root);
    const store = await createNodeMetadataStorage(root, stateRoot);
    await rm(store.databasePath);
    await assert.rejects(createNodeFolderReplica(root, "1", { stateRoot }), /missing|recover/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("corrupt legacy history is never converted to an empty database", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "syncpeer-sqlite-corrupt-"));
  try {
    const root = path.join(temp, "files");
    await mkdir(root);
    await writeFile(path.join(root, ".syncpeer-folder-marker"), "");
    await writeFile(path.join(root, ".syncpeer-replica.json"), "broken");
    await assert.rejects(createNodeFolderReplica(root, "1", { stateRoot: path.join(temp, "state") }));
    assert.equal(await readFile(path.join(root, ".syncpeer-replica.json"), "utf8"), "broken");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
