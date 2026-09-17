export interface OwnedSpaceDevice {
  /** Stable Syncpeer slot; a certificate replacement changes only syncthingId. */
  id: string;
  syncthingId: string;
  state: "active" | "revoked";
  retiredSyncthingIds?: string[];
  /** SPKI-encoded key used to authorize subsequent roster changes. */
  signingKey?: string;
}

export interface OwnedRosterUpdate {
  format: 1;
  sequence: number;
  previous: string | null;
  signer: string;
  recoveryKey?: string;
  devices: OwnedSpaceDevice[];
  signature: string;
  hash: string;
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

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const unsignedUpdate = (value: Pick<OwnedRosterUpdate, "sequence" | "previous" | "signer" | "devices" | "recoveryKey">) =>
  ({ format: 1 as const, sequence: value.sequence, previous: value.previous, signer: value.signer,
    ...(value.recoveryKey ? { recoveryKey: value.recoveryKey } : {}), devices: value.devices });
const updateBytes = (value: ReturnType<typeof unsignedUpdate>) =>
  new TextEncoder().encode(`syncpeer.owned-roster.v1\n${JSON.stringify(value)}`);

/** A full roster snapshot signed by the device authorized in the preceding snapshot. */
export async function signOwnedRosterUpdate(subtle: SubtleCrypto, key: CryptoKey,
  value: Pick<OwnedRosterUpdate, "sequence" | "previous" | "signer" | "devices" | "recoveryKey">): Promise<OwnedRosterUpdate> {
  validateRoster(value.devices);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !value.signer ||
    (value.sequence === 1) !== (value.previous === null)) throw new Error("Invalid owned roster sequence.");
  const unsigned = unsignedUpdate(value);
  const bytes = updateBytes(unsigned);
  const signature = encode(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes)));
  const hash = encode(new Uint8Array(await subtle.digest("SHA-256", bytes)));
  return { ...unsigned, signature, hash };
}

/** Pin the genesis key locally; old snapshots cannot replace a previously accepted head. */
export async function verifyOwnedRoster(subtle: SubtleCrypto, updates: readonly OwnedRosterUpdate[],
  genesisKey: string, knownHead?: string): Promise<{ devices: OwnedSpaceDevice[]; hash: string }> {
  if (!updates.length || updates.length > 10000) throw new Error("Invalid owned roster history.");
  let recoveryKey: string | undefined;
  let previous: string | null = null;
  let devices: OwnedSpaceDevice[] = [];
  let knownHeadSeen = false;
  for (const [index, update] of updates.entries()) {
    if (update.format !== 1 || update.sequence !== index + 1 || update.previous !== previous ||
      typeof update.signer !== "string" || !update.signer) throw new Error("Invalid owned roster ancestry.");
    validateRoster(update.devices);
    if (index === 0) recoveryKey = update.recoveryKey;
    else if (update.recoveryKey !== recoveryKey) throw new Error("Owned roster recovery authority changed.");
    const signer = index === 0 ? update.devices.find(device => device.id === update.signer) :
      devices.find(device => device.id === update.signer && device.state === "active");
    let trusted: string;
    if (update.signer === "recovery" && index > 0 && recoveryKey) trusted = recoveryKey;
    else if (!signer?.signingKey || (index === 0 && signer.signingKey !== genesisKey)) {
      throw new Error("Owned roster signer is not authorized.");
    } else trusted = signer.signingKey;
    const bytes = updateBytes(unsignedUpdate(update));
    const hash = encode(new Uint8Array(await subtle.digest("SHA-256", bytes)));
    if (hash !== update.hash) throw new Error("Owned roster hash mismatch.");
    let valid = false;
    try {
      const key = await subtle.importKey("spki", decode(trusted), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      valid = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(update.signature), bytes);
    } catch { /* Invalid key or signature is untrusted input. */ }
    if (!valid) throw new Error("Owned roster signature is invalid.");
    knownHeadSeen ||= hash === knownHead;
    previous = hash;
    devices = update.devices;
  }
  if (knownHead && !knownHeadSeen) throw new Error("Owned roster rollback or fork detected.");
  return { devices, hash: previous! };
}

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
