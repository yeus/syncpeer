import type { LocalFolderReplica } from "./replicaIndex.js";
import { resolvePersonalSpaceChanges, type PersonalSpaceChange } from "./personalSpaceChanges.js";

const MAX_CHANGE_BYTES = 1024 * 1024;
const safeId = (value: string, label: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
};
const changePath = (change: Pick<PersonalSpaceChange, "deviceId" | "id">) =>
  `changes/${safeId(change.deviceId, "settings device identity")}--${safeId(change.id, "settings change identity")}.json`;

const readChange = async (replica: LocalFolderReplica,
  file: Awaited<ReturnType<LocalFolderReplica["scan"]>>[number]): Promise<PersonalSpaceChange> => {
  const size = Number(file.size ?? 0);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CHANGE_BYTES) {
    throw new Error("Invalid personal-space change file size.");
  }
  const bytes = new Uint8Array(size);
  for (const block of file.blocks ?? []) {
    const offset = Number(block.offset), length = Number(block.size);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset + length > size) throw new Error("Invalid personal-space change blocks.");
    bytes.set(await replica.readBlock(file.name, offset, length, block.hash), offset);
  }
  let change: unknown;
  try { change = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Invalid personal-space change file."); }
  const value = change as PersonalSpaceChange;
  if (!value || changePath(value) !== file.name) throw new Error("Personal-space change path mismatch.");
  return value;
};

export function createPersonalSpaceSettingsJournal(replica: LocalFolderReplica, folderId: string) {
  if (!replica.edit || !folderId) throw new Error("Personal-space settings replica is not writable.");
  const load = async (): Promise<PersonalSpaceChange[]> => {
    const files = (await replica.scan()).filter(file => !file.deleted && !file.invalid && file.type === 0 &&
      file.name.startsWith("changes/"));
    if (files.length > 10000) throw new Error("Personal-space change capacity exceeded.");
    const changes = await Promise.all(files.sort((left, right) => left.name < right.name ? -1 : 1)
      .map(file => readChange(replica, file)));
    resolvePersonalSpaceChanges(changes);
    return changes;
  };
  const append = async (change: PersonalSpaceChange): Promise<void> => {
    const existing = await load();
    resolvePersonalSpaceChanges([...existing, change]);
    const path = changePath(change), current = await replica.scan();
    if (current.some(file => file.name === path)) throw new Error("Personal-space change already exists.");
    const bytes = new TextEncoder().encode(JSON.stringify(change));
    if (bytes.length > MAX_CHANGE_BYTES) throw new Error("Personal-space setting value is too large.");
    const directory = current.find(file => file.name === "changes");
    if (!directory || directory.deleted) await replica.edit!({ method: "mkdir", folderId, path: "changes",
      expectedVersion: directory?.version ?? null, modifiedMs: Date.now() });
    await replica.edit!({ method: "write", folderId, path, expectedVersion: null, modifiedMs: Date.now(),
      source: { size: bytes.length, readRange: async (offset, size) => bytes.slice(offset, offset + size) } });
  };
  return { load, append, resolve: async () => resolvePersonalSpaceChanges(await load()) };
}
