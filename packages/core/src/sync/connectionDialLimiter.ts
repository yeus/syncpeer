/** FIFO semaphore for bounded network dial races. Grants transfer directly to
 * the next waiter; an aborted waiter is removed without consuming a permit. */
export const createAbortableConcurrencyLimit = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid concurrency limit.");
  let active = 0;
  const waiters = new Set<() => void>();
  const acquire = async (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("Connection attempt was cancelled.");
    if (active < limit) { active++; return; }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        if (!waiters.delete(grant)) return;
        signal?.removeEventListener("abort", abort);
        reject(new Error("Connection attempt was cancelled."));
      };
      waiters.add(grant);
      signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const release = () => {
    const next = waiters.values().next().value;
    if (next) {
      waiters.delete(next);
      next(); // Transfer the occupied slot; do not decrement active.
    } else active--;
  };
  const run = async <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    await acquire(signal);
    try {
      if (signal?.aborted) throw new Error("Connection attempt was cancelled.");
      return await task();
    } finally { release(); }
  };
  return { run };
};
