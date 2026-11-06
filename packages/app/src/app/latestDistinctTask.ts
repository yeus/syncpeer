/** Coalesce repeated state snapshots while one expensive IPC task is running.
 * Only the latest distinct request is retained; a successful key is cached
 * until a different request completes. Failed work remains retryable.
 */
export const createLatestDistinctTask = <T, R>(options: {
  keyOf: (input: T) => string;
  run: (input: T) => Promise<R>;
  onSuccess: (result: R) => void;
  onError: (error: unknown, input: T) => void;
}) => {
  let lastSuccess: string | null = null;
  let active: string | null = null;
  let queued: { key: string; input: T } | null = null;
  let running = false;

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (queued) {
        const current = queued;
        queued = null;
        if (current.key === lastSuccess) continue;
        active = current.key;
        try {
          const result = await options.run(current.input);
          lastSuccess = current.key;
          if (!queued) options.onSuccess(result);
        } catch (error) {
          if (!queued) options.onError(error, current.input);
        } finally {
          active = null;
        }
      }
    } finally {
      running = false;
    }
  };

  return (input: T) => {
    const key = options.keyOf(input);
    if (key === queued?.key) return;
    if (key === active) { queued = null; return; }
    if (!running && key === lastSuccess) return;
    queued = { key, input };
    void drain();
  };
};
