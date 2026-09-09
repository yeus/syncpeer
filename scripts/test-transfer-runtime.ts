import assert from "node:assert/strict";
import {
  cachedFileKey,
  type SyncpeerBrowserClient,
} from "../packages/core/src/browser.ts";
import { createInitialState } from "../packages/app/src/app/state.ts";
import { createTransferRuntime } from "../packages/app/src/app/transferRuntime.ts";

const state = createInitialState();
const runtime = createTransferRuntime({
  state,
  client: {} as SyncpeerBrowserClient,
  runtimeSurface: "web-ui",
});
const folderId = "synthetic-folder";
const path = "example/file.txt";
const transferId = `download:${cachedFileKey(folderId, path)}`;
let cancellationCount = 0;

await runtime.begin(
  {
    id: transferId,
    direction: "download",
    label: "file.txt",
    completedBytes: 0,
    totalBytes: 10,
    cancellable: true,
  },
  () => {
    cancellationCount += 1;
  },
);
assert.equal(runtime.hasActiveDirection("download"), true);

state.favorites.isDownloading = true;
runtime.cancelDownload(folderId, path);
assert.equal(cancellationCount, 1);

runtime.setActiveDownload(transferId, {
  name: "file.txt",
  text: "downloading",
  progressPercent: 110,
});
assert.equal(state.favorites.activeDownloads[transferId]?.progressPercent, 100);
runtime.clearActiveDownload(transferId);
assert.equal(state.favorites.isDownloading, false);

await runtime.finish(transferId, "cancelled");
assert.equal(runtime.hasActiveDirection("download"), false);
runtime.dispose();

console.log("transfer runtime checks passed");
