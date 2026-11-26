import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { advanceVersionVector } from "../packages/core/dist/core/protocol/versionVector.js";
import { defaultFolderSettings } from "../packages/core/dist/sync/profileSettings.js";
import { randomBytes } from "node:crypto";
import { createDocumentFilesystem } from "../packages/core/dist/sync/documentFilesystem.js";
import { memoryDocumentStorage } from "./lan-test/replica-storage.ts";
import {
  addKeepassEntry, createKeepassFixture, importKeepassAttachment,
  keepassAttachment, keepassEntries, verifyKeepassAttachment,
} from "./lan-test/keepass-fixture.mjs";

const withFixture = async (run: (fixture: {
  original: Buffer; edited: Buffer; validate: (bytes: Uint8Array, updated: boolean) => void;
  makeConcurrent: () => Buffer;
}) => Promise<void>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-kdbx-recovery-"));
  try {
    const db = path.join(root, "fixture.kdbx");
    const attachment = path.join(root, "input.bin");
    fs.writeFileSync(attachment, keepassAttachment());
    createKeepassFixture(db);
    importKeepassAttachment(db, attachment);
    const original = fs.readFileSync(db);
    addKeepassEntry(db, "updated-fixture");
    const edited = fs.readFileSync(db);
    const validate = (bytes: Uint8Array, updated: boolean) => {
      const output = path.join(root, "validation.kdbx");
      fs.writeFileSync(output, bytes);
      assert.ok(keepassEntries(output).includes("initial-fixture"));
      assert.equal(keepassEntries(output).includes("updated-fixture"), updated);
      verifyKeepassAttachment(output, path.join(root, "export.bin"));
    };
    validate(original, false);
    validate(edited, true);
    const makeConcurrent = () => {
      const other = path.join(root, "concurrent.kdbx");
      fs.writeFileSync(other, original);
      addKeepassEntry(other, "concurrent-fixture");
      return fs.readFileSync(other);
    };
    await run({ original, edited, validate, makeConcurrent });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

const createReplica = async (original: Buffer) => {
  const { openStorage } = memoryDocumentStorage();
  const options = {
    profileId: "keepass-recovery-test", deviceCounterId: "42", openStorage,
    profile: await openStorage("profile"), randomBytes,
  };
  let documents = createDocumentFilesystem(options);
  await documents.initialize();
  await documents.createVault("synthetic-master", false);
  await documents.register({ id: "fixture", label: "Fixture", password: "synthetic-folder" });
  await documents.attachDownloads("fixture");
  const [folder] = await documents.list("syncpeer-root");
  const file = await documents.create(folder.id, "fixture.kdbx", false);
  const write = async (handle: number, bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.length; offset += 131072) {
      await documents.write(handle, offset, bytes.subarray(offset, offset + 131072));
    }
  };
  const seed = await documents.open(file.id, "rwt");
  await write(seed, original);
  await documents.release(seed);
  const read = async (id = file.id) => {
    const stat = await documents.stat(id);
    const handle = await documents.open(id, "r");
    try {
      const result = Buffer.alloc(stat.size);
      for (let offset = 0; offset < result.length; offset += 131072) {
        result.set(await documents.read(handle, offset, Math.min(131072, result.length - offset)), offset);
      }
      return result;
    } finally { await documents.release(handle); }
  };
  const restart = async () => {
    // Close the runtime, not the writer: leave only the durable encrypted
    // journal, as at a process interruption before close/fsync.
    await documents.close();
    documents = createDocumentFilesystem(options);
    await documents.initialize();
    await documents.unlock("synthetic-master");
  };
  const readRecoveredCopy = async () => {
    const copies = (await documents.list(folder.id)).filter(entry =>
      entry.name.startsWith("fixture.kdbx.sync-conflict-"));
    assert.equal(copies.length, 1, "Exactly one separate recovered copy");
    return read(copies[0]!.id);
  };
  return { file, write, read, readRecoveredCopy, restart, documents: () => documents };
};

test("KDBX attachment survives an acknowledged complete write interrupted before close", async () => {
  await withFixture(async ({ original, edited, validate }) => {
    const fixture = await createReplica(original);
    try {
      const handle = await fixture.documents().open(fixture.file.id, "rwt");
      await fixture.write(handle, edited);
      assert.deepEqual(await fixture.read(), original);
      await fixture.restart();
      const primary = await fixture.read();
      assert.deepEqual(primary, original);
      validate(primary, false);
      const recovered = await fixture.readRecoveredCopy();
      assert.deepEqual(recovered, edited);
      validate(recovered, true);
    } finally { await fixture.documents().close(); }
  });
});

test("KDBX attachment survives restart after fsync without descriptor release", async () => {
  await withFixture(async ({ original, edited, validate }) => {
    const fixture = await createReplica(original);
    try {
      const handle = await fixture.documents().open(fixture.file.id, "rwt");
      await fixture.write(handle, edited);
      await fixture.documents().flush(handle);
      await fixture.restart();
      assert.deepEqual(await fixture.read(), edited);
      validate(await fixture.read(), true);
    } finally { await fixture.documents().close(); }
  });
});

for (const [label, bytes] of [["after truncate", 0], ["mid-save", 131072]] as const) {
  test(`KDBX interruption ${label} preserves a decryptable primary and acknowledged draft bytes`, async () => {
    await withFixture(async ({ original, edited, validate }) => {
      const fixture = await createReplica(original);
      try {
        const handle = await fixture.documents().open(fixture.file.id, "rwt");
        await fixture.write(handle, edited.subarray(0, bytes));
        assert.deepEqual(await fixture.read(), original, "Unclosed write must not replace published bytes");
        await fixture.restart();
        const published = await fixture.read();
        assert.deepEqual(published, original, "Incomplete replacement must not publish over the primary");
        validate(published, false);
        assert.deepEqual(await fixture.readRecoveredCopy(), edited.subarray(0, bytes));
        await fixture.restart();
        assert.deepEqual(await fixture.read(), original, "Repeated restart must not republish the draft");
        assert.deepEqual(await fixture.readRecoveredCopy(), edited.subarray(0, bytes));
      } finally { await fixture.documents().close(); }
    });
  });
}

test("whole-folder concurrent KDBX edits retain both exact decryptable versions across restart", async () => {
  await withFixture(async ({ original, edited, validate, makeConcurrent }) => {
    const concurrent = makeConcurrent();
    const fixture = await createReplica(original);
    try {
      const docs = fixture.documents();
      const settings = await docs.profileSettings();
      settings.folders.fixture = { ...defaultFolderSettings(), favorites: [{
        key: "folder:fixture:", folderId: "fixture", name: "Fixture", path: "", kind: "folder",
      }] };
      await docs.saveProfileSettings(settings);
      const [shared] = await docs.sessionSharedFolders("SYNTHETIC-ORDINARY-PEER");
      const replica = shared.replica!;
      const base = (await replica.scan()).find(file => file.name === "fixture.kdbx")!;
      const handle = await docs.open(fixture.file.id, "rwt");
      await fixture.write(handle, edited);
      await docs.release(handle);
      const local = (await replica.scan()).find(file => file.name === base.name)!;
      const blocks = [];
      for (let offset = 0; offset < concurrent.length; offset += 131072) {
        const block = concurrent.subarray(offset, offset + 131072);
        blocks.push({ offset, size: block.length, hash: sha256(block) });
      }
      const remote = { ...base, size: concurrent.length, blocks,
        modified_s: Number(local.modified_s) + 1, modified_ns: 0,
        version: advanceVersionVector(base.version, "43") };
      assert.equal(await replica.receive!("fixture", [remote], async (_name, offset, size) =>
        concurrent.subarray(offset, offset + size)), true);
      await fixture.restart();
      assert.deepEqual(await fixture.read(), concurrent);
      const recovered = await fixture.readRecoveredCopy();
      assert.deepEqual(recovered, edited);
      validate(recovered, true);
      validate(await fixture.read(), false);
    } finally { await fixture.documents().close(); }
  });
});
