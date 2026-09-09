import {
  createSha256DownloadSink,
  DownloadInterruptedError,
  cachedFileKey,
  downloadRemoteFile,
  formatEta,
  normalizePath,
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

export const createFileActions = (args: {
  readonly state: AppState;
  readonly client: SyncpeerBrowserClient;
  readonly sessionStore: SyncpeerSessionStore;
  readonly transfers: TransferRuntime;
  readonly ensureConnectedForTransfer: (kind: "download" | "upload") => Promise<boolean>;
  readonly openCachedFile: (folderId: string, path: string) => Promise<void>;
}) => {
  const {
    state,
    client,
    sessionStore,
    transfers,
    ensureConnectedForTransfer,
    openCachedFile,
  } = args;
  const {
    begin: beginManagedTransfer,
    update: updateManagedTransfer,
    finish: finishManagedTransfer,
    setDownloadNotice,
    setActiveDownload,
    clearActiveDownload,
    hasActiveDirection,
  } = transfers;

const downloadFile = async (
  folderId: string,
  path: string,
  name: string,
  options?: { openAfterDownload?: boolean },
) => {
  const downloadKey = cachedFileKey(folderId, path);
  if (state.favorites.activeDownloads[downloadKey]) return;
  const connected = await ensureConnectedForTransfer("download");
  if (!connected || !state.session.remoteFs) return;
  state.favorites.isDownloading = true;
  const startedAt = Date.now();
  let lastTransferLogAtMs = 0;
  let activeTransportKind = state.session.connectionTransport;
  let activeConnectedVia = state.session.connectionPath;
  let activeConnectionScope = state.session.connectionScope;
  let activeSink: FileDownloadSink | null = null;
  let downloadedHash: string;
  let transferOutcome: "completed" | "failed" | "cancelled" = "failed";
  const abortController = new AbortController();
  const cancelTransfer = () => {
    abortController.abort();
    setDownloadNotice(`Cancelling download ${name}…`);
  };
  const transferId = `download:${downloadKey}`;
  const remoteFs = state.session.remoteFs;
  const initialProgressText = `0% • 0 B/s • ETA -- • ${downloadTransportText(
    state.session.connectionTransport,
    state.session.connectionScope,
  )}`;
  setActiveDownload(downloadKey, {
    name,
    text: initialProgressText,
    progressPercent: 0,
  });
  pushSessionLog(state, "info", "download.start", `Downloading ${name}`, {
    folderId,
    path,
    fileName: name,
  });
  try {
    await beginManagedTransfer({
      id: transferId,
      direction: "download",
      label: name,
      completedBytes: 0,
      totalBytes: 0,
      cancellable: true,
    }, cancelTransfer);
    const onProgress = ({
      downloadedBytes,
      totalBytes,
      transportKind,
      connectedVia,
      connectionScope,
      networkBytes,
      reusedBytes,
      resumedBytes,
    }: {
      downloadedBytes: number;
      totalBytes: number;
      networkBytes?: number;
      reusedBytes?: number;
      resumedBytes?: number;
      transportKind?: "direct-tcp" | "direct-quic" | "relay";
      connectedVia?: string;
      connectionScope?: "lan" | "wan" | "unknown";
    }) => {
      activeTransportKind = transportKind ?? activeTransportKind;
      activeConnectedVia = connectedVia ?? activeConnectedVia;
      activeConnectionScope = connectionScope ?? activeConnectionScope;
      const elapsedMs = elapsedMsSince(startedAt);
      const rateBps = averageRateBps(networkBytes ?? downloadedBytes, elapsedMs);
      const progressText = downloadProgressText(
        downloadedBytes,
        totalBytes,
        elapsedMs / 1000,
      ) + ` • ${downloadTransportText(
        transportKind ?? state.session.connectionTransport,
        connectionScope ?? state.session.connectionScope,
      )}`;
      const progressPercent =
        totalBytes > 0
          ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))
          : 0;
      setActiveDownload(downloadKey, {
        name,
        text: progressText,
        progressPercent,
      });
      updateManagedTransfer(transferId, downloadedBytes, totalBytes);
      const now = Date.now();
      if (now - lastTransferLogAtMs >= 2000 || downloadedBytes >= totalBytes) {
        lastTransferLogAtMs = now;
        pushSessionLog(state, "info", "download.progress", `Downloading ${name}`, {
          folderId,
          path,
          downloadedBytes,
          networkBytes,
          reusedBytes,
          resumedBytes,
          totalBytes,
          elapsedMs,
          rateBps: Math.round(rateBps),
          rate: formatRateSafe(rateBps),
          transportKind: transportKind ?? state.session.connectionTransport,
          connectedVia,
          connectionScope: connectionScope ?? state.session.connectionScope,
        });
      }
    };
    let downloadResult: FileDownloadResult;
    const remoteEntry = state.session.entries.find(
      (entry) => entry.type === "file" && normalizePath(entry.path) === normalizePath(path),
    );
    const remoteModifiedMs = remoteEntry?.modifiedMs || Date.now();
    if (remoteFs.readFileToSink && client.createFileDownloadSink) {
      const sink = await client.createFileDownloadSink({
        folderId,
        path,
        name,
        modifiedMs: remoteModifiedMs,
      });
      const hashingSink = createSha256DownloadSink(sink);
      activeSink = hashingSink.sink;
      downloadResult = await remoteFs.readFileToSink(
        folderId,
        path,
        hashingSink.sink,
        onProgress,
        abortController.signal,
      );
      downloadedHash = hashingSink.digestHex();
    } else {
      const bytes = await downloadRemoteFile(remoteFs, {
        folderId,
        path,
        onProgress,
        signal: abortController.signal,
      });
      await client.cacheFile(folderId, path, name, bytes, remoteModifiedMs);
      downloadedHash = await digestBytesHex(bytes);
      downloadResult = { bytesWritten: bytes.length, totalBytes: bytes.length };
    }
    const elapsedMs = elapsedMsSince(startedAt);
    const rateBps = averageRateBps(downloadResult.bytesWritten, elapsedMs);
    updateCachedKey(state, folderId, path, true);
    state.sync.starredFileSyncState[downloadKey] = {
      lastLocalHash: downloadedHash,
      lastRemoteModifiedMs: remoteModifiedMs,
      lastRemoteSizeBytes: downloadResult.totalBytes,
      lastSyncAtMs: Date.now(),
      lastDirection: "download",
    };
    await refreshFolderRootCachedStatuses(state, client, [folderId]);
    const doneProgressText =
      `100% • Done • ${downloadTransportText(activeTransportKind, activeConnectionScope)}`;
    setActiveDownload(downloadKey, {
      name,
      text: doneProgressText,
      progressPercent: 100,
    });
    transferOutcome = "completed";
    setDownloadNotice(
      `Downloaded ${name} via ${downloadTransportText(activeTransportKind, activeConnectionScope)}` +
      ((downloadResult.reusedBytes ?? 0) + (downloadResult.resumedBytes ?? 0) > 0
        ? ` · ${Math.round(((downloadResult.reusedBytes ?? 0) + (downloadResult.resumedBytes ?? 0)) / Math.max(1, downloadResult.totalBytes) * 100)}% recovered locally`
        : ""),
      4000,
    );
    pushSessionLog(state, "info", "download.complete", `Downloaded ${name}`, {
      folderId,
      path,
      sizeBytes: downloadResult.bytesWritten,
      networkBytes: downloadResult.networkBytes,
      reusedBytes: downloadResult.reusedBytes,
      resumedBytes: downloadResult.resumedBytes,
      elapsedMs,
      rateBps: Math.round(rateBps),
      rate: formatRateSafe(rateBps),
      transportKind: activeTransportKind,
      connectedVia: activeConnectedVia,
      connectionScope: activeConnectionScope,
    });
    if (options?.openAfterDownload) {
      await openCachedFile(folderId, path);
    }
  } catch (error) {
    if (activeSink && !(error instanceof DownloadInterruptedError)) {
      try {
        await activeSink.abort(error);
      } catch (abortError) {
        reportActionError(state, "download_file.abort_failed", abortError, { folderId, path });
      }
    }
    if (error instanceof Error && error.name === "AbortError") {
      transferOutcome = "cancelled";
      setDownloadNotice(`Download cancelled: ${name}`, 4000);
    } else {
      reportActionError(state, "download_file.failed", error, { folderId, path });
      restoreAfterTransportFailure(state, error);
      setDownloadNotice(`Download failed: ${name}`, 6000);
    }
  } finally {
    await finishManagedTransfer(transferId, transferOutcome);
    clearActiveDownload(downloadKey);
  }
};

const openOrDownloadFile = async (folderId: string, path: string, name: string) => {
  if (cacheFileKeyExists(state, folderId, path)) {
    await openCachedFile(folderId, path);
    return;
  }
  await downloadFile(folderId, path, name, { openAfterDownload: true });
};

const uploadPreparedFile = async (
  fileName: string,
  bytes: Uint8Array,
  modifiedMs?: number,
  managed?: { id: string; controller: AbortController },
) => {
  const connected = await ensureConnectedForTransfer("upload");
  if (!connected || !state.session.remoteFs) {
    state.ui.uploadMessage = "Connect to a folder before uploading.";
    if (managed) await finishManagedTransfer(managed.id, "failed");
    return;
  }
  const remoteFs = state.session.remoteFs;
  if (!state.session.currentFolderId) {
    state.ui.uploadMessage = "Open a folder first, then upload into the current directory.";
    if (managed) await finishManagedTransfer(managed.id, "failed");
    return;
  }
  const relativePath = normalizePath(
    [state.session.currentPath, fileName].filter(Boolean).join("/"),
  );
  if (!relativePath) {
    state.ui.uploadMessage = "Invalid upload target path.";
    if (managed) await finishManagedTransfer(managed.id, "failed");
    return;
  }
  state.ui.uploadProgressActive = true;
  state.ui.uploadProgressPercent = 0;
  state.ui.uploadProgressEta = "";
  state.ui.uploadProgressRate = "";
  state.ui.uploadMessage = `Uploading ${fileName}...`;
  const startedAtMs = Date.now();
  let lastTransferLogAtMs = 0;
  const controller = managed?.controller ?? new AbortController();
  const transferId = managed?.id ?? `upload:${relativePath}:${startedAtMs}`;
  let transferOutcome: "completed" | "failed" | "cancelled" = "failed";
  if (!managed) {
    await beginManagedTransfer({
      id: transferId,
      direction: "upload",
      label: fileName,
      completedBytes: 0,
      totalBytes: bytes.length,
      cancellable: true,
    }, () => controller.abort());
  }
  pushSessionLog(state, "info", "upload.start", `Uploading ${fileName}`, {
    folderId: state.session.currentFolderId,
    path: relativePath,
    fileName,
    sizeBytes: bytes.length,
  });
  const updateUploadProgress = (processedBytes: number, totalBytes: number) => {
    const elapsedMs = elapsedMsSince(startedAtMs);
    const safeTotal = Math.max(1, totalBytes);
    const pct = Math.min(100, Math.floor((processedBytes / safeTotal) * 100));
    const rateBps = averageRateBps(processedBytes, elapsedMs);
    const remainingBytes = Math.max(0, totalBytes - processedBytes);
    const etaSeconds = rateBps > 0 ? remainingBytes / rateBps : 0;
    state.ui.uploadProgressPercent = pct;
    state.ui.uploadProgressRate = rateBps > 0 ? formatRateSafe(rateBps) : "";
    state.ui.uploadProgressEta = etaSeconds > 0 ? formatEta(etaSeconds) : "";
    const now = Date.now();
    if (now - lastTransferLogAtMs >= 2000 || pct === 100) {
      lastTransferLogAtMs = now;
      pushSessionLog(state, "info", "upload.progress", `Uploading ${fileName}`, {
        folderId: state.session.currentFolderId,
        path: relativePath,
        processedBytes,
        totalBytes,
        percent: pct,
        elapsedMs,
        rateBps: Math.round(rateBps),
        rate: formatRateSafe(rateBps),
        etaSeconds: Math.max(0, Math.round(etaSeconds)),
      });
    }
    const uploadNotice = `Upload ${pct}%${state.ui.uploadProgressEta ? ` · ETA ${state.ui.uploadProgressEta}` : ""}`;
    setDownloadNotice(uploadNotice);
    updateManagedTransfer(transferId, processedBytes, totalBytes);
  };
  try {
    await remoteFs.writeFileFully(
      state.session.currentFolderId,
      relativePath,
      bytes,
      {
        modifiedMs: modifiedMs || Date.now(),
        signal: controller.signal,
        onProgress: (progress) => {
          updateUploadProgress(progress.processedBytes, progress.totalBytes);
        },
      },
    );
    updateUploadProgress(bytes.length, bytes.length);
    await sessionStore.actions.reloadCurrentDirectory(connectionDetails(state));
    applySessionState(state, sessionStore.getState());
    await loadDirectorySideEffects(state, client);
    state.ui.uploadMessage = `Uploaded ${fileName}.`;
    setDownloadNotice(`Uploaded ${fileName}`, 4000);
    transferOutcome = "completed";
    const elapsedMs = elapsedMsSince(startedAtMs);
    const rateBps = averageRateBps(bytes.length, elapsedMs);
    pushSessionLog(state, "info", "upload.complete", `Uploaded ${fileName}`, {
      folderId: state.session.currentFolderId,
      path: relativePath,
      sizeBytes: bytes.length,
      elapsedMs,
      rateBps: Math.round(rateBps),
      rate: formatRateSafe(rateBps),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      transferOutcome = "cancelled";
      state.ui.uploadMessage = `Upload cancelled: ${fileName}`;
      setDownloadNotice(`Upload cancelled: ${fileName}`, 4000);
      return;
    }
    reportActionError(state, "upload_file.failed", error, {
      folderId: state.session.currentFolderId,
      path: relativePath,
      fileName,
      sizeBytes: bytes.length,
    });
    setDownloadNotice(`Upload failed: ${fileName}`, 6000);
  } finally {
    await finishManagedTransfer(transferId, transferOutcome);
    if (!hasActiveDirection("upload")) {
      state.ui.uploadProgressActive = false;
      state.ui.uploadProgressPercent = 0;
      state.ui.uploadProgressEta = "";
      state.ui.uploadProgressRate = "";
    }
  }
};

const handleUploadSelected = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (files.length === 0) {
    state.ui.uploadMessage = "";
    input.value = "";
    return;
  }
  void (async () => {
    const batchId = Date.now();
    const prepared = files.map((file, index) => ({
      file,
      id: `upload:${batchId}:${index}`,
    }));
    const controller = new AbortController();
    for (const item of prepared) {
      await beginManagedTransfer({
        id: item.id,
        direction: "upload",
        label: item.file.name,
        completedBytes: 0,
        totalBytes: item.file.size,
        cancellable: true,
      }, () => controller.abort());
    }
    for (const item of prepared) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await item.file.arrayBuffer());
      } catch (error) {
        reportActionError(state, "upload_file.read_failed", error, {
          fileName: item.file.name,
          sizeBytes: item.file.size,
        });
        await finishManagedTransfer(item.id, "failed");
        continue;
      }
      await uploadPreparedFile(
        item.file.name,
        bytes,
        item.file.lastModified || Date.now(),
        { id: item.id, controller },
      );
    }
  })();
  input.value = "";
};

const handleUploadClick = () => {
  document.getElementById("folder-upload-input")?.click();
};

  return {
    downloadFile,
    openOrDownloadFile,
    uploadPreparedFile,
    handleUploadSelected,
    handleUploadClick,
  };
};
