import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../packages/app/src/app/state.ts";
import { createServiceTransferReconciler } from "../packages/app/src/app/serviceTransferRecovery.ts";
import type { SyncpeerBrowserClient, ServiceTransferJobStatus } from "@syncpeer/core/browser";
import type { TransferRuntime } from "../packages/app/src/app/transferRuntime.ts";

test("recreated WebView restores native job progress and cancellation, then clears terminal state", async () => {
  const state = createInitialState({ deviceName: "test" });
  state.ui.isAppVisible = true;
  const operations: string[] = [];
  const cancellations = new Map<string, () => void>();
  let jobs: ServiceTransferJobStatus[] = [{
    id: "12345678-1234-1234-1234-123456789012", direction: "download",
    folderId: "folder", path: "keys/keepass.kdbx", phase: "running",
    transferredBytes: 75, totalBytes: 100, updatedAtMs: 100,
  }];
  const client = {
    listServiceTransferJobs: async () => jobs,
    cancelServiceTransferJob: async (id: string) => { operations.push("cancel:" + id); },
  } as unknown as SyncpeerBrowserClient;
  const transfers = {
    registerServiceTransfer: (key: string, _direction: string, fn: () => void) => {
      operations.push("register:" + key); cancellations.set(key, fn);
    },
    unregisterServiceTransfer: (key: string) => { operations.push("unregister:" + key); cancellations.delete(key); },
    setActiveDownload: (key: string, view: { progressPercent: number }) => {
      operations.push("progress:" + key + ":" + view.progressPercent);
    },
    clearActiveDownload: (key: string) => { operations.push("clear:" + key); },
    setDownloadNotice: (message: string) => { operations.push("notice:" + message); },
  } as unknown as TransferRuntime;
  const reconciler = createServiceTransferReconciler({ state, client, transfers });
  await reconciler.refresh();
  assert.ok(operations.some(value => value.endsWith(":75")));
  assert.equal(cancellations.size, 1);
  [...cancellations.values()][0]();
  await Promise.resolve();
  assert.ok(operations.some(value => value.startsWith("cancel:")));

  jobs = [{ ...jobs[0], phase: "completed", transferredBytes: 100 }];
  await reconciler.refresh();
  assert.equal(cancellations.size, 0);
  assert.ok(operations.some(value => value.startsWith("clear:")));
  assert.ok(operations.some(value => value === "notice:Downloaded keepass.kdbx"));
  reconciler.dispose();
});

test("backgrounded UI cannot poll encrypted native job journal", async () => {
  const state = createInitialState({ deviceName: "test" });
  state.ui.isAppVisible = false;
  const client = { listServiceTransferJobs: async () => { throw new Error("Must not poll hidden app."); } } as SyncpeerBrowserClient;
  const reconciler = createServiceTransferReconciler({
    state, client, transfers: {} as TransferRuntime,
  });
  await reconciler.refresh();
  reconciler.dispose();
});
