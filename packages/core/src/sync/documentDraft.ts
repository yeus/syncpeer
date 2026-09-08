import { sha256 } from "@noble/hashes/sha2.js";
import { encryptUntrustedFilename } from "../core/model/untrusted.js";
import type { BepVersionVector } from "../core/protocol/bep.js";
import { compareConcurrentVersionCounters } from "../core/protocol/versionVector.js";
import { equalHash } from "../transfer/blockReuse.js";
import { loadEncryptedDiskMetadata, readEncryptedDiskRange } from "./encryptedFilesystem.js";
import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import type { ReplicaByteStorage } from "./encryptedReplicaStorage.js";
import type { LocalFolderReplica, ReplicaEntry } from "./replicaIndex.js";
import { createReplicaFileSource } from "./replicaFileSource.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

type DraftStorage = ReplicaByteStorage & {
  listDirectory: (path: string) => Promise<ReplicaEntry[]>;
  copy: (source: string, target: string) => Promise<void>;
};
type DraftHead = { format: 1; path: string; baseSize: number; size: number; dirty: boolean; version: BepVersionVector | null; recover?: boolean };
type DraftOptions = {
  folderId: string; folderKey: Uint8Array; replica: LocalFolderReplica;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
};

async function readRecord(bytes: DraftStorage, name: string, key: Uint8Array) {
  const info = await bytes.stat(name);
  if (!info || info.type !== "file") throw new Error("Document draft record is missing.");
  return readEncryptedRecord({ size: info.size, readRange: (offset, size) => bytes.readRange(name, offset, size) }, key, name);
}

async function writeRecord(bytes: DraftStorage, name: string, data: Uint8Array, options: DraftOptions) {
  await writeEncryptedRecord({ name, bytes: data, folderKey: options.folderKey, randomBytes: options.randomBytes,
    createSink: (_info, size) => bytes.createSink(name, size) });
  await bytes.flushChanges([name]);
}

/** Ciphertext base snapshot plus atomic encrypted changed blocks. No eager plaintext copy.
 * Acknowledged writes survive process death; fsync/close publish one versioned file.
 * Only the document owner calls this object, with operations serialized by its queue.
 */
async function useDraft(bytes: DraftStorage, prefix: string, head: DraftHead, options: DraftOptions) {
  assertReplicaPath(head.path);
  if (head.format !== 1 || isInternalReplicaPath(head.path) || typeof head.dirty !== "boolean" ||
    ![head.baseSize, head.size].every(size => Number.isSafeInteger(size) && size >= 0)) throw new Error("Invalid document draft.");
  if (head.version !== null) compareConcurrentVersionCounters(head.version, {});
  const chunks = new Set((await bytes.listDirectory(prefix)).flatMap(entry => {
    const match = /^chunk-(\d+)$/.exec(entry.path.slice(prefix.length + 1));
    if (match && !Number.isSafeInteger(Number(match[1]))) throw new Error("Invalid document draft block.");
    return match && entry.type === "file" ? [Number(match[1])] : [];
  }));
  const encryptedName = await encryptUntrustedFilename(options.folderKey, head.path);
  const base = await bytes.stat(prefix + "/base");
  const source = base ? { size: base.size, readRange: (offset: number, size: number) => bytes.readRange(prefix + "/base", offset, size) } : null;
  const metadata = source ? await loadEncryptedDiskMetadata(source, encryptedName, options.folderKey) : null;
  if (head.baseSize && (!metadata || Number(metadata.fileInfo.size) !== head.baseSize)) {
    metadata?.fileKey.fill(0); throw new Error("Draft base is missing or changed.");
  }
  let closed = false;
  const ensureOpen = () => { if (closed) throw new Error("Document draft is closed."); };
  const saveHead = async () => {
    const data = new TextEncoder().encode(JSON.stringify(head));
    try { await writeRecord(bytes, prefix + "/head", data, options); } finally { data.fill(0); }
  };
  const chunk = async (index: number) => {
    if (chunks.has(index)) {
      const data = await readRecord(bytes, `${prefix}/chunk-${index}`, options.folderKey);
      if (data.length !== 131072) { data.fill(0); throw new Error("Invalid document draft block."); }
      return data;
    }
    const data = new Uint8Array(131072), offset = index * 131072;
    if (source && metadata && offset < head.baseSize) {
      const original = await readEncryptedDiskRange(source, metadata, offset, Math.min(data.length, head.baseSize - offset));
      try { data.set(original); } finally { original.fill(0); }
    }
    return data;
  };
  const readRange = async (offset: number, size: number) => {
    ensureOpen();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) throw new Error("Invalid document range.");
    const output = new Uint8Array(Math.max(0, Math.min(size, head.size - offset)));
    try {
      for (let done = 0; done < output.length;) {
        const position = offset + done, start = position % 131072, count = Math.min(output.length - done, 131072 - start);
        const data = await chunk(Math.floor(position / 131072));
        try { output.set(data.subarray(start, start + count), done); } finally { data.fill(0); }
        done += count;
      }
      return output;
    } catch (error) { output.fill(0); throw error; }
  };
  const digest = async () => {
    const hash = sha256.create();
    for (let offset = 0; offset < head.size; offset += 131072) {
      const data = await readRange(offset, Math.min(131072, head.size - offset));
      try { hash.update(data); } finally { data.fill(0); }
    }
    return hash.digest();
  };
  const matches = async (path: string) => {
    const current = (await options.replica.scan()).find(file => file.name === path && !file.deleted);
    if (!current || current.type === 1 || Number(current.size) !== head.size) return false;
    const source = await createReplicaFileSource(options.replica, path), hash = sha256.create();
    for (let offset = 0; offset < source.size; offset += 131072) {
      const data = await source.readRange(offset, Math.min(131072, source.size - offset));
      try { hash.update(data); } finally { data.fill(0); }
    }
    return equalHash(hash.digest(), await digest());
  };
  const flush = async (recover = false, modifiedMs?: number) => {
    ensureOpen(); if (!head.dirty) return;
    let target = head.path, version = head.version;
    if (recover) {
      const current = (await options.replica.scan()).find(file => file.name === target);
      const sameVersion = !current ? version === null : version !== null && compareConcurrentVersionCounters(current.version ?? {}, version) === 0;
      if (!sameVersion) {
        if (await matches(target)) { head = { ...head, version: current!.version ?? {}, dirty: false }; await saveHead(); return; }
        target = `${head.path}.sync-conflict-${prefix.slice(".syncpeer-draft-".length)}`;
        if (await matches(target)) { head = { ...head, dirty: false }; await saveHead(); return; }
        version = null;
      }
    }
    const result = await options.replica.edit!({ method: "write", folderId: options.folderId, path: target,
      expectedVersion: version, modifiedMs: modifiedMs ?? Date.now(), source: { size: head.size, readRange } });
    head = { ...head, version: result.version ?? {}, dirty: false };
    await saveHead();
  };
  const discard = async () => {
    closed = true; metadata?.fileKey.fill(0);
    // No recursive delete and no externally supplied path. Unexpected entries fail closed.
    for (const entry of await bytes.listDirectory(prefix)) {
      if (entry.type !== "file" || !/^(head|base|chunk-\d+)$/.test(entry.path.slice(prefix.length + 1))) throw new Error("Unexpected draft entry.");
      await bytes.remove(entry.path, false);
    }
    await bytes.remove(prefix, true);
  };
  return {
    path: head.path, size: async () => { ensureOpen(); return head.size; }, readRange, digest, flush, discard,
    write: async (offset: number, input: Uint8Array) => {
      ensureOpen();
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + input.length) || input.length > 131072) throw new Error("Invalid document write.");
      if (!input.length) return;
      if (!head.dirty) { head = { ...head, dirty: true }; await saveHead(); }
      for (let done = 0; done < input.length;) {
        const position = offset + done, index = Math.floor(position / 131072), start = position % 131072;
        const count = Math.min(input.length - done, 131072 - start), data = await chunk(index);
        try {
          data.set(input.subarray(done, done + count), start);
          await writeRecord(bytes, `${prefix}/chunk-${index}`, data, options); chunks.add(index);
        } finally { data.fill(0); }
        done += count;
      }
      head = { ...head, size: Math.max(head.size, offset + input.length) }; await saveHead();
    },
    close: async () => { closed = true; metadata?.fileKey.fill(0); if (!head.dirty) await discard(); },
  };
}

export async function openDocumentDraft(bytes: DraftStorage, options: DraftOptions & { path: string; truncate: boolean; recover?: boolean }) {
  assertReplicaPath(options.path);
  if (isInternalReplicaPath(options.path)) throw new Error("Private document.");
  const current = (await options.replica.scan()).find(file => file.name === options.path);
  if (current && !current.deleted && Number(current.type ?? 0) !== 0) throw new Error("Document is not a file.");
  const prefix = ".syncpeer-draft-" + [...await options.randomBytes(16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (await bytes.stat(prefix)) throw new Error("Draft already exists.");
  await bytes.makeDirectory(prefix);
  const baseSize = options.truncate || current?.deleted ? 0 : Number(current?.size ?? 0);
  if (baseSize) await bytes.copy(await encryptUntrustedFilename(options.folderKey, options.path), prefix + "/base");
  const head: DraftHead = { format: 1, path: options.path, baseSize, size: baseSize, dirty: options.truncate,
    version: current?.version ?? null, recover: options.recover ?? true };
  const data = new TextEncoder().encode(JSON.stringify(head));
  try { await writeRecord(bytes, prefix + "/head", data, options); } finally { data.fill(0); }
  return useDraft(bytes, prefix, head, options);
}

export async function recoverDocumentDrafts(bytes: DraftStorage, options: DraftOptions): Promise<string[]> {
  const issues: string[] = [];
  for (const root of await bytes.listDirectory("")) {
    if (root.type !== "directory" || !/^\.syncpeer-draft-[a-f0-9]{32}$/.test(root.path)) continue;
    try {
      const data = await readRecord(bytes, root.path + "/head", options.folderKey);
      let head: DraftHead;
      try { head = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); } finally { data.fill(0); }
      const draft = await useDraft(bytes, root.path, head, options);
      if (head.recover === false) { await draft.discard(); continue; }
      try { await draft.flush(true); } finally { await draft.close(); }
    } catch { issues.push("An encrypted edit needs recovery; its data has been retained."); }
  }
  return issues;
}
