import type { BepFileInfo } from "../core/protocol/bep.js";
import { RemoteFs } from "../core/model/remoteFs.js";
import type { FileDownloadSink } from "../transfer/stream.js";
import { planReplicaMerge } from "./replicaMerge.js";
import type { ReplicaBlockReader, ReplicaIndex, ReplicaSource } from "./replicaIndex.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

export interface ReplicaDestination extends ReplicaSource {
  createSink: (file: BepFileInfo) => Promise<FileDownloadSink>;
  archive: (path: string) => Promise<void>;
  makeDirectory: (path: string) => Promise<void>;
  remove: (path: string, directory: boolean) => Promise<void>;
  saveIndex: (index: ReplicaIndex) => Promise<void>;
  /** Flush changed bytes and namespace entries before publishing the completed version. */
  flushChanges: (paths: readonly string[]) => Promise<void>;
}

const normalizeInfo = (file: BepFileInfo): BepFileInfo => {
  assertReplicaPath(file.name);
  if (isInternalReplicaPath(file.name)) throw new Error("Internal replica path in remote update.");
  const type = Number(file.type ?? 0);
  const size = Number(file.size ?? 0);
  if ((type !== 0 && type !== 1) || !Number.isSafeInteger(size) || size < 0) throw new Error("Unsupported replica entry.");
  return { name: file.name, type, size, deleted: !!file.deleted, invalid: !!file.invalid,
    permissions: file.permissions, no_permissions: file.no_permissions,
    modified_by: file.modified_by, block_size: Number(file.block_size ?? 0),
    modified_s: Number(file.modified_s ?? 0), modified_ns: Number(file.modified_ns ?? 0),
    version: { counters: file.version?.counters?.map(counter => ({ id: String(counter.id), value: String(counter.value) })) ?? [] },
    blocks: (file.blocks ?? []).map(block => ({ offset: Number(block.offset), size: Number(block.size), hash: block.hash })),
  };
};

export async function receiveReplicaFiles(
  folderId: string,
  previous: ReplicaIndex,
  remoteFiles: BepFileInfo[],
  storage: ReplicaDestination,
  request: ReplicaBlockReader,
  hash: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<boolean> {
  const index: ReplicaIndex = { ...previous, files: Object.assign(Object.create(null), previous.files) };
  let changed = false;
  const install = async (info: BepFileInfo, sourceInfo: BepFileInfo, source: "local" | "remote") => {
    const old = index.files[info.name];
    const checkLocal = async () => {
      const entry = (await storage.listEntries()).find(entry => entry.path === info.name);
      if (entry?.revision !== (old?.info.deleted ? undefined : old?.revision)) throw new Error("Local replica changed during receive.");
    };
    await checkLocal();
    if (info.deleted) {
      index.pending = info;
      await storage.saveIndex(index);
      if (old && !old.info.deleted) {
        if (old.info.type !== 1) await storage.archive(info.name);
        await checkLocal();
        await storage.remove(info.name, old.info.type === 1);
      }
    } else if (info.type === 1) {
      index.pending = info;
      await storage.saveIndex(index);
      await storage.makeDirectory(info.name);
    } else {
      const sink = await storage.createSink(info);
      const view = new RemoteFs(new Map([[folderId, { id: folderId, label: folderId, readOnly: false,
        advertisedDevices: [], encrypted: false, needsPassword: false, indexReceived: true,
        files: new Map([[info.name, { indexFile: info }]]),
      }]]), (_folder, _name, offset, size, options) => source === "remote"
        ? request(sourceInfo.name, offset, size, options?.hash) : storage.readRange(sourceInfo.name, offset, size),
      async () => {}, () => {}, undefined, undefined, undefined, undefined, hash);
      try {
        await view.readFileToSink(folderId, info.name, { ...sink, commit: async () => {
          await checkLocal();
          if (old && !old.info.deleted) await storage.archive(info.name);
          await checkLocal();
          index.pending = info;
          await storage.saveIndex(index);
          await checkLocal();
          await sink.commit();
        } });
      } catch (error) { await sink.abort(error); throw error; }
    }
    await storage.flushChanges([info.name]);
    const entry = (await storage.listEntries()).find(entry => entry.path === info.name);
    index.files[info.name] = { revision: entry?.revision ?? "deleted", info: { ...info, sequence: ++index.sequence } };
    delete index.pending;
    await storage.saveIndex(index);
    changed = true;
  };
  const files = remoteFiles.map(normalizeInfo).sort((a, b) => {
    if (!!a.deleted !== !!b.deleted) return a.deleted ? 1 : -1;
    return a.deleted ? b.name.length - a.name.length : a.name.length - b.name.length;
  });
  for (const remote of files) {
    const local = index.files[remote.name]?.info;
    const plan = planReplicaMerge(local, remote);
    if (plan.action === "keep") continue;
    if (plan.conflict) {
      if (plan.conflict.type === 1) throw new Error("Directory conflict requires resolution.");
      const loser = plan.source === "local" ? remote : local!;
      const existing = index.files[plan.conflict.name]?.info;
      if (!existing || planReplicaMerge(existing, plan.conflict).action !== "keep") {
        await install(plan.conflict, loser, plan.source === "local" ? "remote" : "local");
      }
    }
    if (plan.source === "local") {
      index.files[remote.name] = { ...index.files[remote.name], info: { ...plan.winner, sequence: ++index.sequence } };
      await storage.saveIndex(index);
      changed = true;
    } else await install(plan.winner, remote, "remote");
  }
  return changed;
}
