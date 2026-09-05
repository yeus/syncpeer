import {
  UploadOutcomeUnknownError,
  withMetadataSession,
  withSessionTransportProgress,
  type SyncpeerSessionHandle,
} from "../client.js";
import { isTransportFailure } from "../core/model/remoteFs.js";
import { createCheckpointedDownloadSink, DownloadInterruptedError, type FileDownloadSink } from "../transfer/stream.js";
import type { ConnectOptions, RemoteFsLike } from "./browserClient.js";

export const createRecoveringRemoteFs = (deps: {
  getOptions: () => ConnectOptions | null;
  ensureSession: (options: ConnectOptions) => Promise<SyncpeerSessionHandle>;
  getFocusedFolderId: () => string | null;
  setFocusedFolderId: (folderId: string | null) => void;
  getActiveSession: () => SyncpeerSessionHandle | null;
}): RemoteFsLike => {
  const metadata = <T>(operation: (session: SyncpeerSessionHandle) => Promise<T>) =>
    withMetadataSession(
      deps.getOptions(),
      deps.ensureSession,
      deps.getFocusedFolderId(),
      operation,
    );

  const download = async (
    sink: FileDownloadSink,
    operation: (session: SyncpeerSessionHandle, sink: FileDownloadSink) => Promise<unknown>,
    signal?: AbortSignal,
  ) => {
    const options = deps.getOptions();
    if (!options) throw new Error("No active connection. Connect first.");
    const checkpointed = createCheckpointedDownloadSink(sink);
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      let session: SyncpeerSessionHandle | null = null;
      try {
        if (signal?.aborted) {
          const error = new Error("Download cancelled.");
          error.name = "AbortError";
          throw error;
        }
        session = await deps.ensureSession(options);
        const folderId = deps.getFocusedFolderId();
        if (folderId) session.remoteFs.setFocusedFolder(folderId);
        return await operation(session, checkpointed.sink);
      } catch (error) {
        const abort = signal?.aborted || (error instanceof Error && error.name === "AbortError");
        const retryable = !abort && isTransportFailure(error) && (!session || session.isClosed());
        if (retryable && attempt < 2) continue;
        if (retryable && sink.suspend) {
          await sink.suspend();
          throw new DownloadInterruptedError("Download interrupted; verified data is retained for the next attempt.", { cause: error });
        }
        await checkpointed.sink.abort(error);
        throw error;
      }
    }
    throw new Error("Download recovery exhausted unexpectedly.");
  };

  const upload = async (
    folderId: string,
    path: string,
    bytes: Uint8Array,
    options?: Parameters<RemoteFsLike["writeFileFully"]>[3],
  ): Promise<void> => {
    const connectOptions = deps.getOptions();
    if (!connectOptions) throw new Error("No active connection. Connect first.");
    const session = await deps.ensureSession(connectOptions);
    try {
      await session.remoteFs.writeFileFully(folderId, path, bytes, options);
    } catch (error) {
      if (!isTransportFailure(error) || !session.isClosed()) throw error;
      try {
        const replacement = await deps.ensureSession(connectOptions);
        replacement.remoteFs.setFocusedFolder(folderId);
        await replacement.remoteFs.requestFolderIndex(folderId);
        if (await replacement.remoteFs.matchesFileContent(folderId, path, bytes)) return;
      } catch {
        // Verification did not prove success, so publication must not be replayed.
      }
      throw new UploadOutcomeUnknownError(undefined, { cause: error });
    }
  };

  return {
    listFolders: () => metadata((session) => session.remoteFs.listFolders()),
    requestFolderIndex: (folderId) => metadata((session) => session.remoteFs.requestFolderIndex(folderId)),
    setFocusedFolder: (folderId) => {
      deps.setFocusedFolderId(folderId);
      const session = deps.getActiveSession();
      if (session && !session.isClosed()) session.remoteFs.setFocusedFolder(folderId);
    },
    waitForFolderIndex: (folderId, timeoutMs, pollMs) =>
      metadata((session) => session.remoteFs.waitForFolderIndex(folderId, timeoutMs, pollMs)),
    readDir: (folderId, path) => metadata((session) => session.remoteFs.readDir(folderId, path)),
    readFileFully: async (folderId, path, onProgress, signal) => {
      let output = new Uint8Array(0);
      await download({
        begin: (file) => { output = new Uint8Array(file.sizeBytes); },
        write: (offset, bytes) => { output.set(bytes, offset); },
        commit: () => undefined,
        abort: () => undefined,
      }, (session, sink) => session.remoteFs.readFileToSink(
        folderId,
        path,
        sink,
        withSessionTransportProgress(session, onProgress),
        signal,
      ), signal);
      return output;
    },
    readFileToSink: (folderId, path, sink, onProgress, signal) =>
      download(sink, (session, checkpointedSink) => session.remoteFs.readFileToSink(
        folderId,
        path,
        checkpointedSink,
        withSessionTransportProgress(session, onProgress),
        signal,
      ), signal) as ReturnType<NonNullable<RemoteFsLike["readFileToSink"]>>,
    writeFileFully: upload,
  };
};
