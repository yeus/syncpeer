import type { FileDownloadMetadata, FileDownloadSink } from "../transfer/stream.js";
import { validateBlockPlan, type RangeDigest } from "../transfer/blockReuse.js";
import { encodeBase64 } from "../transfer/base64.js";

/** Serialized block digest as it travels over the Android JSON IPC boundary. */
export type ServiceDownloadBlock = { offset: number; size: number; hash: number[] };

export type ServiceDownloadFrame =
  | { type: "begin"; metadata: Omit<FileDownloadMetadata, "blocks"> }
  | { type: "metadataBlocks"; offset: number; blocks: ServiceDownloadBlock[] }
  | { type: "metadataEnd"; blockCount: number; hasBlockPlan: boolean }
  | { type: "chunk"; offset: number; bytes: string }
  | { type: "commit" }
  | { type: "error"; message: string }
  | { type: "pending" };

type DownloadOperation = (
  folderId: string, path: string, sink: FileDownloadSink, signal: AbortSignal,
) => Promise<unknown>;

const abortError = () => Object.assign(new Error("Download cancelled."), { name: "AbortError" });
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export function createServiceDownloadBridge(
  download: DownloadOperation,
  settings: { chunkSize?: number; bufferedFrames?: number; metadataFrameBytes?: number } = {},
) {
  const chunkSize = settings.chunkSize ?? 32 * 1024;
  const maxFrames = settings.bufferedFrames ?? 8;
  // Leave headroom below the 64 KiB Android IPC frame limit for native wrappers.
  const maxMetadataFrameBytes = settings.metadataFrameBytes ?? 32 * 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 64 * 1024 ||
    !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 16 ||
    !Number.isSafeInteger(maxMetadataFrameBytes) || maxMetadataFrameBytes < 256 ||
    maxMetadataFrameBytes > 48 * 1024) {
    throw new Error("Invalid service download buffer configuration.");
  }
  type State = {
    frames: ServiceDownloadFrame[];
    controller: AbortController;
    wakeWrite: Set<() => void>;
    terminal: boolean;
    begun: boolean;
    metadataEnded: boolean;
    finished: boolean;
  };
  const operations = new Map<string, State>();
  let serial = 0;

  const wake = (callbacks: Set<() => void>) => {
    for (const callback of callbacks) callback();
    callbacks.clear();
  };
  const push = async (state: State, frame: ServiceDownloadFrame) => {
    while (state.frames.length >= maxFrames) {
      if (state.controller.signal.aborted) throw abortError();
      await new Promise<void>(resolve => state.wakeWrite.add(resolve));
    }
    if (state.controller.signal.aborted) throw abortError();
    state.frames.push(frame);
  };

  const serializedBlock = (block: RangeDigest): ServiceDownloadBlock => ({
    offset: block.offset, size: block.size, hash: Array.from(block.hash),
  });

  const pushMetadata = async (state: State, metadata: FileDownloadMetadata) => {
    const { blocks, ...basic } = metadata;
    if (typeof basic.folderId !== "string" || typeof basic.path !== "string" ||
      !Number.isSafeInteger(basic.sizeBytes) || basic.sizeBytes < 0 ||
      typeof basic.encrypted !== "boolean") {
      throw new Error("Invalid service download metadata.");
    }
    await push(state, { type: "begin", metadata: basic });
    const plan = blocks ?? [];
    if (blocks) validateBlockPlan(plan, metadata.sizeBytes);
    let offset = 0;
    let pending: ServiceDownloadBlock[] = [];
    let pendingBytes = 0;
    let prefixBytes = encode({ type: "metadataBlocks", offset, blocks: [] });
    const flush = async () => {
      if (!pending.length) return;
      await push(state, { type: "metadataBlocks", offset, blocks: pending });
      offset += pending.length;
      pending = [];
      pendingBytes = 0;
      prefixBytes = encode({ type: "metadataBlocks", offset, blocks: [] });
    };
    for (const block of plan) {
      const encoded = serializedBlock(block);
      const blockBytes = encode(encoded);
      const candidateBytes = prefixBytes + pendingBytes + blockBytes + pending.length;
      if (candidateBytes > maxMetadataFrameBytes) {
        if (!pending.length) throw new Error("Download block descriptor exceeds the metadata frame limit.");
        await flush();
      }
      pending.push(encoded);
      pendingBytes += blockBytes;
    }
    await flush();
    await push(state, { type: "metadataEnd", blockCount: offset, hasBlockPlan: blocks !== undefined });
  };

  const start = (folderId: string, path: string) => {
    const id = String(++serial);
    const state: State = {
      frames: [], controller: new AbortController(),
      wakeWrite: new Set(), terminal: false,
      begun: false, metadataEnded: false, finished: false,
    };
    operations.set(id, state);
    const sink: FileDownloadSink = {
      maxWriteSize: chunkSize,
      begin: async metadata => {
        if (state.begun || state.finished) throw new Error("Service download began more than once.");
        state.begun = true;
        await pushMetadata(state, metadata);
        state.metadataEnded = true;
      },
      write: async (offset, bytes) => {
        if (!state.metadataEnded || state.finished) {
          throw new Error("Service download wrote data before its metadata was complete.");
        }
        for (let start = 0; start < bytes.length; start += chunkSize) {
          const part = bytes.subarray(start, start + chunkSize);
          await push(state, { type: "chunk", offset: offset + start, bytes: encodeBase64(part) });
        }
      },
      commit: async () => {
        if (!state.metadataEnded || state.finished) {
          throw new Error("Service download committed without complete metadata.");
        }
        state.finished = true;
        await push(state, { type: "commit" });
      },
      abort: async error => {
        if (state.finished) return;
        state.finished = true;
        await push(state, { type: "error",
          message: error instanceof Error ? error.message : String(error) });
      },
    };
    void Promise.resolve().then(() => download(folderId, path, sink, state.controller.signal))
      .catch(error => {
        if (state.controller.signal.aborted || state.finished) return;
        state.finished = true;
        return push(state, { type: "error",
          message: error instanceof Error ? error.message : String(error) });
      }).finally(() => { state.terminal = true; });
    return id;
  };
  const pull = async (id: string): Promise<ServiceDownloadFrame> => {
    const state = operations.get(id);
    if (!state) throw new Error("Unknown service download.");
    // Never wait inside the shared service JS worker: the WebView's next
    // uploadProvide/downloadCancel command must be able to run concurrently.
    const frame = state.frames.shift();
    if (frame) {
      wake(state.wakeWrite);
      if (frame.type === "commit" || frame.type === "error") operations.delete(id);
      return frame;
    }
    if (state.terminal) {
      operations.delete(id);
      throw new Error("Service download ended without a completion frame.");
    }
    return { type: "pending" };
  };
  const cancel = (id: string) => {
    const state = operations.get(id);
    if (!state) return;
    operations.delete(id);
    state.controller.abort();
    wake(state.wakeWrite);
  };
  return { start, pull, cancel, cancelAll: () => { for (const id of operations.keys()) cancel(id); } };
}
