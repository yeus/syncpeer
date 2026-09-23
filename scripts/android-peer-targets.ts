/** Stable, injective mapping for validated emulator console ports. */
export function androidPeerCdpPort(serial: string): number {
  const match = /^emulator-(\d+)$/.exec(serial);
  const port = match ? Number(match[1]) + 10_000 : NaN;
  if (!Number.isSafeInteger(port) || port <= 10_000 || port > 65_535) {
    throw new Error("Expected an emulator serial with a valid debugging-port mapping.");
  }
  return port;
}

export function androidPeerTargets(online: string[], configured: string | undefined,
  allowReset: boolean, isEmulator: (serial: string) => boolean): string[] {
  if (!allowReset) {
    throw new Error("This test deletes app data. Set SYNCPEER_ANDROID_RESET_EMULATORS=1 only for disposable emulators.");
  }
  const serials = configured?.trim()
    ? configured.split(",").map(value => value.trim())
    : online.filter(serial => /^emulator-\d+$/.test(serial));
  if (serials.length !== 2 || new Set(serials).size !== 2) {
    throw new Error("Expected two distinct disposable Android emulators.");
  }
  for (const serial of serials) {
    androidPeerCdpPort(serial);
    if (!online.includes(serial)) throw new Error("Selected emulator is not online.");
    if (!isEmulator(serial)) throw new Error("Selected device is not a verified Android emulator.");
  }
  return serials;
}
