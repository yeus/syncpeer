/** The Android DocumentsProvider may bind before its runtime finishes starting. */
export async function readInitialVaultStatus<T>(
  read: () => Promise<T>,
  pause: (milliseconds: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await read(); }
    catch (error) {
      if (attempt === 3) throw error;
      await pause(250 * (attempt + 1));
    }
  }
  throw new Error("Initial document vault status is unavailable.");
}
