import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { keepassFilename, keepassEntries } from "./keepass-fixture.mjs";

// Real Android proxy descriptor; the deterministic cut happens before fsync
// or close. The synthetic writer is necessary to control that precise point.
export const runKeepassInterruptedSave = async ({
  runAdb, wait, editorCommand, peerHostFolder, restartDocumentRuntime,
}) => {
  assert.equal(runAdb(["shell", "getprop", "ro.kernel.qemu"]).trim(), "1");
  const database = path.join(peerHostFolder, keepassFilename);
  const original = fs.readFileSync(database);
  assert.ok(keepassEntries(database).includes("initial-fixture"));
  const digest = bytes => `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
  const expected = digest(original);
  const eventually = async (label, check) => {
    const deadline = Date.now() + 120_000;
    let lastError;
    while (Date.now() < deadline) {
      try { if (await check()) return; } catch (error) { lastError = error; }
      await wait(500);
    }
    throw new Error("Interrupted KDBX: " + label, { cause: lastError });
  };
  const names = () => editorCommand("listNames").split("|");
  await eventually("initial database available", () =>
    editorCommand("stat", keepassFilename) === "true" && editorCommand("digest", keepassFilename) === expected);
  for (const length of [0, 128]) {
    const prefix = original.subarray(0, length);
    const previous = new Set(names());
    assert.equal(editorCommand("holdTruncatedWrite", keepassFilename,
      length ? { fixture: prefix.toString("base64") } : {}), String(length));
    assert.equal(editorCommand("digest", keepassFilename), expected, "Open draft replaced published primary");
    await restartDocumentRuntime();
    await eventually("preserved primary and separate recovered bytes", () => {
      const copies = names().filter(name => name.startsWith(keepassFilename + ".sync-conflict-") && !previous.has(name));
      return copies.length === 1 && editorCommand("digest", copies[0]) === digest(prefix) &&
        editorCommand("digest", keepassFilename) === expected;
    });
    assert.deepEqual(fs.readFileSync(database), original);
    assert.ok(keepassEntries(database).includes("initial-fixture"));
    console.log("Android SAF interruption at " + length + " bytes preserved the primary and recovered exact draft bytes.");
  }
};
