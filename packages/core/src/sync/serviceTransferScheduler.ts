/** One transfer writer at a time. Background runs cooperate at transaction
 * boundaries and replan on their next invocation instead of retaining stale
 * metadata across a manual transfer. */
export function createServiceTransferScheduler() {
  let tail = Promise.resolve();
  let interactivePending = 0;
  let interactiveRevision = 0;
  let manualPending = 0;
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const shouldYield = (revision: number) => manualPending > 0 || interactivePending > 0 || interactiveRevision !== revision;
  return {
    runManual: <T>(work: () => Promise<T>): Promise<T> => {
      manualPending++;
      return exclusive(work).finally(() => { manualPending--; });
    },
    // Metadata reads are independent of transfer writes. Do not enqueue them
    // behind a full favorite run. The revision latches even brief UI requests.
    runInteractive: async <T>(work: () => Promise<T>): Promise<T> => {
      interactiveRevision++;
      interactivePending++;
      try { return await work(); }
      finally { interactivePending--; }
    },
    runFavorite: <T>(work: (shouldYield: () => boolean) => Promise<T>): Promise<T> =>
      exclusive(() => {
        const revision = interactiveRevision;
        return work(() => shouldYield(revision));
      }),
  };
}
