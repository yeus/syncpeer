import {
  createSha256DownloadSink,
  DownloadInterruptedError,
  cachedFileKey,
  downloadRemoteFile,
  formatEta,
  normalizePath,
  type FileDownloadProgress,
  type FileDownloadResult,
  type FileDownloadSink,
  type SyncpeerBrowserClient,
  type SyncpeerSessionStore,
} from "@syncpeer/core/browser";
import { reportActionError } from "./actionErrors.ts";
import {
  cacheFileKeyExists,
  connectionDetails,
  downloadProgressText,
  downloadTransportText,
  applySessionState,
  pushSessionLog,
  type AppState,
} from "./state.ts";
import {
  averageRateBps,
  digestBytesHex,
  elapsedMsSince,
  formatRateSafe,
  loadDirectorySideEffects,
  restoreAfterTransportFailure,
} from "./actionSupport.ts";
import type { TransferRuntime } from "./transferRuntime.ts";
import { refreshFolderRootCachedStatuses } from "./cacheStatusActions.ts";
import { updateCachedKey } from "./downloadPolicies.ts";

interface FileActionContext {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly transfers: TransferRuntime;
  readonly ensureConnectedForTransfer: (kind: "download" | "upload") => Promise<boolean>;
  readonly openCachedFile: (folderId: string, path: string) => Promise<void>;
}

type TransferOutcome = "completed" | "failed" | "cancelled";

interface DownloadRun {
  readonly context: FileActionContext;
  readonly folderId: string;
  readonly path: string;
  readonly name: string;
  readonly downloadKey: string;
  readonly transferId: string;
  readonly startedAt: number;
  readonly abortController: AbortController;
  lastTransferLogAtMs: number;
  transportKind: AppState["session"]["connectionTransport"];
  connectedVia: string;
  connectionScope: AppState["session"]["connectionScope"];
  sink: FileDownloadSink | null;
  hash: string;
  outcome: TransferOutcome;
}

interface UploadRun {
  readonly context: FileActionContext;
  readonly fileName: string;
  readonly relativePath: string;
  readonly transferId: string;
  readonly startedAtMs: number;
  readonly controller: AbortController;
  readonly managed?: { id: string; controller: AbortController };
  lastTransferLogAtMs: number;
  outcome: TransferOutcome;
}

const createDownloadRun = (
  context: FileActionContext,
  folderId: string,
  path: string,
  name: string,
  downloadKey: string,
): DownloadRun => ({
  context,
  folderId,
  path,
  name,
  downloadKey,
  transferId: `download:${downloadKey}`,
  startedAt: Date.now(),
  abortController: new AbortController(),
  lastTransferLogAtMs: 0,
  transportKind: context.state.session.connectionTransport,
  connectedVia: context.state.session.connectionPath,
  connectionScope: context.state.session.connectionScope,
  sink: null,
  hash: "",
  outcome: "failed",
});

const announceDownloadStart = (run: DownloadRun): void => {
  const { state, transfers } = run.context;
  transfers.setActiveDownload(run.downloadKey, {
    name: run.name,
    text: `0% • 0 B/s • ETA -- • ${downloadTransportText(
      state.session.connectionTransport,
      state.session.connectionScope,
    )}`,
    progressPercent: 0,
  });
  pushSessionLog(state, "info", "download.start", `Downloading ${run.name}`, {
    folderId: run.folderId,
    path: run.path,
    fileName: run.name,
  });
};

const updateDownloadProgressDisplay = (
  run: DownloadRun,
  progress: FileDownloadProgress,
  elapsedMs: number,
): void => {
  const { state, transfers } = run.context;
  const progressText = downloadProgressText(
    progress.downloadedBytes,
    progress.totalBytes,
    elapsedMs / 1000,
  ) + ` • ${downloadTransportText(
    progress.transportKind ?? state.session.connectionTransport,
    progress.connectionScope ?? state.session.connectionScope,
  )}`;
  const progressPercent =
    progress.totalBytes > 0
      ? Math.min(100, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100))
      : 0;
  transfers.setActiveDownload(run.downloadKey, {
    name: run.name,
    text: progressText,
    progressPercent,
  });
};

const maybeLogDownloadProgress = (
  run: DownloadRun,
  progress: FileDownloadProgress,
  elapsedMs: number,
  rateBps: number,
): void => {
  const now = Date.now();
  if (now - run.lastTransferLogAtMs < 2000 && progress.downloadedBytes < progress.totalBytes) {
    return;
  }
  run.lastTransferLogAtMs = now;
  pushSessionLog(run.context.state, "info", "download.progress", `Downloading ${run.name}`, {
    folderId: run.folderId,
    path: run.path,
    downloadedBytes: progress.downloadedBytes,
    networkBytes: progress.networkBytes,
    reusedBytes: progress.reusedBytes,
    resumedBytes: progress.resumedBytes,
    totalBytes: progress.totalBytes,
    elapsedMs,
    rateBps: Math.round(rateBps),
    rate: formatRateSafe(rateBps),
    transportKind: progress.transportKind ?? run.context.state.session.connectionTransport,
    connectedVia: progress.connectedVia,
    connectionScope: progress.connectionScope ?? run.context.state.session.connectionScope,
  });
};

const createDownloadProgressHandler =
  (run: DownloadRun) =>
  (progress: FileDownloadProgress): void => {
    run.transportKind = progress.transportKind ?? run.transportKind;
    run.connectedVia = progress.connectedVia ?? run.connectedVia;
    run.connectionScope = progress.connectionScope ?? run.connectionScope;
    const elapsedMs = elapsedMsSince(run.startedAt);
    const rateBps = averageRateBps(progress.networkBytes ?? progress.downloadedBytes, elapsedMs);
    updateDownloadProgressDisplay(run, progress, elapsedMs);
    run.context.transfers.update(run.transferId, progress.downloadedBytes, progress.totalBytes);
    maybeLogDownloadProgress(run, progress, elapsedMs, rateBps);
  };

const resolveRemoteModifiedMs = (context: FileActionContext, path: string): number => {
  const remoteEntry = context.state.session.entries.find(
    (entry) => entry.type === "file" && normalizePath(entry.path) === normalizePath(path),
  );
  return remoteEntry?.modifiedMs || Date.now();
};

const runDownloadBytes = async (
  run: DownloadRun,
  remoteModifiedMs: number,
): Promise<FileDownloadResult> => {
  const { state, client } = run.context;
  const remoteFs = state.session.remoteFs!;
  const onProgress = createDownloadProgressHandler(run);
  if (remoteFs.readFileToSink && client.createFileDownloadSink) {
    const sink = await client.createFileDownloadSink({
      folderId: run.folderId,
      path: run.path,
      name: run.name,
      modifiedMs: remoteModifiedMs,
    });
    const hashingSink = createSha256DownloadSink(sink);
    run.sink = hashingSink.sink;
    const result = await remoteFs.readFileToSink(
      run.folderId,
      run.path,
      hashingSink.sink,
      onProgress,
      run.abortController.signal,
    );
    run.hash = hashingSink.digestHex();
    return result;
  }
  const bytes = await downloadRemoteFile(remoteFs, {
    folderId: run.folderId,
    path: run.path,
    onProgress,
    signal: run.abortController.signal,
  });
  await client.cacheFile(run.folderId, run.path, run.name, bytes, remoteModifiedMs);
  run.hash = await digestBytesHex(bytes);
  return { bytesWritten: bytes.length, totalBytes: bytes.length };
};

const recordDownloadedFile = (
  run: DownloadRun,
  remoteModifiedMs: number,
  downloadResult: FileDownloadResult,
): void => {
  const { state } = run.context;
  updateCachedKey(state, run.folderId, run.path, true);
  state.sync.starredFileSyncState[run.downloadKey] = {
    lastLocalHash: run.hash,
    lastRemoteModifiedMs: remoteModifiedMs,
    lastRemoteSizeBytes: downloadResult.totalBytes,
    lastSyncAtMs: Date.now(),
    lastDirection: "download",
  };
};

const announceDownloadComplete = (
  run: DownloadRun,
  downloadResult: FileDownloadResult,
  elapsedMs: number,
  rateBps: number,
): void => {
  const { state, transfers } = run.context;
  transfers.setActiveDownload(run.downloadKey, {
    name: run.name,
    text: `100% • Done • ${downloadTransportText(run.transportKind, run.connectionScope)}`,
    progressPercent: 100,
  });
  const recovered = (downloadResult.reusedBytes ?? 0) + (downloadResult.resumedBytes ?? 0);
  transfers.setDownloadNotice(
    `Downloaded ${run.name} via ${downloadTransportText(run.transportKind, run.connectionScope)}` +
      (recovered > 0
        ? ` · ${Math.round((recovered / Math.max(1, downloadResult.totalBytes)) * 100)}% recovered locally`
        : ""),
    4000,
  );
  pushSessionLog(state, "info", "download.complete", `Downloaded ${run.name}`, {
    folderId: run.folderId,
    path: run.path,
    sizeBytes: downloadResult.bytesWritten,
    networkBytes: downloadResult.networkBytes,
    reusedBytes: downloadResult.reusedBytes,
    resumedBytes: downloadResult.resumedBytes,
    elapsedMs,
    rateBps: Math.round(rateBps),
    rate: formatRateSafe(rateBps),
    transportKind: run.transportKind,
    connectedVia: run.connectedVia,
    connectionScope: run.connectionScope,
  });
};

const finalizeDownload = async (
  run: DownloadRun,
  remoteModifiedMs: number,
  downloadResult: FileDownloadResult,
): Promise<void> => {
  const elapsedMs = elapsedMsSince(run.startedAt);
  const rateBps = averageRateBps(downloadResult.bytesWritten, elapsedMs);
  recordDownloadedFile(run, remoteModifiedMs, downloadResult);
  await refreshFolderRootCachedStatuses(run.context.state, run.context.client, [run.folderId]);
  run.outcome = "completed";
  announceDownloadComplete(run, downloadResult, elapsedMs, rateBps);
};

const handleDownloadError = async (run: DownloadRun, error: unknown): Promise<void> => {
  const { state, transfers } = run.context;
  if (run.sink && !(error instanceof DownloadInterruptedError)) {
    try {
      await run.sink.abort(error);
    } catch (abortError) {
      reportActionError(state, "download_file.abort_failed", abortError, {
        folderId: run.folderId,
        path: run.path,
      });
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    run.outcome = "cancelled";
    transfers.setDownloadNotice(`Download cancelled: ${run.name}`, 4000);
    return;
  }
  reportActionError(state, "download_file.failed", error, {
    folderId: run.folderId,
    path: run.path,
  });
  restoreAfterTransportFailure(state, error);
  transfers.setDownloadNotice(`Download failed: ${run.name}`, 6000);
};

const beginDownloadTransfer = async (context: FileActionContext, run: DownloadRun): Promise<void> => {
  await context.transfers.begin(
    {
      id: run.transferId,
      direction: "download",
      label: run.name,
      completedBytes: 0,
      totalBytes: 0,
      cancellable: true,
    },
    () => {
      run.abortController.abort();
      context.transfers.setDownloadNotice(`Cancelling download ${run.name}…`);
    },
  );
};

/** The native service owns the entire transfer, including encrypted writes.
 * WebView polling is presentation only; Android can suspend it mid-transfer. */
const downloadWithServiceJob = async (context: FileActionContext,
  folderId: string, path: string, name: string, openAfterDownload = false): Promise<void> => {
  const { state, client, transfers } = context;
  const key = cachedFileKey(folderId, path);
  let id: string | null = null;
  let lastProgress = "";
  try {
    const peerId = state.session.remoteDevice?.id;
    if (!peerId) throw new Error("Authenticated peer identity is unavailable.");
    const job = await client.startServiceTransferJob!("download", folderId, path, peerId);
    id = job.id;
    const jobId = id;
    transfers.registerServiceTransfer(`download:${key}`, "download", () => {
      void client.cancelServiceTransferJob?.(jobId);
    });
    transfers.setActiveDownload(key, { name, text: "Queued in Android service", progressPercent: 0 });
    for (;;) {
      const status = await client.serviceTransferJobStatus!(jobId);
      const total = status.totalBytes;
      const done = status.transferredBytes;
      const percent = total ? Math.floor(100 * done / total) : 0;
      transfers.setActiveDownload(key, {
        name, text: status.phase === "queued" ? "Queued in Android service" :
          `${percent}% · ${status.phase} · Android service`, progressPercent: percent,
      });
      const progress = `${status.phase}:${Math.floor(done / (256 * 1024))}:${total}`;
      if (progress !== lastProgress) {
        lastProgress = progress;
        pushSessionLog(state, "info", "download.service.job_status",
          "Android service transfer state changed.", { phase: status.phase, transferredBytes: done,
            totalBytes: total });
      }
      if (status.phase === "completed") {
        updateCachedKey(state, folderId, path, true);
        await refreshFolderRootCachedStatuses(state, client, [folderId]);
        transfers.setDownloadNotice(`Downloaded ${name}`, 4000);
        if (openAfterDownload) await context.openCachedFile(folderId, path);
        return;
      }
      if (status.phase === "failed" || status.phase === "cancelled") {
        if (status.phase === "failed") throw new Error(`Android service transfer failed (${status.reason ?? "other"}).`);
        transfers.setDownloadNotice(`Download cancelled: ${name}`, 4000);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  } catch (error) {
    reportActionError(state, "download.service.failed", error, { folderId, path });
    transfers.setDownloadNotice(`Download failed: ${name}`, 6000);
  } finally {
    if (id) transfers.unregisterServiceTransfer(`download:${key}`);
    transfers.clearActiveDownload(key);
  }
};

const downloadFile = async (
  context: FileActionContext,
  folderId: string,
  path: string,
  name: string,
  options?: { openAfterDownload?: boolean },
): Promise<void> => {
  const downloadKey = cachedFileKey(folderId, path);
  if (context.state.favorites.activeDownloads[downloadKey]) return;
  const connected = await context.ensureConnectedForTransfer("download");
  if (!connected || !context.state.session.remoteFs) return;
  if (context.client.startServiceTransferJob && context.client.serviceTransferJobStatus) {
    await downloadWithServiceJob(context, folderId, path, name, options?.openAfterDownload);
    return;
  }
  context.state.favorites.isDownloading = true;
  const run = createDownloadRun(context, folderId, path, name, downloadKey);
  announceDownloadStart(run);
  try {
    await beginDownloadTransfer(context, run);
    const remoteModifiedMs = resolveRemoteModifiedMs(context, path);
    const downloadResult = await runDownloadBytes(run, remoteModifiedMs);
    await finalizeDownload(run, remoteModifiedMs, downloadResult);
    if (options?.openAfterDownload) {
      await context.openCachedFile(folderId, path);
    }
  } catch (error) {
    await handleDownloadError(run, error);
  } finally {
    await context.transfers.finish(run.transferId, run.outcome);
    context.transfers.clearActiveDownload(downloadKey);
  }
};

const openOrDownloadFile = async (
  context: FileActionContext,
  folderId: string,
  path: string,
  name: string,
): Promise<void> => {
  if (cacheFileKeyExists(context.state, folderId, path)) {
    await context.openCachedFile(folderId, path);
    return;
  }
  await downloadFile(context, folderId, path, name, { openAfterDownload: true });
};

const failUpload = async (
  context: FileActionContext,
  message: string,
  managed?: { id: string; controller: AbortController },
): Promise<void> => {
  context.state.ui.uploadMessage = message;
  if (managed) await context.transfers.finish(managed.id, "failed");
};

const prepareUploadUi = (context: FileActionContext, fileName: string): void => {
  const { ui } = context.state;
  ui.uploadProgressActive = true;
  ui.uploadProgressPercent = 0;
  ui.uploadProgressEta = "";
  ui.uploadProgressRate = "";
  ui.uploadMessage = `Uploading ${fileName}...`;
};

const maybeLogUploadProgress = (
  run: UploadRun,
  processedBytes: number,
  totalBytes: number,
  percent: number,
  elapsedMs: number,
  rateBps: number,
  etaSeconds: number,
): void => {
  const now = Date.now();
  if (now - run.lastTransferLogAtMs < 2000 && percent !== 100) return;
  run.lastTransferLogAtMs = now;
  pushSessionLog(run.context.state, "info", "upload.progress", `Uploading ${run.fileName}`, {
    folderId: run.context.state.session.currentFolderId,
    path: run.relativePath,
    processedBytes,
    totalBytes,
    percent,
    elapsedMs,
    rateBps: Math.round(rateBps),
    rate: formatRateSafe(rateBps),
    etaSeconds: Math.max(0, Math.round(etaSeconds)),
  });
};

const createUploadProgressHandler =
  (run: UploadRun) =>
  (processedBytes: number, totalBytes: number): void => {
    const { state, transfers } = run.context;
    const elapsedMs = elapsedMsSince(run.startedAtMs);
    const safeTotal = Math.max(1, totalBytes);
    const percent = Math.min(100, Math.floor((processedBytes / safeTotal) * 100));
    const rateBps = averageRateBps(processedBytes, elapsedMs);
    const remainingBytes = Math.max(0, totalBytes - processedBytes);
    const etaSeconds = rateBps > 0 ? remainingBytes / rateBps : 0;
    state.ui.uploadProgressPercent = percent;
    state.ui.uploadProgressRate = rateBps > 0 ? formatRateSafe(rateBps) : "";
    state.ui.uploadProgressEta = etaSeconds > 0 ? formatEta(etaSeconds) : "";
    maybeLogUploadProgress(run, processedBytes, totalBytes, percent, elapsedMs, rateBps, etaSeconds);
    transfers.setDownloadNotice(
      `Upload ${percent}%${state.ui.uploadProgressEta ? ` · ETA ${state.ui.uploadProgressEta}` : ""}`,
    );
    transfers.update(run.transferId, processedBytes, totalBytes);
  };

const finishUploadSuccess = async (
  context: FileActionContext,
  fileName: string,
  relativePath: string,
  sizeBytes: number,
  startedAtMs: number,
): Promise<void> => {
  await context.sessionStore.actions.reloadCurrentDirectory(connectionDetails(context.state));
  applySessionState(context.state, context.sessionStore.getState());
  await loadDirectorySideEffects(context.state, context.client);
  context.state.ui.uploadMessage = `Uploaded ${fileName}.`;
  context.transfers.setDownloadNotice(`Uploaded ${fileName}`, 4000);
  const elapsedMs = elapsedMsSince(startedAtMs);
  const rateBps = averageRateBps(sizeBytes, elapsedMs);
  pushSessionLog(context.state, "info", "upload.complete", `Uploaded ${fileName}`, {
    folderId: context.state.session.currentFolderId,
    path: relativePath,
    sizeBytes,
    elapsedMs,
    rateBps: Math.round(rateBps),
    rate: formatRateSafe(rateBps),
  });
};

const handleUploadError = (
  context: FileActionContext,
  error: unknown,
  fileName: string,
  relativePath: string,
  sizeBytes: number,
): TransferOutcome => {
  if (error instanceof Error && error.name === "AbortError") {
    context.state.ui.uploadMessage = `Upload cancelled: ${fileName}`;
    context.transfers.setDownloadNotice(`Upload cancelled: ${fileName}`, 4000);
    return "cancelled";
  }
  reportActionError(context.state, "upload_file.failed", error, {
    folderId: context.state.session.currentFolderId,
    path: relativePath,
    fileName,
    sizeBytes,
  });
  context.transfers.setDownloadNotice(`Upload failed: ${fileName}`, 6000);
  return "failed";
};

const resetUploadUiIfIdle = (context: FileActionContext): void => {
  if (context.transfers.hasActiveDirection("upload")) return;
  const { ui } = context.state;
  ui.uploadProgressActive = false;
  ui.uploadProgressPercent = 0;
  ui.uploadProgressEta = "";
  ui.uploadProgressRate = "";
};

const resolveUploadTarget = async (
  context: FileActionContext,
  fileName: string,
  managed?: { id: string; controller: AbortController },
) => {
  const connected = await context.ensureConnectedForTransfer("upload");
  const remoteFs = context.state.session.remoteFs;
  if (!connected || !remoteFs) {
    await failUpload(context, "Connect to a folder before uploading.", managed);
    return null;
  }
  if (!context.state.session.currentFolderId) {
    await failUpload(context, "Open a folder first, then upload into the current directory.", managed);
    return null;
  }
  const relativePath = normalizePath(
    [context.state.session.currentPath, fileName].filter(Boolean).join("/"),
  );
  if (!relativePath) {
    await failUpload(context, "Invalid upload target path.", managed);
    return null;
  }
  return { remoteFs, relativePath };
};

const createUploadRun = (
  context: FileActionContext,
  fileName: string,
  relativePath: string,
  managed?: { id: string; controller: AbortController },
): UploadRun => {
  const startedAtMs = Date.now();
  return {
    context,
    fileName,
    relativePath,
    transferId: managed?.id ?? `upload:${relativePath}:${startedAtMs}`,
    startedAtMs,
    lastTransferLogAtMs: 0,
    controller: managed?.controller ?? new AbortController(),
    managed,
    outcome: "failed",
  };
};

const beginUploadTransfer = async (
  context: FileActionContext,
  run: UploadRun,
  sizeBytes: number,
): Promise<void> => {
  if (run.managed) return;
  await context.transfers.begin(
    {
      id: run.transferId,
      direction: "upload",
      label: run.fileName,
      completedBytes: 0,
      totalBytes: sizeBytes,
      cancellable: true,
    },
    () => run.controller.abort(),
  );
};

const pushUploadStart = (context: FileActionContext, run: UploadRun, sizeBytes: number): void => {
  pushSessionLog(context.state, "info", "upload.start", `Uploading ${run.fileName}`, {
    folderId: context.state.session.currentFolderId,
    path: run.relativePath,
    fileName: run.fileName,
    sizeBytes,
  });
};

const performUpload = async (
  context: FileActionContext,
  run: UploadRun,
  remoteFs: NonNullable<AppState["session"]["remoteFs"]>,
  bytes: Uint8Array,
  modifiedMs: number | undefined,
  updateProgress: (processedBytes: number, totalBytes: number) => void,
): Promise<void> => {
  try {
    await remoteFs.writeFileFully(
      context.state.session.currentFolderId,
      run.relativePath,
      bytes,
      {
        modifiedMs: modifiedMs || Date.now(),
        signal: run.controller.signal,
        onProgress: (progress) => updateProgress(progress.processedBytes, progress.totalBytes),
      },
    );
    updateProgress(bytes.length, bytes.length);
    await finishUploadSuccess(context, run.fileName, run.relativePath, bytes.length, run.startedAtMs);
    run.outcome = "completed";
  } catch (error) {
    run.outcome = handleUploadError(context, error, run.fileName, run.relativePath, bytes.length);
  } finally {
    await context.transfers.finish(run.transferId, run.outcome);
    resetUploadUiIfIdle(context);
  }
};

const uploadPreparedFile = async (
  context: FileActionContext,
  fileName: string,
  bytes: Uint8Array,
  modifiedMs?: number,
  managed?: { id: string; controller: AbortController },
): Promise<void> => {
  const target = await resolveUploadTarget(context, fileName, managed);
  if (!target) return;
  prepareUploadUi(context, fileName);
  const run = createUploadRun(context, fileName, target.relativePath, managed);
  await beginUploadTransfer(context, run, bytes.length);
  pushUploadStart(context, run, bytes.length);
  await performUpload(context, run, target.remoteFs, bytes, modifiedMs, createUploadProgressHandler(run));
};

const readUploadBytes = async (
  context: FileActionContext,
  item: { file: File; id: string },
): Promise<Uint8Array | null> => {
  try {
    return new Uint8Array(await item.file.arrayBuffer());
  } catch (error) {
    reportActionError(context.state, "upload_file.read_failed", error, {
      fileName: item.file.name,
      sizeBytes: item.file.size,
    });
    await context.transfers.finish(item.id, "failed");
    return null;
  }
};

/** Selected-file uploads use independently encrypted native staging. Only the
 * preparation phase requires the WebView; the published job survives suspension. */
const uploadSelectedFilesWithService = async (
  context: FileActionContext,
  files: File[],
): Promise<void> => {
  const controller = new AbortController();
  for (const [index, file] of files.entries()) {
    if (controller.signal.aborted) break;
    const target = await resolveUploadTarget(context, file.name);
    if (!target) return;
    const folderId = context.state.session.currentFolderId;
    const transferId = `upload-service:${Date.now()}:${index}`;
    const startedAtMs = Date.now();
    let jobId: string | null = null;
    prepareUploadUi(context, file.name);
    context.transfers.registerServiceTransfer(transferId, "upload", () => {
      controller.abort();
      if (jobId) void context.client.cancelServiceTransferJob?.(jobId);
    });
    try {
      const job = await context.client.stageServiceUpload!(
        folderId, target.relativePath, context.state.session.remoteDevice?.id ?? "",
        file, file.lastModified || Date.now(), {
          signal: controller.signal,
          onProgress: (done, total) => {
            context.state.ui.uploadMessage = `Encrypting ${file.name} for background upload…`;
            context.state.ui.uploadProgressPercent = total ? Math.floor(100 * done / total) : 100;
          },
        });
      jobId = job.id;
      context.state.ui.uploadProgressPercent = 0;
      context.state.ui.uploadMessage = `Uploading ${file.name} in Android service…`;
      if (controller.signal.aborted) await context.client.cancelServiceTransferJob?.(job.id);
      for (;;) {
        const status = await context.client.serviceTransferJobStatus!(job.id);
        const percent = status.totalBytes
          ? Math.floor(100 * status.transferredBytes / status.totalBytes) : 0;
        context.state.ui.uploadProgressPercent = percent;
        context.state.ui.uploadMessage = status.phase === "queued"
          ? (status.nextAttemptMs && status.nextAttemptMs > Date.now()
            ? `Retrying ${file.name} after connection recovery…`
            : `Queued in Android service: ${file.name}`)
          : `Uploading ${file.name}: ${percent}%`;
        if (status.phase === "completed") {
          try {
            await finishUploadSuccess(context, file.name, target.relativePath, file.size, startedAtMs);
          } catch (error) {
            // Publication succeeded in the service; UI refresh is optional.
            context.state.ui.uploadMessage = `Uploaded ${file.name}; folder refresh pending.`;
            pushSessionLog(context.state, "warning", "upload.service.refresh_failed",
              "Upload completed; the folder view could not refresh.", {
                reason: error instanceof Error ? error.message : String(error),
              });
          }
          break;
        }
        if (status.phase === "cancelled") {
          context.state.ui.uploadMessage = `Upload cancelled: ${file.name}`;
          break;
        }
        if (status.phase === "failed") {
          throw new Error(`Android service upload failed (${status.reason ?? "other"}).`);
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    } catch (error) {
      handleUploadError(context, error, file.name, target.relativePath, file.size);
    } finally {
      context.transfers.unregisterServiceTransfer(transferId);
      context.state.ui.uploadProgressActive = false;
      context.state.ui.uploadProgressPercent = 0;
      context.state.ui.uploadProgressEta = "";
      context.state.ui.uploadProgressRate = "";
    }
  }
};

const uploadSelectedFiles = async (
  context: FileActionContext,
  files: File[],
): Promise<void> => {
  if (context.client.stageServiceUpload && context.client.serviceTransferJobStatus) {
    await uploadSelectedFilesWithService(context, files);
    return;
  }
  const batchId = Date.now();
  const prepared = files.map((file, index) => ({ file, id: `upload:${batchId}:${index}` }));
  const controller = new AbortController();
  for (const item of prepared) {
    await context.transfers.begin(
      {
        id: item.id,
        direction: "upload",
        label: item.file.name,
        completedBytes: 0,
        totalBytes: item.file.size,
        cancellable: true,
      },
      () => controller.abort(),
    );
  }
  for (const item of prepared) {
    const bytes = await readUploadBytes(context, item);
    if (!bytes) continue;
    await uploadPreparedFile(context, item.file.name, bytes, item.file.lastModified || Date.now(), {
      id: item.id,
      controller,
    });
  }
};

const handleUploadSelected = (context: FileActionContext, event: Event): void => {
  const input = event.currentTarget as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (files.length === 0) {
    context.state.ui.uploadMessage = "";
    input.value = "";
    return;
  }
  void uploadSelectedFiles(context, files);
  input.value = "";
};

const handleUploadClick = (): void => {
  document.getElementById("folder-upload-input")?.click();
};

const openVersions = async (
  context: FileActionContext,
  folderId: string,
  path: string,
  name: string,
): Promise<void> => {
  context.state.versions = {
    folderId,
    path: normalizePath(path),
    name,
    items: [],
    loading: true,
    restoringId: "",
    error: "",
  };
  context.state.currentPage = "versions";
  try {
    context.state.versions.items = await context.client.listDocumentVersions(folderId, path);
  } catch (error) {
    context.state.versions.error = error instanceof Error ? error.message : String(error);
  } finally {
    context.state.versions.loading = false;
  }
};

const restoreVersion = async (
  context: FileActionContext,
  versionId: string,
): Promise<void> => {
  if (
    !context.state.versions.folderId ||
    !context.state.versions.path ||
    context.state.versions.restoringId
  ) {
    return;
  }
  context.state.versions.restoringId = versionId;
  context.state.versions.error = "";
  try {
    await context.client.restoreDocumentVersion(
      context.state.versions.folderId,
      context.state.versions.path,
      versionId,
    );
    context.state.versions.items = await context.client.listDocumentVersions(
      context.state.versions.folderId,
      context.state.versions.path,
    );
  } catch (error) {
    context.state.versions.error = error instanceof Error ? error.message : String(error);
  } finally {
    context.state.versions.restoringId = "";
  }
};

export const createFileActions = (args: FileActionContext) => ({
  downloadFile: (folderId: string, path: string, name: string, options?: { openAfterDownload?: boolean }) =>
    downloadFile(args, folderId, path, name, options),
  openOrDownloadFile: (folderId: string, path: string, name: string) =>
    openOrDownloadFile(args, folderId, path, name),
  uploadPreparedFile: (
    fileName: string,
    bytes: Uint8Array,
    modifiedMs?: number,
    managed?: { id: string; controller: AbortController },
  ) => uploadPreparedFile(args, fileName, bytes, modifiedMs, managed),
  handleUploadSelected: (event: Event) => handleUploadSelected(args, event),
  handleUploadClick: () => handleUploadClick(),
  openVersions: (folderId: string, path: string, name: string) =>
    openVersions(args, folderId, path, name),
  restoreVersion: (versionId: string) => restoreVersion(args, versionId),
});
