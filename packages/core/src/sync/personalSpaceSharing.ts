export interface OwnedSpaceDevice {
  /** Stable Syncpeer slot; a certificate replacement changes only syncthingId. */
  id: string;
  syncthingId: string;
  state: "active" | "revoked";
  retiredSyncthingIds?: string[];
}

export type FolderShareTarget = { kind: "personal-space" } | { kind: "device"; syncthingId: string };

const validateRoster = (devices: readonly OwnedSpaceDevice[]) => {
  const slots = new Set<string>(), identities = new Set<string>();
  for (const device of devices) {
    if (!device.id || !device.syncthingId || !["active", "revoked"].includes(device.state) ||
      slots.has(device.id) || !Array.isArray(device.retiredSyncthingIds ?? [])) {
      throw new Error("Invalid personal-space device roster.");
    }
    slots.add(device.id);
    for (const identity of [device.syncthingId, ...(device.retiredSyncthingIds ?? [])]) {
      if (!identity || identities.has(identity)) throw new Error("Invalid personal-space device roster.");
      identities.add(identity);
    }
  }
};

export function settingsFolderDevices(devices: readonly OwnedSpaceDevice[]): string[] {
  validateRoster(devices);
  return devices.filter(device => device.state === "active").map(device => device.syncthingId).sort();
}

/** Resolve policy at the Syncpeer boundary; BEP still sees ordinary device IDs. */
export function resolveFolderShareDevices(targets: readonly FolderShareTarget[],
  devices: readonly OwnedSpaceDevice[]): string[] {
  validateRoster(devices);
  const revoked = new Set(devices.flatMap(device => [
    ...(device.state === "revoked" ? [device.syncthingId] : []), ...(device.retiredSyncthingIds ?? [])]));
  const selected = new Set<string>();
  for (const target of targets) {
    if (target.kind === "personal-space") {
      for (const device of devices) if (device.state === "active") selected.add(device.syncthingId);
    } else if (target.kind === "device" && target.syncthingId) {
      if (!revoked.has(target.syncthingId)) selected.add(target.syncthingId);
    } else throw new Error("Invalid folder sharing target.");
  }
  return [...selected].sort();
}
