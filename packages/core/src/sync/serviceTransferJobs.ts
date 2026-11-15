import type { RemoteFs } from "../core/model/remoteFs.js";
import type { DocumentFilesystem } from "./documentFilesystem.js";
import type { FileDownloadSink, FileUploadSource } from "../transfer/stream.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";
import { sameDeviceId } from "../ui/helpers.js";

export type ServiceTransferDirection = "download" | "upload";
export type ServiceTransferPhase = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ServiceTransferProgress = {
  id: string;
  phase: ServiceTransferPhase;
  transferredBytes: number;
  totalBytes: number;
  attempt?: number;
  reason?: "network" | "storage" | "cancelled" | "unavailable" | "other";
};
export type ServiceTransferRequest = {
  id: string;
  direction: ServiceTransferDirection;
  folderId: string;
  peerId?: string;
  path: string;
  attempts?: number;
  stageId?: string;
  sizeBytes?: number;
  modifiedMs?: number;
  sha256?: string;
};

type Task = { controller: AbortController; promise: Promise<void> };
const safeJobId = (id: string): boolean => /^[a-f0-9-]{8,64}$/i.test(id);
const category = (error: unknown): NonNullable<ServiceTransferProgress["reason"]> => {
  const text = error instanceof Error ? error.message : String(error);
  if (/cancelled by user/i.test(text)) return "cancelled";
  if (/network|socket|offline|closed|timeout|connection|disconnect|interrupted|abort|peer session is unavailable/i.test(text)) return "network";
  if (/document|storage|vault|quota|disk|folder/i.test(text)) return "storage";
  if (/unavailable|not found|missing/i.test(text)) return "unavailable";
  return "other";
};

/** Runs BEP transfers exclusively inside the Android service's JS isolate.
 * The UI sends only a durable job intent; it does not pump downloadPull or uploadProvide.
 * Android persists/replays job intents separately from these active JS tasks. */
export const createServiceTransferJobs = (deps: {
  documents: Pick<DocumentFilesystem, "status" | "cachedFiles" | "digestCachedFiles" |
    "beginDownload" | "write" | "finishDownload" | "release" | "open" | "size" | "read">;
  peerId?: () => string | null;
  remoteFs: () => RemoteFs | null;
  progress: (value: ServiceTransferProgress) => void | Promise<void>;
  readStaged?: (stageId: string, size: number, offset: number, length: number) => Promise<Uint8Array>;
  runExclusive?: (work: () => Promise<void>) => Promise<void>;
}) => {
  const tasks = new Map<string, Task>();
  const terminal = new Set<string>();
  // Persist at most one progress event every 1.5 seconds per job. Native AES/GCM
  // journal writes per network chunk would otherwise throttle the transfer.
  const lastPersisted = new Map<string, number>();
  const publish = (job: ServiceTransferRequest, phase: ServiceTransferPhase,
    transferredBytes: number, totalBytes: number, reason?: ServiceTransferProgress["reason"]) => {
    const now = Date.now();
    if (phase === "running" && lastPersisted.has(job.id) &&
      now - lastPersisted.get(job.id)! < 1500) return;
    lastPersisted.set(job.id, now);
    try {
      void Promise.resolve(deps.progress({ id: job.id, phase, transferredBytes, totalBytes,
        attempt: job.attempts ?? 0, ...(reason ? { reason } : {}) })).catch(() => undefined);
    } catch { /* Diagnostics may not abort the transfer. */ }
    if (phase !== "running" && phase !== "queued") lastPersisted.delete(job.id);
  };

  const download = async (job: ServiceTransferRequest, remote: RemoteFs, controller: AbortController,
    report: (done: number, total: number) => void) => {
    const folder = (await deps.documents.status()).folders.find(value => value.id === job.folderId);
    if (!folder || folder.browseOnly || !folder.downloads) throw new Error("Document downloads are unavailable.");
    const local = (await deps.documents.cachedFiles(job.folderId)).find(file => file.path === job.path);
    const expectedLocalHash = local
      ? (await deps.documents.digestCachedFiles([{ folderId: job.folderId, path: job.path }]))[0]?.hash
      : null;
    if (local && !expectedLocalHash) throw new Error("Existing local document cannot be verified.");
    const parent = job.path.split("/").slice(0, -1).join("/");
    const file = (await remote.readDir(job.folderId, parent))
      .find(entry => entry.path === job.path && entry.type === "file");
    if (!file) throw new Error("Remote file is unavailable.");
    let handle: number | undefined;
    const sink: FileDownloadSink = {
      begin: async metadata => {
        controller.signal.throwIfAborted();
        if (metadata.folderId !== job.folderId || metadata.path !== job.path) {
          throw new Error("Remote download identity changed.");
        }
        handle = await deps.documents.beginDownload(job.folderId, job.path,
          metadata.sizeBytes, file.modifiedMs, expectedLocalHash, metadata);
        report(0, metadata.sizeBytes);
      },
      write: async (offset, bytes) => {
        if (handle === undefined) throw new Error("Download was not initialized.");
        controller.signal.throwIfAborted();
        for (let done = 0; done < bytes.length; done += 131072) {
          await deps.documents.write(handle, offset + done, bytes.subarray(done, done + 131072));
        }
      },
      commit: async () => {
        if (handle === undefined) throw new Error("Download was not initialized.");
        controller.signal.throwIfAborted();
        await deps.documents.finishDownload(handle);
        handle = undefined;
      },
      abort: async () => {
        if (handle === undefined) return;
        const id = handle; handle = undefined;
        await deps.documents.release(id, true);
      },
    };
    try {
      await remote.readFileToSink(job.folderId, job.path, sink,
        value => report(value.downloadedBytes, value.totalBytes), controller.signal);
    } catch (error) {
      await Promise.resolve(sink.abort(error)).catch(() => undefined);
      throw error;
    }
  };

  const upload = async (job: ServiceTransferRequest, remote: RemoteFs, controller: AbortController,
    report: (done: number, total: number) => void) => {
    if (job.stageId) {
      if (!deps.readStaged || !Number.isSafeInteger(job.sizeBytes) || job.sizeBytes! < 0 ||
        !Number.isSafeInteger(job.modifiedMs) || !/^[a-f0-9]{64}$/.test(job.sha256 ?? "")) {
        throw new Error("Encrypted upload staging is unavailable.");
      }
      const source: FileUploadSource = {
        size: job.sizeBytes!,
        read: async (offset, length) => {
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
            length < 0 || offset + length > job.sizeBytes!) throw new Error("Invalid staged read.");
          const output = new Uint8Array(length);
          for (let done = 0; done < length; done += 64 * 1024) {
            controller.signal.throwIfAborted();
            const chunk = await deps.readStaged!(job.stageId!, job.sizeBytes!, offset + done,
              Math.min(64 * 1024, length - done));
            if (chunk.length !== Math.min(64 * 1024, length - done))
              throw new Error("Staged upload is incomplete.");
            output.set(chunk, done);
            chunk.fill(0);
          }
          return output;
        },
      };
      report(0, source.size);
      await remote.writeFileStream(job.folderId, job.path, source, {
        signal: controller.signal, modifiedMs: job.modifiedMs, waitForRemote: true,
        expectedHash: job.sha256,
        onProgress: value => report(value.processedBytes, value.totalBytes),
      });
      report(source.size, source.size);
      return;
    }
    // Upload sources must already be staged in encrypted native document storage.
    // Never accept bytes from a transient WebView as a purported durable source.
    const local = (await deps.documents.cachedFiles(job.folderId)).find(file => file.path === job.path);
    if (!local?.localPath?.startsWith("syncpeer-document:")) {
      throw new Error("Upload source is not in encrypted document storage.");
    }
    const id = local.localPath.slice("syncpeer-document:".length);
    const handle = await deps.documents.open(id, "r");
    try {
      const source: FileUploadSource = {
        size: await deps.documents.size(handle),
        read: (offset, size) => deps.documents.read(handle, offset, size),
      };
      const hash = (await deps.documents.digestCachedFiles([{ folderId: job.folderId, path: job.path }]))[0]?.hash;
      if (!hash) throw new Error("Local upload hash is unavailable.");
      report(0, source.size);
      await remote.writeFileStream(job.folderId, job.path, source, {
        signal: controller.signal, modifiedMs: local.modifiedMs, waitForRemote: true,
        expectedHash: hash,
        onProgress: value => report(value.processedBytes, value.totalBytes),
      });
      report(source.size, source.size);
    } finally {
      await deps.documents.release(handle);
    }
  };

  return {
    start: (job: ServiceTransferRequest): { started: boolean } => {
      if (!safeJobId(job.id) || !job.folderId || job.folderId.length > 4096 ||
        !job.path || job.path.length > 4096 ||
        !["download", "upload"].includes(job.direction)) throw new Error("Invalid transfer job.");
      assertReplicaPath(job.path);
      if (isInternalReplicaPath(job.path)) throw new Error("Private documents cannot be transferred.");
      if (tasks.has(job.id)) return { started: false };
      if (terminal.has(job.id)) return { started: false };
      const controller = new AbortController();
      const promise = (deps.runExclusive ?? (async work => work()))(async () => {
        controller.signal.throwIfAborted();
        const remote = deps.remoteFs();
        // The journal's recipient is not inferred from folder identity:
        // distinct TLS-authenticated peers may advertise the same folder ID.
        if (deps.peerId && (!job.peerId || !sameDeviceId(job.peerId, deps.peerId() ?? ""))) {
          throw new Error("Authenticated transfer recipient mismatch.");
        }
        if (!remote) throw new Error("Peer session is unavailable.");
        let transferredBytes = 0, totalBytes = 0;
        const report = (done: number, total: number) => {
          transferredBytes = done; totalBytes = total;
          publish(job, "running", done, total);
        };
        publish(job, "running", 0, 0);
        try {
          if (job.direction === "download") await download(job, remote, controller, report);
          else await upload(job, remote, controller, report);
          // A completed atomic commit wins over a cancellation arriving afterward.
          terminal.add(job.id);
          if (terminal.size > 256) terminal.delete(terminal.values().next().value!);
          publish(job, "completed", transferredBytes, totalBytes);
        } catch (error) {
          if (controller.signal.aborted) {
            terminal.add(job.id);
            if (terminal.size > 256) terminal.delete(terminal.values().next().value!);
          }
          publish(job, controller.signal.aborted ? "cancelled" : "failed",
            transferredBytes, totalBytes,
            controller.signal.aborted ? "cancelled" : category(error));
        }
        if (controller.signal.aborted) terminal.add(job.id);
      }).catch(error => {
        publish(job, controller.signal.aborted ? "cancelled" : "failed", 0, 0,
          controller.signal.aborted ? "cancelled" : category(error));
      }).finally(() => { tasks.delete(job.id); });
      tasks.set(job.id, { controller, promise });
      return { started: true };
    },
    cancel: (id: string) => { tasks.get(id)?.controller.abort(); return { cancelled: true }; },
    cancelAll: () => { for (const task of tasks.values()) task.controller.abort(); },
    hasActive: (id: string) => tasks.has(id),
  };
};
