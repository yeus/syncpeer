import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { chmodSync, existsSync, lstatSync, readFileSync, mkdtempSync, linkSync, rmSync } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";

function stateDirectory() {
  if (process.env.SYNCPEER_STATE_DIR) return path.resolve(process.env.SYNCPEER_STATE_DIR);
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "syncpeer");
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support", "syncpeer");
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "syncpeer");
}

const rootIdentity = (root: string) => {
  const info = lstatSync(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Selected folder is unavailable or replaced.");
  return `${info.dev}:${info.ino}`;
};

/** One database per selected root, outside user files. No process-global connections. */
export async function createNodeMetadataStorage(rootPath: string, stateRoot = stateDirectory()) {
  const root = await realpath(rootPath);
  const directory = path.join(path.resolve(stateRoot), "folders", createHash("sha256").update(root).digest("hex"));
  if (directory === root || directory.startsWith(root + path.sep)) throw new Error("Metadata storage must be outside the selected folder.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const databasePath = path.join(directory, "metadata.sqlite3");
  const initialized = path.join(directory, "initialized");
  const schema = readFileSync(new URL("../../sqlite/metadata.sql", import.meta.url), "utf8");
  const identity = rootIdentity(root);
  const withDatabase = <T>(operation: (db: DatabaseSync) => T): T => {
    if (rootIdentity(root) !== identity) throw new Error("Selected folder identity changed; storage was replaced.");
    if (existsSync(initialized) && !existsSync(databasePath)) throw new Error("Synchronization database missing; restore a backup before continuing.");
    for (const file of [directory, databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("Metadata storage refuses symlinks.");
    }
    const db = new DatabaseSync(databasePath);
    try {
      chmodSync(databasePath, 0o600);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if (version !== 0 && version !== 1) throw new Error("Unsupported synchronization database version.");
      if (!version) {
        if (existsSync(initialized)) throw new Error("Synchronization database schema missing; restore a backup.");
        db.exec(schema);
      }
      db.exec("PRAGMA journal_mode = WAL");
      const stored = db.prepare("SELECT value FROM records WHERE namespace = 'system' AND id = 'root' AND deleted = 0").get();
      if (stored && new TextDecoder().decode(stored.value as Uint8Array) !== identity) throw new Error("Selected folder identity changed; storage was replaced.");
      if (!stored) {
        if (existsSync(initialized)) throw new Error("Synchronization root identity missing; restore a backup.");
        db.prepare("INSERT INTO records(namespace, id, value, modified_ms) VALUES ('system', 'root', ?, 0)").run(new TextEncoder().encode(identity));
      }
      return operation(db);
    } finally { db.close(); }
  };
  withDatabase(db => {
    if (db.prepare("PRAGMA quick_check").get()!.quick_check !== "ok") throw new Error("Synchronization database failed integrity validation.");
  });
  const sentinel = await open(initialized, "a", 0o600);
  try { await sentinel.sync(); } finally { await sentinel.close(); }
  return {
    databasePath,
    directory,
    entries: (namespace: string): { id: string; value: Uint8Array }[] => withDatabase(db =>
      db.prepare("SELECT id, value FROM records WHERE namespace = ? AND deleted = 0 ORDER BY id").all(namespace)
        .map(row => ({ id: String(row.id), value: new Uint8Array(row.value as Uint8Array) }))),
    replace: (namespace: string, records: readonly { id: string; value: Uint8Array }[]) => withDatabase(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TEMP TABLE incoming (id TEXT PRIMARY KEY)");
        const mark = db.prepare("INSERT INTO incoming(id) VALUES (?)");
        const put = db.prepare(`INSERT INTO records(namespace, id, value, modified_ms) VALUES (?, ?, ?, ?)
          ON CONFLICT(namespace, id) DO UPDATE SET value = excluded.value, revision = records.revision + 1,
          modified_ms = excluded.modified_ms, deleted = 0 WHERE records.value != excluded.value OR records.deleted != 0`);
        for (const record of records) { mark.run(record.id); put.run(namespace, record.id, record.value, Date.now()); }
        db.prepare("UPDATE records SET value = zeroblob(0), deleted = 1, revision = revision + 1 WHERE namespace = ? AND deleted = 0 AND id NOT IN (SELECT id FROM incoming)").run(namespace);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }),
    backup: (destination: string) => withDatabase(db => {
      if (existsSync(destination)) throw new Error("Backup destination already exists.");
      const temporary = mkdtempSync(path.join(path.dirname(path.resolve(destination)), ".syncpeer-backup-"));
      try {
        const snapshot = path.join(temporary, "metadata.sqlite3");
        db.prepare("VACUUM INTO ?").run(snapshot);
        chmodSync(snapshot, 0o600);
        linkSync(snapshot, path.resolve(destination));
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }),
  };
}
