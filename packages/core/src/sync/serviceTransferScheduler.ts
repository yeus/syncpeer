/** One transfer writer at a time. Background runs cooperate at transaction
 * boundaries and replan on their next invocation instead of retaining stale
 * metadata across a manual transfer. */
export function createServiceTransferScheduler() {
  let tail = Promise.resolve();
  let manualPending = 0;
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const shouldYield = () => manualPending > 0;
  return {
    runManual: <T>(work: () => Promise<T>): Promise<T> => {
      manualPending++;
      return exclusive(work).finally(() => { manualPending--; });
    },
    runFavorite: <T>(work: (shouldYield: () => boolean) => Promise<T>): Promise<T> =>
      exclusive(() => work(shouldYield)),
  };
}
