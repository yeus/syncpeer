/** Abortable discovery fetches may still fail to settle on an unhealthy native
 * network stack. A timeout is a rejected candidate source, not a peer dial
 * failure: LAN and global discovery must not starve each other. */
export const settleDiscoveryWithin = async <T>(
  work: Promise<T>,
  durationMs: number,
  description: string,
): Promise<PromiseSettledResult<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<PromiseSettledResult<T>>([
      work.then(value => ({ status: "fulfilled" as const, value }),
        reason => ({ status: "rejected" as const, reason })),
      new Promise<PromiseRejectedResult>(resolve => {
        timer = setTimeout(() => resolve({
          status: "rejected",
          reason: new Error(`${description} exceeded ${durationMs} ms.`),
        }), durationMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
