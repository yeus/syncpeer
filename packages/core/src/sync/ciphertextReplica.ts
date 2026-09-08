import type { BepFileInfo } from "../core/protocol/bep.js";
import { createCiphertextIndex, prepareCiphertextUpdate, completeCiphertextUpdate, loadCiphertextIndex,
  saveCiphertextIndex, type CiphertextIndex, type CiphertextFolderIdentity } from "./ciphertextIndex.js";
import { loadCiphertextDiskMetadata, readCiphertextBlock, receiveCiphertextFile } from "./ciphertextFilesystem.js";
import type { ReplicaByteStorage } from "./encryptedReplicaStorage.js";
import type { ReplicaStorage } from "./replicaStorage.js";
import { equalBytes } from "@noble/ciphers/utils.js";

/** Dedicated keyless root. Retain immutable generations until authenticated reconciliation. */
export function createCiphertextReplica(bytes: ReplicaByteStorage, options: {
  identity: CiphertextFolderIdentity;
  withLock: ReplicaStorage["withLock"];
  checkHealth: () => Promise<void>;
}) {
  const identity = createCiphertextIndex(options.identity).identity;
  const indexPath = ".syncpeer-ciphertext-index";
  const generationPath = (id: string) => `.syncpeer-ciphertext-generations/${id}`;
  const load = async () => {
    await options.checkHealth();
    const stat = await bytes.stat(indexPath);
    if (!stat) {
      const entries = await bytes.listEntries();
      if (await bytes.stat(".syncpeer-ciphertext-generations") || await bytes.stat(".syncpeer-replica-index") ||
        entries.some(entry => ![".syncpeer-folder-marker", ".syncpeer-replica.lock"].includes(entry.path))) {
        throw new Error("Encrypted history is missing; explicit import or recovery is required.");
      }
      return createCiphertextIndex(identity);
    }
    if (stat.type !== "file") throw new Error("Invalid encrypted history storage.");
    const index = await loadCiphertextIndex({ size: stat.size,
      readRange: (offset, size) => bytes.readRange(indexPath, offset, size) }, identity);
    const after = await bytes.stat(indexPath);
    if (!after || after.revision !== stat.revision || after.size !== stat.size) throw new Error("Encrypted history changed during read.");
    return index;
  };
  const save = async (index: CiphertextIndex) => {
    await options.checkHealth();
    await saveCiphertextIndex(index, async size => {
      const sink = await bytes.createSink(indexPath, size);
      return { ...sink, commit: async () => { await options.checkHealth(); await sink.commit(); } };
    });
    await bytes.flushChanges([indexPath]);
  };
  const generation = async (id: string, info: BepFileInfo) => {
    const path = generationPath(id);
    const stat = await bytes.stat(path);
    if (!stat || stat.type !== "file") throw new Error("Encrypted generation unavailable.");
    const source = { size: stat.size, readRange: (offset: number, size: number) => bytes.readRange(path, offset, size) };
    const metadata = await loadCiphertextDiskMetadata(source, info.name);
    const parsed = prepareCiphertextUpdate(createCiphertextIndex(identity), identity, metadata.encrypted);
    if (parsed.pending?.id !== id) throw new Error("Encrypted generation does not match journal.");
    return { source, metadata, stat, path };
  };
  const receive = async (remote: CiphertextFolderIdentity, info: BepFileInfo,
    requestBlock: Parameters<typeof receiveCiphertextFile>[0]["requestBlock"], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const previous = await load();
    const prepared = prepareCiphertextUpdate({ ...previous, pending: undefined }, remote, info);
    if (previous.pending && prepared.pending?.id !== previous.pending.id) throw new Error("Encrypted update is pending recovery.");
    if (!prepared.pending) return previous;
    await save(prepared); // Pin identity and journal before any content becomes visible.
    const { id, info: descriptor } = prepared.pending;
    let revision = "metadata-only";
    if (!descriptor.deleted && !descriptor.invalid && Number(descriptor.type ?? 0) === 0) {
      const path = generationPath(id);
      if (!await bytes.stat(path)) await receiveCiphertextFile({ encrypted: descriptor, requestBlock, signal,
        createSink: async (_info, size) => {
          const sink = await bytes.createSink(path, size);
          return { ...sink, commit: async () => { await options.checkHealth(); await sink.commit(); } };
        } });
      const stored = await generation(id, descriptor);
      await bytes.flushChanges([path]);
      revision = stored.stat.revision;
    }
    signal?.throwIfAborted();
    const committed = completeCiphertextUpdate(prepared, id, revision);
    await save(committed);
    return committed;
  };
  // No receive lock while serving: two peers can each be receiving from the other.
  const readBlock = async (id: string, offset: number, size: number, token: Uint8Array, signal?: AbortSignal) => {
      const index = await load();
      const entry = Object.hasOwn(index.versions, id) ? index.versions[id] : undefined;
      if (!entry || entry.info.deleted || entry.info.invalid || Number(entry.info.type ?? 0) !== 0) {
        throw new Error("Encrypted generation is not published.");
      }
      const stored = await generation(id, entry.info);
      if (stored.stat.revision !== entry.revision) throw new Error("Encrypted generation changed since publication.");
      const data = await readCiphertextBlock(stored.source, stored.metadata, offset, size, token, signal);
      const after = await bytes.stat(stored.path);
      if (!after || after.revision !== stored.stat.revision || after.size !== stored.stat.size) {
        throw new Error("Encrypted generation changed during read.");
      }
      await options.checkHealth();
      return data;
  };
  return {
    snapshot: () => options.withLock(load),
    openGeneration: async (id: string) => {
      const index = await load();
      const entry = Object.hasOwn(index.versions, id) ? index.versions[id] : undefined;
      if (!entry || entry.info.deleted || entry.info.invalid || Number(entry.info.type ?? 0) !== 0) {
        throw new Error("Encrypted generation is not published.");
      }
      const stored = await generation(id, entry.info);
      if (stored.stat.revision !== entry.revision) throw new Error("Encrypted generation changed since publication.");
      return { size: stored.stat.size, readRange: async (offset: number, size: number) => {
        await options.checkHealth();
        const before = await bytes.stat(stored.path);
        if (before?.revision !== entry.revision) throw new Error("Encrypted generation changed before read.");
        const data = await stored.source.readRange(offset, size);
        const after = await bytes.stat(stored.path);
        if (after?.revision !== entry.revision) throw new Error("Encrypted generation changed during read.");
        await options.checkHealth();
        return data;
      } };
    },
    receive: (remote: CiphertextFolderIdentity, info: BepFileInfo,
      request: Parameters<typeof receiveCiphertextFile>[0]["requestBlock"], signal?: AbortSignal) =>
      options.withLock(() => receive(remote, info, request, signal)),
    readBlock,
    readNamedBlock: async (name: string, offset: number, size: number, token: Uint8Array, signal?: AbortSignal) => {
      const index = await load();
      const match = Object.entries(index.versions).find(([, entry]) => entry.info.name === name && !entry.info.deleted &&
        !entry.info.invalid && entry.info.blocks?.some(block => Number(block.offset) === offset && block.size === size &&
          equalBytes(block.hash, token)));
      if (!match) throw new Error("Ciphertext block is not published.");
      return readBlock(match[0], offset, size, token, signal);
    },
  };
}
