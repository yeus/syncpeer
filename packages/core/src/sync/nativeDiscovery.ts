import type { SyncpeerDiscoveryFetchInit, SyncpeerHostAdapter } from "../client.js";

export type NativeDiscoveryRequest = { operation: "discoveryPrepare" } |
  { operation: "discoveryCancel"; requestId: number } |
  ({ operation: "discoveryFetch"; requestId: number; url: string } & Omit<SyncpeerDiscoveryFetchInit, "signal">);

/** Prepare cancellation before starting native I/O so an early abort cannot miss the request. */
export const createNativeDiscoveryFetch = (request: (input: NativeDiscoveryRequest) => Promise<unknown>):
  SyncpeerHostAdapter["discoveryFetch"] => async (input, init) => {
  const { signal, ...options } = init ?? {};
  const cancelled = Object.assign(new Error("Discovery request cancelled."), { name: "AbortError" });
  if (signal?.aborted) throw cancelled;
  const requestId = await request({ operation: "discoveryPrepare" }) as number;
  let rejectAbort!: (error: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    void request({ operation: "discoveryCancel", requestId }).then(
      () => rejectAbort(cancelled), rejectAbort);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const response = await Promise.race([request({ ...options, operation: "discoveryFetch", requestId, url: String(input),
      method: options.method ?? "GET", headers: options.headers ?? {} }), aborted]) as {
      status: number; body: string; headers: Record<string, string>;
    };
    if (signal?.aborted) throw cancelled;
    return { ok: response.status >= 200 && response.status < 300, status: response.status, headers: response.headers,
      text: async () => response.body, json: async () => JSON.parse(response.body) };
  } finally { signal?.removeEventListener("abort", abort); }
};
