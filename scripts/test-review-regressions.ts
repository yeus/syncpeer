import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  coalescePendingIndexFrame,
  type PendingIndexFrame,
} from "../packages/core/src/core/protocol/indexQueue.ts";
import { resolvePackagedAppVersion } from "../packages/app/buildInfo.ts";
import {
  classifyRuntimeEnvironment,
  detectRuntimeEnvironment,
} from "../packages/app/src/lib/runtimeInfo.ts";

const update = (
  files: Array<{ name: string; deleted?: boolean }>,
  lastSequence: number,
): PendingIndexFrame => ({
  kind: "update",
  index: {
    folder: "documents",
    files,
    last_sequence: lastSequence,
  },
});

const firstUpdate = update([{ name: "first.txt" }], 1);
const secondUpdate = update([{ name: "second.txt" }], 2);
const mergedUpdates = coalescePendingIndexFrame(firstUpdate, secondUpdate);

assert.equal(mergedUpdates.kind, "update");
assert.deepEqual(
  mergedUpdates.index.files.map((file) => file.name),
  ["first.txt", "second.txt"],
);
assert.equal(mergedUpdates.index.last_sequence, 2);

const mergedDeletion = coalescePendingIndexFrame(
  mergedUpdates,
  update([{ name: "first.txt", deleted: true }], 3),
);
assert.deepEqual(
  mergedDeletion.index.files.find((file) => file.name === "first.txt"),
  { name: "first.txt", deleted: true },
);

const replacementIndex: PendingIndexFrame = {
  kind: "index",
  index: {
    folder: "documents",
    files: [{ name: "snapshot.txt" }],
    last_sequence: 4,
  },
};
assert.deepEqual(
  coalescePendingIndexFrame(mergedDeletion, replacementIndex),
  replacementIndex,
);
const snapshotWithUpdate = coalescePendingIndexFrame(
  replacementIndex,
  update([{ name: "later.txt" }], 5),
);
assert.equal(snapshotWithUpdate.kind, "index");
assert.deepEqual(
  snapshotWithUpdate.index.files.map((file) => file.name),
  ["snapshot.txt", "later.txt"],
);

assert.equal(
  classifyRuntimeEnvironment({ hasNodeRuntime: false, hasTauriRuntime: true }),
  "tauri",
);
assert.equal(
  classifyRuntimeEnvironment({ hasNodeRuntime: true, hasTauriRuntime: false }),
  "node",
);
assert.equal(
  classifyRuntimeEnvironment({ hasNodeRuntime: false, hasTauriRuntime: false }),
  "browser",
);

const runtimeGlobal = globalThis as { __TAURI_INTERNALS__?: unknown };
const previousTauriInternals = runtimeGlobal.__TAURI_INTERNALS__;
try {
  runtimeGlobal.__TAURI_INTERNALS__ = {};
  assert.equal(detectRuntimeEnvironment(), "tauri");
} finally {
  if (previousTauriInternals === undefined) delete runtimeGlobal.__TAURI_INTERNALS__;
  else runtimeGlobal.__TAURI_INTERNALS__ = previousTauriInternals;
}

const tauriConfig = JSON.parse(
  await readFile(
    new URL("../packages/tauri-shell/src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
) as unknown;
assert.equal(resolvePackagedAppVersion(tauriConfig), "0.1.0");

console.log("Review regression checks passed.");
