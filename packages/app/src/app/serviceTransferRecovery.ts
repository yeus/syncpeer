import { cachedFileKey, type SyncpeerBrowserClient } from "@syncpeer/core/browser";
import type { AppState } from "./state.ts";
import type { TransferRuntime } from "./transferRuntime.ts";

export const createServiceTransferReconciler = (args: {
  state: AppState;
  client: SyncpeerBrowserClient;
  transfers: TransferRuntime;
}) => {
  const tracked = new Map<string, { id: string; direction: "download" | "upload"; folderId: string; path: string }>();
  let inFlight: Promise<void> | null = null;
  const refresh = async (): Promise<void> => {
    if (!args.state.ui.isAppVisible || !args.client.listServiceTransferJobs) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const jobs = await args.client.listServiceTransferJobs!();
      const active = jobs.filter(job => job.phase === "queued" || job.phase === "running");
      const currentIds = new Set(active.map(job => job.id));
      for (const job of active) {
        const label = job.path.split("/").pop() || "File";
        const percent = job.totalBytes ? Math.floor(100 * job.transferredBytes / job.totalBytes) : 0;
        const retry = job.nextAttemptMs !== undefined && job.nextAttemptMs > Date.now();
        const key = job.direction === "download"
          ? `download:${cachedFileKey(job.folderId, job.path)}` : `upload-service-native:${job.id}`;
        if (!tracked.has(key)) {
          args.transfers.registerServiceTransfer(key, job.direction, () => {
            void args.client.cancelServiceTransferJob?.(job.id);
          });
        }
        tracked.set(key, { id: job.id, direction: job.direction,
          folderId: job.folderId, path: job.path });
        if (job.direction === "download") {
          args.transfers.setActiveDownload(cachedFileKey(job.folderId, job.path), {
            name: label, text: retry ? "Waiting to retry · Android service" :
              `${job.phase} · Android service · ${percent}%`,
            progressPercent: percent,
          });
        } else if (!args.state.ui.uploadProgressActive) {
          args.state.ui.uploadMessage = retry
            ? `Upload retry scheduled: ${label}` : `Upload continuing in Android service: ${label} (${percent}%)`;
        }
      }
      for (const [key, value] of [...tracked]) {
        if (currentIds.has(value.id)) continue;
        tracked.delete(key);
        args.transfers.unregisterServiceTransfer(key);
        if (value.direction === "download") {
          args.transfers.clearActiveDownload(cachedFileKey(value.folderId, value.path));
        }
        const finished = jobs.find(job => job.id === value.id);
        if (finished?.phase === "completed") {
          args.transfers.setDownloadNotice(`${value.direction === "download" ? "Downloaded" : "Uploaded"} ${value.path.split("/").pop() || "file"}`, 4000);
        }
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    refresh,
    dispose: () => {
      for (const key of tracked.keys()) args.transfers.unregisterServiceTransfer(key);
      tracked.clear();
    },
  };
};
