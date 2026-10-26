import type { FileUploadOptions } from "../core/model/remoteFs.js";
import type { FileUploadSource } from "../transfer/stream.js";

type Upload = (folderId: string, path: string, source: FileUploadSource,
  options: FileUploadOptions) => Promise<void>;

export type ServiceUploadFrame =
  | { type: "need"; requestId: string; offset: number; size: number }
  | { type: "pending" }
  | { type: "done" }
  | { type: "error"; message: string };

const cancelledError = () => Object.assign(new Error("Upload cancelled."), { name: "AbortError" });

export const createServiceUploadBridge = (
  upload: Upload,
  settings: { chunkSize?: number } = {},
) => {
  const chunkSize = settings.chunkSize ?? 32 * 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 64 * 1024) {
    throw new Error("Invalid upload chunk size.");
  }
  type Pending = { offset: number; size: number; resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void };
  type State = { controller: AbortController; requests: Array<Extract<ServiceUploadFrame, { type: "need" }>>;
    pending: Map<string, Pending>; nextRequest: number;
    terminal: ServiceUploadFrame | null };
  const uploads = new Map<string, State>();
  let serial = 0;
  const start = (folderId: string, path: string, size: number, options: Omit<FileUploadOptions, "signal" | "onProgress"> = {}) => {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid upload size.");
    const id = String(++serial);
    const state: State = { controller: new AbortController(), requests: [], pending: new Map(),
      nextRequest: 0, terminal: null };
    uploads.set(id, state);
    const source: FileUploadSource = {
      size,
      read: async (offset, amount) => {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(amount) ||
          offset < 0 || amount < 0 || offset + amount > size) throw new Error("Invalid upload source range.");
        const bytes = new Uint8Array(amount);
        for (let start = 0; start < amount; start += chunkSize) {
          if (state.controller.signal.aborted) throw cancelledError();
          const requestedSize = Math.min(chunkSize, amount - start);
          const requestId = String(++state.nextRequest);
          const part = await new Promise<Uint8Array>((resolve, reject) => {
            state.pending.set(requestId, { offset: offset + start, size: requestedSize, resolve, reject });
            state.requests.push({ type: "need", requestId, offset: offset + start, size: requestedSize });
          });
          bytes.set(part, start);
        }
        return bytes;
      },
    };
    void Promise.resolve().then(() => upload(folderId, path, source, {
      ...options, signal: state.controller.signal,
    })).then(() => {
      state.terminal = { type: "done" };
    }, error => {
      state.terminal = { type: "error", message: error instanceof Error ? error.message : String(error) };
    });
    return id;
  };
  const poll = async (id: string): Promise<ServiceUploadFrame> => {
    const state = uploads.get(id);
    if (!state) throw new Error("Unknown service upload.");
    // Returning immediately is required: the WebView's uploadProvide command
    // shares this worker, so waiting here would delay every uploaded chunk.
    const request = state.requests.shift();
    if (request) return request;
    if (state.terminal) {
      uploads.delete(id);
      return state.terminal;
    }
    return { type: "pending" };
  };
  const provide = (id: string, requestId: string, bytes: Uint8Array) => {
    const state = uploads.get(id);
    const pending = state?.pending.get(requestId);
    if (!state || !pending) throw new Error("Unknown upload chunk request.");
    if (!(bytes instanceof Uint8Array) || bytes.length !== pending.size) {
      throw new Error("Upload chunk size or contents are invalid.");
    }
    state.pending.delete(requestId);
    pending.resolve(bytes.slice());
  };
  const cancel = (id: string) => {
    const state = uploads.get(id);
    if (!state) return;
    uploads.delete(id);
    state.controller.abort();
    for (const pending of state.pending.values()) pending.reject(cancelledError());
    state.pending.clear();
  };
  return { start, poll, provide, cancel,
    cancelAll: () => { for (const id of uploads.keys()) cancel(id); } };
};
