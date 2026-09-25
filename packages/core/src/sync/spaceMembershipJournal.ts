import type { LocalFolderReplica } from "./replicaIndex.js";
import type { SpaceMembershipUpdate } from "./personalSpaceSharing.js";

const MAX_UPDATE_BYTES = 256 * 1024;
// Keep the established encrypted journal path for existing paired devices.
const updatePath = (sequence: number) => `roster/${sequence.toString().padStart(10, "0")}.json`;
const mayPublish = (update: SpaceMembershipUpdate, previous: SpaceMembershipUpdate | undefined,
  localDeviceId: string | null) => !!localDeviceId && (update.signer === localDeviceId ||
    update.signer === "recovery" && !!previous &&
      !previous.devices.some(device => device.id === localDeviceId) &&
      update.devices.some(device => device.id === localDeviceId));

const readUpdate = async (replica: LocalFolderReplica,
  file: Awaited<ReturnType<LocalFolderReplica["scan"]>>[number]): Promise<SpaceMembershipUpdate> => {
  const size = Number(file.size ?? 0);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPDATE_BYTES) {
    throw new Error("Invalid trusted device list update size.");
  }
  const bytes = new Uint8Array(size);
  for (const block of file.blocks ?? []) {
    const offset = Number(block.offset), length = Number(block.size);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset + length > size) throw new Error("Invalid trusted device list update blocks.");
    bytes.set(await replica.readBlock(file.name, offset, length, block.hash), offset);
  }
  let update: unknown;
  try { update = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Invalid trusted device list update."); }
  const value = update as SpaceMembershipUpdate;
  if (!value || !Number.isSafeInteger(value.sequence) || updatePath(value.sequence) !== file.name) {
    throw new Error("Trusted device list update path mismatch.");
  }
  return value;
};

export function createSpaceMembershipJournal(replica: LocalFolderReplica, folderId: string) {
  if (!replica.edit || !folderId) throw new Error("Personal-space settings replica is not writable.");
  const load = async () => {
    const files = (await replica.scan()).filter(file => !file.deleted && !file.invalid && file.type === 0 &&
      file.name.startsWith("roster/"));
    if (files.length > 10000) throw new Error("Trusted device list capacity exceeded.");
    return Promise.all(files.sort((left, right) => left.name < right.name ? -1 : 1)
      .map(file => readUpdate(replica, file)));
  };
  const appendMissing = async (updates: readonly SpaceMembershipUpdate[], localDeviceId: string | null) => {
    const existing = await load();
    for (let index = 0; index < Math.min(existing.length, updates.length); index++) {
      if (existing[index].hash !== updates[index].hash) throw new Error("Trusted device list fork detected.");
    }
    if (existing.length > updates.length) return existing;
    let end = existing.length;
    while (end < updates.length && mayPublish(updates[end], updates[end - 1], localDeviceId)) end++;
    if (end === existing.length) return existing;
    let current = await replica.scan();
    const directory = current.find(file => file.name === "roster");
    if (!directory || directory.deleted) await replica.edit!({ method: "mkdir", folderId, path: "roster",
      expectedVersion: directory?.version ?? null, modifiedMs: Date.now() });
    for (const update of updates.slice(existing.length, end)) {
      const bytes = new TextEncoder().encode(JSON.stringify(update));
      if (bytes.length > MAX_UPDATE_BYTES) throw new Error("Trusted device list update is too large.");
      const path = updatePath(update.sequence);
      current = await replica.scan();
      if (current.some(file => file.name === path && !file.deleted)) throw new Error("Trusted device list update already exists.");
      await replica.edit!({ method: "write", folderId, path, expectedVersion: null, modifiedMs: Date.now(),
        source: { size: bytes.length, readRange: async (offset, size) => bytes.slice(offset, offset + size) } });
    }
    return updates.slice(0, end);
  };
  return { load, appendMissing };
}
