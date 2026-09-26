/** Stable, injective mapping for validated emulator console ports. */
export function androidPeerCdpPort(serial: string): number {
  const match = /^emulator-(\d+)$/.exec(serial);
  const port = match ? Number(match[1]) + 10_000 : NaN;
  if (!Number.isSafeInteger(port) || port <= 10_000 || port > 65_535) {
    throw new Error("Expected an emulator serial with a valid debugging-port mapping.");
  }
  return port;
}

const androidListeningPorts = (procNetTcp: string, appUid: number): number[] =>
  procNetTcp.split("\n").slice(1).map(line => line.trim().split(/\s+/))
    .filter(fields => fields[3] === "0A" && Number(fields[7]) === appUid)
    .map(fields => Number.parseInt(fields[1]?.split(":").at(-1) ?? "", 16))
    .filter(port => Number.isInteger(port) && port > 0 && port <= 65_535);

export const androidAppListeningOnPort = (procNetTcp: string, appUid: number, port: number): boolean =>
  androidListeningPorts(procNetTcp, appUid).includes(port);

/** Resolve the temporary pairing listener from a disposable emulator's synthetic /proc/net/tcp snapshot. */
export function androidSingleListeningPort(procNetTcp: string, appUid: number): number {
  const ports = androidListeningPorts(procNetTcp, appUid);
  if (ports.length !== 1) throw new Error("Expected one app-owned pairing listener on the disposable emulator.");
  return ports[0]!;
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
