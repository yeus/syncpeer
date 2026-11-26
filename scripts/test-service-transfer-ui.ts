import assert from "node:assert/strict";
import test from "node:test";
import { createFileActions } from "../packages/app/src/app/fileActions.ts";
import { createInitialState } from "../packages/app/src/app/state.ts";
import type { SyncpeerBrowserClient, SyncpeerSessionStore } from "@syncpeer/core/browser";
import type { TransferRuntime } from "../packages/app/src/app/transferRuntime.ts";

test("Android manual download enqueues a service job without pumping WebView blocks", async () => {
  const state = createInitialState({ deviceName: "Synthetic test client" });
  state.session.isConnected = true;
  state.session.remoteDevice = { id: "A".repeat(52) } as never;
  state.session.remoteFs = {
    readFileToSink: () => { throw new Error("WebView must not read file blocks."); },
  } as never;
  const operations: string[] = [];
  const client = {
    startServiceTransferJob: async () => {
      operations.push("start-job");
      return { id: "12345678-1234-1234-1234-123456789012", phase: "queued" };
    },
    serviceTransferJobStatus: async () => {
      operations.push("job-status");
      return {
        id: "12345678-1234-1234-1234-123456789012",
        direction: "download", folderId: "folder", path: "keepass.kdbx",
        phase: "completed", transferredBytes: 42, totalBytes: 42, updatedAtMs: 100,
      };
    },
    getCachedStatuses: async () => [{ path: "", available: true }],
  } as unknown as SyncpeerBrowserClient;
  let cancel: (() => void) | undefined;
  const transfers = {
    registerServiceTransfer: (_id: string, _direction: string, fn: () => void) => {
      operations.push("register-cancel"); cancel = fn;
    },
    unregisterServiceTransfer: () => { operations.push("unregister-cancel"); },
    setActiveDownload: () => { operations.push("show-progress"); },
    clearActiveDownload: () => { operations.push("clear-progress"); },
    setDownloadNotice: () => {},
  } as unknown as TransferRuntime;
  const actions = createFileActions({ state, client, transfers,
    sessionStore: {} as SyncpeerSessionStore,
    ensureConnectedForTransfer: async () => true,
    openCachedFile: async () => { operations.push("open-cached"); },
  });
  await actions.downloadFile("folder", "keepass.kdbx", "keepass.kdbx", { openAfterDownload: true });
  assert.deepEqual(operations, ["start-job", "register-cancel", "show-progress", "job-status",
    "show-progress", "open-cached", "unregister-cancel", "clear-progress"]);
  assert.equal(typeof cancel, "function");
});
test("Android browse-only downloads give actionable guidance instead of doomed service jobs", async () => {
  const state = createInitialState({ deviceName: "Synthetic test client" });
  state.localFolders = [{ id: "folder", label: "Photos", readOnly: false, browseOnly: true }];
  let connected = 0;
  let jobs = 0;
  let notice = "";
  const actions = createFileActions({ state,
    client: { startServiceTransferJob: async () => { jobs++; throw new Error("Unexpected transfer"); } } as never,
    transfers: { setDownloadNotice: (message: string) => { notice = message; } } as never,
    sessionStore: {} as never,
    ensureConnectedForTransfer: async () => { connected++; return true; },
    openCachedFile: async () => {},
  });
  await actions.downloadFile("folder", "retained.txt", "retained.txt");
  assert.equal(connected, 0);
  assert.equal(jobs, 0);
  assert.match(notice, /browse-only.*Reattach local storage/i);
  assert.ok(state.logs.items.some(item => item.event === "download.browse_only.needs_storage"));
});
