import type { SyncpeerSessionHandle, SyncpeerSessionClosure } from "../client.js";
import type { ConnectOptions } from "../ui/browserClient.js";
import type { FileDownloadMetadata, FileDownloadSink, FileUploadSource } from "../transfer/stream.js";
import { validateBlockPlan, type RangeDigest } from "../transfer/blockReuse.js";
import { decodeBase64, encodeBase64 } from "../transfer/base64.js";
import { parseServiceSessionStatusEvent, serviceSessionStatusIsTerminal,
  serviceSessionStatusMessage } from "./serviceSessionStatus.js";
import { parseServiceResponse, withServiceProtocol } from "./serviceProtocol.js";
import type { FileDownloadProgress, FileUploadOptions, FileDeleteOptions, FileEntry } from "../core/model/remoteFs.js";

type CallService = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
// The service must not block its single JS worker while the WebView is between
// uploadProvide or downloadCancel commands, so pending polls yield here instead.
const serviceTransferPollDelayMs = 5;
const waitForServiceFrame = () => new Promise<void>(resolve => setTimeout(resolve, serviceTransferPollDelayMs));
/** Native status subscription; the service pushes snapshots and replays its latest. */
export type ServiceSessionStatusSubscription = (
  listener: (event: unknown) => void,
) => Promise<() => void>;
type Overview = {
  folders: Awaited<ReturnType<SyncpeerSessionHandle["remoteFs"]["listFolders"]>>;
  device?: ReturnType<SyncpeerSessionHandle["remoteFs"]["getRemoteDeviceInfo"]>;
  folderSyncStates: Awaited<ReturnType<SyncpeerSessionHandle["remoteFs"]["listFolderSyncStates"]>>;
  connectedVia: string;
  transportKind: SyncpeerSessionHandle["transportKind"];
  connectionScope?: SyncpeerSessionHandle["connectionScope"];
};

const requireResult = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Android service session response.");
  }
  return value as Record<string, unknown>;
};

/** Reassembles the bounded service metadata frames before a download sink starts. */
const createDownloadMetadataAssembler = (sink: FileDownloadSink) => {
  type BasicMetadata = Omit<FileDownloadMetadata, "blocks">;
  let basic: BasicMetadata | null = null;
  let blocks: RangeDigest[] = [];
  let complete = false;
  let begun = false;
  const requireBasic = (message: string): BasicMetadata => {
    if (!basic) throw new Error(message);
    return basic;
  };

  const acceptBegin = async (raw: unknown) => {
    if (basic) throw new Error("Service download began more than once.");
    const value = requireResult(raw);
    if (typeof value.folderId !== "string" || typeof value.path !== "string" ||
      !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0 ||
      typeof value.encrypted !== "boolean") {
      throw new Error("Invalid service download metadata.");
    }
    if (value.blocks !== undefined && (!Array.isArray(value.blocks) || value.blocks.length)) {
      throw new Error("Service download sent block metadata in its begin frame.");
    }
    basic = {
      ...(typeof value.sourceDeviceId === "string" ? { sourceDeviceId: value.sourceDeviceId } : {}),
      folderId: value.folderId,
      path: value.path,
      sizeBytes: Number(value.sizeBytes),
      encrypted: value.encrypted,
      ...(typeof value.contentId === "string" ? { contentId: value.contentId } : {}),
    };
  };

  const acceptBlocks = (raw: unknown) => {
    const value = requireResult(raw);
    requireBasic("Service download metadata blocks arrived before the begin frame.");
    if (complete) throw new Error("Service download metadata blocks arrived after the end frame.");
    const rawBlocks = value.blocks;
    if (!Array.isArray(rawBlocks) || !rawBlocks.length ||
      !Number.isSafeInteger(value.offset) || Number(value.offset) !== blocks.length) {
      throw new Error("Invalid service download metadata block offsets.");
    }
    blocks = [...blocks, ...rawBlocks.map((entry: unknown) => {
      const block = requireResult(entry);
      if (!Number.isSafeInteger(block.offset) || Number(block.offset) < 0 ||
        !Number.isSafeInteger(block.size) || Number(block.size) < 0 ||
        !Array.isArray(block.hash) || block.hash.length !== 32 ||
        block.hash.some(byte => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255)) {
        throw new Error("Invalid service download block descriptor.");
      }
      return { offset: Number(block.offset), size: Number(block.size),
        hash: Uint8Array.from(block.hash as number[]) };
    })];
  };

  const acceptEnd = async (raw: unknown) => {
    const value = requireResult(raw);
    const metadata = requireBasic("Service download metadata ended before the begin frame.");
    if (complete) throw new Error("Service download metadata ended more than once.");
    if (typeof value.hasBlockPlan !== "boolean" ||
      !Number.isSafeInteger(value.blockCount) || Number(value.blockCount) !== blocks.length) {
      throw new Error("Invalid service download metadata end marker.");
    }
    if (value.hasBlockPlan) validateBlockPlan(blocks, metadata.sizeBytes);
    else if (blocks.length) throw new Error("Service download sent blocks without a block plan.");
    complete = true;
    await sink.begin({ ...metadata, ...(value.hasBlockPlan ? { blocks } : {}) });
    begun = true;
  };

  return {
    acceptBegin,
    acceptBlocks,
    acceptEnd,
    isComplete: () => complete,
    isBegun: () => begun,
  };
};

const pagedEntries = async (
  rpc: CallService, request: Record<string, unknown>, signal?: AbortSignal,
): Promise<FileEntry[]> => {
  const entries: FileEntry[] = [];
  let limit = 128;
  for (let offset = 0, count = 0;; count++) {
    if (count > 10000) throw new Error("Remote directory exceeds the page limit.");
    let page: Record<string, unknown>;
    try {
      page = requireResult(parseServiceResponse(String(request.operation),
        await rpc(withServiceProtocol({ ...request, offset, limit }), signal)));
    } catch (error) {
      if (limit > 1 && /page too large/i.test(String(error))) {
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      throw error;
    }
    if (!Array.isArray(page.entries) || page.entries.length > limit) {
      throw new Error("Invalid remote directory page.");
    }
    for (const raw of page.entries) {
      const entry = requireResult(raw);
      if (typeof entry.name !== "string" || typeof entry.path !== "string") {
        throw new Error("Invalid remote directory entry.");
      }
      const blocks = Array.isArray(entry.blocks) ? entry.blocks.map(rawBlock => {
        const block = requireResult(rawBlock);
        if (!Array.isArray(block.hash) || block.hash.length !== 32) {
          throw new Error("Invalid remote block digest.");
        }
        return { ...block, hash: Uint8Array.from(block.hash) };
      }) : undefined;
      entries.push({ ...entry, blocks } as FileEntry);
    }
    if (page.nextOffset === null) return entries;
    if (typeof page.nextOffset !== "number" || page.nextOffset <= offset ||
      !Number.isSafeInteger(page.nextOffset)) {
      throw new Error("Invalid remote directory page cursor.");
    }
    offset = page.nextOffset;
  }
};

/** UI-side view of the Android service's one peer session.
 * Closing this handle detaches a WebView client, not the actual peer socket.
 */
export async function createServiceOwnedSession(
  rpc: CallService,
  options: ConnectOptions,
  signal?: AbortSignal,
  heartbeatIntervalMs = 15_000,
  subscribeStatus?: ServiceSessionStatusSubscription,
): Promise<SyncpeerSessionHandle> {
  const connected = requireResult(parseServiceResponse("connect",
    await rpc(withServiceProtocol({ operation: "connect", options }), signal)));
  if (connected.phase !== "connected") {
    throw new Error("Android service could not establish a peer session.");
  }
  const overview = requireResult(parseServiceResponse("overview",
    await rpc(withServiceProtocol({ operation: "overview" }), signal))) as Overview;
  if (!Array.isArray(overview.folders) || typeof overview.connectedVia !== "string" ||
    !["direct-tcp", "direct-quic", "relay"].includes(overview.transportKind)) {
    throw new Error("Android service returned an invalid peer overview.");
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 10) {
    throw new Error("Invalid Android session heartbeat interval.");
  }
  let detached = false;
  let lastStatusRevision = -1;
  let unsubscribeStatus: (() => void) | null = null;
  let resolveClosed: (closure: SyncpeerSessionClosure) => void = () => undefined;
  const closed = new Promise<SyncpeerSessionClosure>(resolve => { resolveClosed = resolve; });
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const markClosed = (kind: SyncpeerSessionClosure["kind"], message: string) => {
    if (detached) return;
    detached = true;
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    resolveClosed({ kind, message });
  };
  // Seed the revision before subscribing so an older replayed snapshot can
  // never close a freshly connected proxy. Older services may omit revision.
  try {
    const seed = requireResult(parseServiceResponse("status",
      await rpc(withServiceProtocol({ operation: "status" }), signal)));
    if (Number.isSafeInteger(seed.revision)) lastStatusRevision = Number(seed.revision);
  } catch { /* The status command is optional for backward compatibility. */ }
  const applyStatusEvent = (value: unknown) => {
    const event = parseServiceSessionStatusEvent(value);
    if (!event || detached || event.revision <= lastStatusRevision) return;
    lastStatusRevision = event.revision;
    if (serviceSessionStatusIsTerminal(event)) {
      markClosed("transport", serviceSessionStatusMessage(event));
    }
  };
  if (subscribeStatus) {
    void subscribeStatus(applyStatusEvent).then(unsubscribe => {
      if (detached) unsubscribe(); else unsubscribeStatus = unsubscribe;
    }, () => undefined);
  }
  // WebView proxies otherwise report a stale "connected" session indefinitely
  // if Android kills the service while the app is still visible. Push events are
  // primary; this bounded health check remains the fallback for a dead binder.
  let healthCheckInFlight = false;
  heartbeatTimer = setInterval(() => {
    if (detached || healthCheckInFlight) return;
    healthCheckInFlight = true;
    void rpc(withServiceProtocol({ operation: "status" })).then(value => {
      if (detached) return;
      const status = requireResult(parseServiceResponse("status", value));
      if (Number.isSafeInteger(status.revision) && Number(status.revision) > lastStatusRevision) {
        lastStatusRevision = Number(status.revision);
      }
      if (status.active !== true || status.phase !== "connected") {
        markClosed("transport", "Android service peer session is no longer connected.");
      }
    }, () => {
      markClosed("transport", "Android service is unavailable.");
    }).catch(error => {
      markClosed("protocol", error instanceof Error ? error.message : "Invalid Android service status.");
    }).finally(() => { healthCheckInFlight = false; });
  }, heartbeatIntervalMs);
  // Focus updates are synchronous in the shared RemoteFs contract. Queue them
  // ahead of later session commands so the service never observes a stale focus.
  let focusBarrier: Promise<unknown> = Promise.resolve();
  let focusedFolderId: string | null = null;
  const call = async (command: Record<string, unknown>, userSignal?: AbortSignal,
    validateResponse = true) => {
    await focusBarrier.catch(() => undefined);
    if (detached) throw new Error("Android service session is detached.");
    let result: unknown;
    try {
      result = await rpc(withServiceProtocol(command), userSignal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/peer session is (unavailable|not connected)|service-owned peer session is connected|Android service session unavailable/i.test(message)) {
        markClosed("transport", "Android service session disconnected.");
      }
      throw error;
    }
    if (!validateResponse) return result;
    try {
      return parseServiceResponse(String(command.operation), result);
    } catch (error) {
      markClosed("protocol", error instanceof Error ? error.message : "Invalid Android service response.");
      throw error;
    }
  };
  // The device and folder-state overview can change while this proxy is alive.
  // Keep the last authenticated overview so sync callers that read it
  // synchronously do not stay pinned to the initial handshake.
  let currentOverview = overview;
  const remoteFs = {
    getRemoteDeviceInfo: () => currentOverview.device,
    listFolderSyncStates: async () => {
      const next = requireResult(await call({ operation: "overview" })) as Overview;
      if (!Array.isArray(next.folders) || !Array.isArray(next.folderSyncStates) ||
        typeof next.connectedVia !== "string" ||
        !["direct-tcp", "direct-quic", "relay"].includes(next.transportKind)) {
        throw new Error("Android service returned an invalid peer overview.");
      }
      currentOverview = next;
      return currentOverview.folderSyncStates;
    },
    listFolders: async () => {
      const next = await call({ operation: "listFolders" });
      if (!Array.isArray(next)) throw new Error("Android service returned an invalid folder list.");
      return next as Overview["folders"];
    },
    setFocusedFolder: (folderId: string | null) => {
      if (folderId === focusedFolderId) return;
      focusedFolderId = folderId;
      const previous = focusBarrier;
      focusBarrier = previous.then(() => detached ? undefined :
        rpc(withServiceProtocol({ operation: "setFocusedFolder", folderId })).catch(() => undefined));
    },
    requestFolderIndex: async (folderId: string) => {
      await call({ operation: "requestFolderIndex", folderId });
    },
    waitForFolderIndex: async (folderId: string, timeoutMs?: number) =>
      await call({ operation: "waitForFolderIndex", folderId, timeoutMs }) as boolean,
    readDir: (folderId: string, path: string) =>
      pagedEntries(call, { operation: "readDir", folderId, path }),
    listFiles: (folderId: string) =>
      pagedEntries(call, { operation: "listFiles", folderId }),
    readFileToSink: async (folderId: string, path: string, sink: FileDownloadSink,
      onProgress?: (value: FileDownloadProgress) => void, userSignal?: AbortSignal) => {
      const started = requireResult(await call({ operation: "downloadStart", folderId, path }, userSignal));
      if (typeof started.transferId !== "string") throw new Error("Android service did not create a download.");
      const transferId = started.transferId;
      const assembler = createDownloadMetadataAssembler(sink);
      let finished = false;
      let bytesWritten = 0;
      let totalBytes = 0;
      try {
        for (;;) {
          const frame = requireResult(await call({ operation: "downloadPull", transferId }, userSignal, false));
          if (frame.type === "pending") { await waitForServiceFrame(); continue; }
          if (frame.type === "begin") {
            await assembler.acceptBegin(frame.metadata);
            totalBytes = Number(requireResult(frame.metadata).sizeBytes);
          } else if (frame.type === "metadataBlocks") {
            assembler.acceptBlocks(frame);
          } else if (frame.type === "metadataEnd") {
            await assembler.acceptEnd(frame);
          } else if (frame.type === "chunk") {
            if (!assembler.isComplete()) throw new Error("Service download sent a chunk before complete metadata.");
            if (typeof frame.bytes !== "string" || frame.bytes.length > 90 * 1024 ||
              typeof frame.offset !== "number" || !Number.isSafeInteger(frame.offset) || frame.offset < 0) {
              throw new Error("Invalid remote download chunk.");
            }
            let bytes: Uint8Array;
            try { bytes = decodeBase64(frame.bytes, 64 * 1024); }
            catch { throw new Error("Invalid remote download chunk."); }
            await sink.write(frame.offset, bytes);
            bytesWritten += bytes.length;
            onProgress?.({ downloadedBytes: bytesWritten, totalBytes });
          } else if (frame.type === "error") {
            throw new Error(typeof frame.message === "string" ? frame.message : "Remote download failed.");
          } else if (frame.type === "commit") {
            if (!assembler.isComplete()) throw new Error("Service download committed before complete metadata.");
            await sink.commit();
            finished = true;
            return { bytesWritten, totalBytes, networkBytes: bytesWritten };
          } else {
            throw new Error("Unknown remote download frame.");
          }
        }
      } catch (error) {
        if (assembler.isBegun()) {
          try { await sink.abort(error); } catch { /* Preserve the original failure. */ }
        }
        throw error;
      } finally {
        if (!finished) await rpc(withServiceProtocol({ operation: "downloadCancel", transferId })).catch(() => undefined);
      }
    },
    readFileFully: async (folderId: string, path: string,
      onProgress?: (value: FileDownloadProgress) => void, userSignal?: AbortSignal) => {
      let result = new Uint8Array(0);
      await remoteFs.readFileToSink(folderId, path, {
        begin: metadata => { result = new Uint8Array(metadata.sizeBytes); },
        write: (offset, bytes) => { result.set(bytes, offset); },
        commit: () => undefined,
        abort: () => undefined,
      }, onProgress, userSignal);
      return result;
    },
    writeFileStream: async (folderId: string, path: string, source: FileUploadSource,
      options: FileUploadOptions = {}) => {
      const { signal: userSignal, onProgress, ...serialized } = options;
      const startedAt = Date.now();
      const started = requireResult(await call({
        operation: "uploadStart", folderId, path, size: source.size, options: serialized,
      }, userSignal));
      if (typeof started.uploadId !== "string") throw new Error("Android service did not create an upload.");
      const uploadId = started.uploadId;
      let finished = false;
      let sent = 0;
      try {
        for (;;) {
          const frame = requireResult(await call({ operation: "uploadPoll", uploadId }, userSignal, false));
          if (frame.type === "pending") { await waitForServiceFrame(); continue; }
          if (frame.type === "done") { finished = true; return; }
          if (frame.type === "error") {
            throw new Error(typeof frame.message === "string" ? frame.message : "Remote upload failed.");
          }
          if (frame.type !== "need" || typeof frame.requestId !== "string" ||
            !Number.isSafeInteger(frame.offset) || Number(frame.offset) < 0 ||
            !Number.isSafeInteger(frame.size) || Number(frame.size) < 1 || Number(frame.size) > 64 * 1024) {
            throw new Error("Invalid upload source request.");
          }
          const bytes = await source.read(Number(frame.offset), Number(frame.size));
          if (bytes.length !== frame.size) throw new Error("Upload source returned an incomplete range.");
          await call({ operation: "uploadProvide", uploadId, requestId: frame.requestId,
            bytes: encodeBase64(bytes) }, userSignal);
          sent += bytes.length;
          onProgress?.({ processedBytes: sent, totalBytes: source.size,
            elapsedMs: Date.now() - startedAt, phase: "preparing" });
        }
      } finally {
        if (!finished) await rpc(withServiceProtocol({ operation: "uploadCancel", uploadId })).catch(() => undefined);
      }
    },
    writeFileFully: async (folderId: string, path: string, bytes: Uint8Array,
      options?: FileUploadOptions) =>
      remoteFs.writeFileStream(folderId, path,
        { size: bytes.length, read: async (offset, size) => bytes.slice(offset, offset + size) }, options),
    deleteFile: async (folderId: string, path: string, options: FileDeleteOptions = {}) => {
      await call({ operation: "deleteFile", folderId, path, waitForRemote: options.waitForRemote }, options.signal);
    },
    // Never guess upload success after a transport failure. Reconciliation can verify later.
    matchesFileContent: async () => false,
  };
  return {
    remoteDeviceId: String(options.remoteId || overview.device?.id || ""),
    remoteFs: remoteFs as unknown as SyncpeerSessionHandle["remoteFs"],
    connectedVia: overview.connectedVia,
    transportKind: overview.transportKind,
    connectionScope: overview.connectionScope,
    isClosed: () => detached,
    close: async () => markClosed("manual", "WebView detached from Android service session."),
    closed,
  };
}
