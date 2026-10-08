import { sha256 } from "@noble/hashes/sha2.js";
import { encryptUntrustedFilename } from "../core/model/untrusted.js";
import type { BepVersionVector } from "../core/protocol/bep.js";
import { compareConcurrentVersionCounters } from "../core/protocol/versionVector.js";
import { equalHash, validateBlockPlan, type RangeDigest } from "../transfer/blockReuse.js";
import { sameDownloadMetadata, type FileDownloadMetadata } from "../transfer/stream.js";
import { loadEncryptedDiskMetadata, readEncryptedDiskRange } from "./encryptedFilesystem.js";
import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import type { ReplicaByteStorage } from "./encryptedReplicaStorage.js";
import { hasReplicaBlockLayout, type LocalFolderReplica, type ReplicaEntry } from "./replicaIndex.js";
import { createReplicaFileSource } from "./replicaFileSource.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

const LEGACY_DRAFT_CHUNK_SIZE = 128 * 1024;
const DRAFT_CHUNK_SIZE = 1024 * 1024;
const MAX_DRAFT_RECORD_BATCH_FILES = 8;
const MAX_DRAFT_RECORD_BATCH_BYTES = 2 * 1024 * 1024;
type DraftStorage = ReplicaByteStorage & {
  listDirectory: (path: string) => Promise<ReplicaEntry[]>;
  copy: (source: string, target: string) => Promise<void>;
};
type DownloadDraft = Omit<FileDownloadMetadata, "blocks"> & {
  modifiedMs: number;
  ranges: Array<{ offset: number; end: number }>;
};
type DownloadDraftInput = Omit<DownloadDraft, "ranges"> & { blocks?: readonly RangeDigest[] };
type DraftHead = { format: 1; path: string; baseSize: number; size: number; dirty: boolean;
  version: BepVersionVector | null; chunkSize?: number; recover?: boolean; download?: DownloadDraft };
type DraftOptions = {
  folderId: string; folderKey: Uint8Array; replica: LocalFolderReplica;
  randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
};
const decodeRecord = async (encoded: Uint8Array, key: Uint8Array, name: string) =>
  readEncryptedRecord({ size: encoded.length,
    readRange: async (offset, size) => encoded.slice(offset, offset + size) }, key, name);

async function readRecord(bytes: DraftStorage, name: string, key: Uint8Array) {
  if (bytes.readFile) {
    const encoded = await bytes.readFile(name, 2 * 1024 * 1024);
    try { return await decodeRecord(encoded, key, name); }
    finally { encoded.fill(0); }
  }
  const info = await bytes.stat(name);
  if (!info || info.type !== "file") throw new Error("Document draft record is missing.");
  return readEncryptedRecord({ size: info.size, readRange: (offset, size) => bytes.readRange(name, offset, size) }, key, name);
}

async function readRecords(bytes: DraftStorage, names: readonly string[], key: Uint8Array, chunkSize: number) {
  if (!bytes.readFiles || names.length < 2 || chunkSize !== LEGACY_DRAFT_CHUNK_SIZE) {
    return Promise.all(names.map(name => readRecord(bytes, name, key)));
  }
  const result: Uint8Array[] = [];
  try {
    for (let start = 0; start < names.length; start += MAX_DRAFT_RECORD_BATCH_FILES) {
      const batchNames = names.slice(start, start + MAX_DRAFT_RECORD_BATCH_FILES);
      const encoded = await bytes.readFiles(batchNames, MAX_DRAFT_RECORD_BATCH_BYTES);
      try {
        if (encoded.length !== batchNames.length) throw new Error("Native draft read batch was incomplete.");
        for (let index = 0; index < batchNames.length; index++) {
          result.push(await decodeRecord(encoded[index]!, key, batchNames[index]!));
        }
      } finally { encoded.forEach(value => value.fill(0)); }
    }
    return result;
  } catch (error) {
    result.forEach(value => value.fill(0));
    throw error;
  }
}

async function encodeRecord(bytes: DraftStorage, name: string, data: Uint8Array, options: DraftOptions) {
  let encoded: Uint8Array | undefined;
  await writeEncryptedRecord({ name, bytes: data, folderKey: options.folderKey, randomBytes: options.randomBytes,
    createSink: (_info, size) => bytes.createSink(name, size),
    writeFile: async (_path, value) => { encoded = value.slice(); } });
  if (!encoded) throw new Error("Encrypted draft record was not produced.");
  return encoded;
}

async function writeRecord(bytes: DraftStorage, name: string, data: Uint8Array, options: DraftOptions,
  flush = true) {
  await writeEncryptedRecord({ name, bytes: data, folderKey: options.folderKey, randomBytes: options.randomBytes,
    createSink: (_info, size) => bytes.createSink(name, size), writeFile: bytes.writeFile });
  if (flush) await bytes.flushChanges([name]);
}

const mergeRange = (ranges: readonly { offset: number; end: number }[], offset: number, end: number) =>
  [...ranges, { offset, end }].sort((left, right) => left.offset - right.offset)
    .reduce<Array<{ offset: number; end: number }>>((result, range) => {
      const previous = result.at(-1);
      if (previous && range.offset <= previous.end) previous.end = Math.max(previous.end, range.end);
      else result.push({ ...range });
      return result;
    }, []);

const validDownload = (download: DownloadDraft | undefined) => !download || (
  typeof download.folderId === "string" && typeof download.path === "string" &&
  typeof download.encrypted === "boolean" && Number.isSafeInteger(download.sizeBytes) && download.sizeBytes >= 0 &&
  (download.sourceDeviceId === undefined || typeof download.sourceDeviceId === "string") &&
  (download.contentId === undefined || typeof download.contentId === "string") &&
  Number.isSafeInteger(download.modifiedMs) && download.modifiedMs >= 0 && Array.isArray(download.ranges) &&
  download.ranges.every((range, index) => Number.isSafeInteger(range.offset) && range.offset >= 0 &&
    Number.isSafeInteger(range.end) && range.end > range.offset && range.end <= download.sizeBytes &&
    (index === 0 || download.ranges[index - 1]!.end < range.offset))
);
/** Ciphertext base snapshot plus atomic encrypted changed blocks. No eager plaintext copy.
 * Acknowledged writes survive process death; fsync/close publish one versioned file.
 * Only the document owner calls this object, with operations serialized by its queue.
 */
async function useDraft(bytes: DraftStorage, prefix: string, head: DraftHead, options: DraftOptions,
  expectedDownloadBlocks?: readonly RangeDigest[]) {
  assertReplicaPath(head.path);
  const chunkSize = head.chunkSize ?? LEGACY_DRAFT_CHUNK_SIZE;
  if (head.format !== 1 || isInternalReplicaPath(head.path) || typeof head.dirty !== "boolean" ||
    (chunkSize !== LEGACY_DRAFT_CHUNK_SIZE && chunkSize !== DRAFT_CHUNK_SIZE) ||
    ![head.baseSize, head.size].every(size => Number.isSafeInteger(size) && size >= 0) || !validDownload(head.download) ||
    (head.download && (head.download.folderId !== options.folderId || head.download.path !== head.path ||
      head.baseSize !== 0 || head.size > head.download.sizeBytes))) {
    throw new Error("Invalid document draft.");
  }
  const downloadBlocks = expectedDownloadBlocks?.map(block => ({ ...block, hash: block.hash.slice() }));
  if (downloadBlocks) {
    if (!head.download) throw new Error("Unexpected download block plan.");
    validateBlockPlan(downloadBlocks, head.download.sizeBytes);
  }
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
      if (data.length !== chunkSize) { data.fill(0); throw new Error("Invalid document draft block."); }
      return data;
    }
    const data = new Uint8Array(chunkSize), offset = index * chunkSize;
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
    const segments: Array<{ index: number; start: number; count: number; target: number }> = [];
    for (let done = 0; done < output.length;) {
      const position = offset + done, start = position % chunkSize,
        count = Math.min(output.length - done, chunkSize - start);
      segments.push({ index: Math.floor(position / chunkSize), start, count, target: done });
      done += count;
    }
    const batched = new Map<number, Uint8Array>();
    try {
      const indexes = [...new Set(segments.map(segment => segment.index).filter(index => chunks.has(index)))];
      if (bytes.readFiles && indexes.length > 1) {
        const values = await readRecords(bytes, indexes.map(index => `${prefix}/chunk-${index}`),
          options.folderKey, chunkSize);
        for (let position = 0; position < indexes.length; position++) {
          const data = values[position]!;
          if (data.length !== chunkSize) { data.fill(0); throw new Error("Invalid document draft block."); }
          batched.set(indexes[position]!, data);
        }
      }
      for (const segment of segments) {
        const cached = batched.get(segment.index);
        const data = cached ?? await chunk(segment.index);
        try { output.set(data.subarray(segment.start, segment.start + segment.count), segment.target); }
        finally { if (!cached) data.fill(0); }
      }
      return output;
    } catch (error) { output.fill(0); throw error; }
    finally { for (const data of batched.values()) data.fill(0); }
  };
  const digest = async () => {
    const hash = sha256.create();
    for (let offset = 0; offset < head.size; offset += chunkSize) {
      const data = await readRange(offset, Math.min(chunkSize, head.size - offset));
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
    ensureOpen();
    if (!head.dirty) return;
    let target = head.path, version = head.version;
    if (recover) {
      const current = (await options.replica.scan()).find(file => file.name === target);
      const sameVersion = !current ? version === null
        : version !== null && compareConcurrentVersionCounters(current.version ?? {}, version) === 0;
      if (!sameVersion) {
        if (await matches(target)) {
          head = { ...head, version: current!.version ?? {}, dirty: false };
          await saveHead();
          return;
        }
        target = `${head.path}.sync-conflict-${prefix.slice(".syncpeer-draft-".length)}`;
        if (await matches(target)) {
          head = { ...head, dirty: false };
          await saveHead();
          return;
        }
        version = null;
      }
    }

    const expectedBlocks = recover ? undefined : downloadBlocks;
    const reusableBlocks = expectedBlocks && hasReplicaBlockLayout(expectedBlocks, head.size)
      ? expectedBlocks : undefined;
    const expectedByOffset = reusableBlocks
      ? new Map(reusableBlocks.map(block => [block.offset, block] as const))
      : undefined;
    const wholeHash = head.download ? sha256.create() : undefined;
    const pendingHashChunks = new Map<number, Uint8Array>();
    let nextHashOffset = 0;
    let publishedDigest = head.size === 0 && wholeHash ? wholeHash.digest() : undefined;

    const addToWholeHash = (offset: number, data: Uint8Array) => {
      if (!wholeHash || publishedDigest || offset < nextHashOffset) return;
      if (offset > nextHashOffset) {
        if (!pendingHashChunks.has(offset)) pendingHashChunks.set(offset, data.slice());
        return;
      }
      wholeHash.update(data);
      nextHashOffset += data.length;
      while (pendingHashChunks.has(nextHashOffset)) {
        const pending = pendingHashChunks.get(nextHashOffset)!;
        pendingHashChunks.delete(nextHashOffset);
        try {
          wholeHash.update(pending);
          nextHashOffset += pending.length;
        } finally {
          pending.fill(0);
        }
      }
      if (nextHashOffset === head.size) publishedDigest = wholeHash.digest();
    };

    const publicationReadRange = async (offset: number, size: number) => {
      const data = await readRange(offset, size);
      if (expectedByOffset) {
        let cursor = offset, consumed = 0;
        while (consumed < data.length) {
          const expected = expectedByOffset.get(cursor);
          if (!expected || expected.size > data.length - consumed ||
              !equalHash(sha256(data.subarray(consumed, consumed + expected.size)), expected.hash)) {
            data.fill(0);
            throw new Error("Downloaded document block changed before publication.");
          }
          cursor += expected.size;
          consumed += expected.size;
        }
      }
      addToWholeHash(offset, data);
      return data;
    };

    if (expectedBlocks && !reusableBlocks) {
      for (const block of expectedBlocks) {
        const hash = sha256.create();
        for (let done = 0; done < block.size; done += 131072) {
          const data = await readRange(block.offset + done, Math.min(131072, block.size - done));
          try { hash.update(data); } finally { data.fill(0); }
        }
        if (!equalHash(hash.digest(), block.hash)) {
          throw new Error("Downloaded document block changed before publication.");
        }
      }
    }

    try {
      const result = await options.replica.edit!({
        method: "write",
        folderId: options.folderId,
        path: target,
        expectedVersion: version,
        modifiedMs: modifiedMs ?? Date.now(),
        source: {
          size: head.size,
          readRange: head.download ? publicationReadRange : readRange,
        },
        ...(reusableBlocks ? { blocks: reusableBlocks } : {}),
      });
      if (head.download && !publishedDigest) {
        throw new Error("Document publication did not verify the complete download.");
      }
      head = { ...head, version: result.version ?? {}, dirty: false };
      await saveHead();
      return publishedDigest;
    } finally {
      for (const pending of pendingHashChunks.values()) pending.fill(0);
      pendingHashChunks.clear();
    }
  };

  const discard = async () => {
    closed = true;
    metadata?.fileKey.fill(0);
    // No recursive delete and no externally supplied path. Unexpected entries fail closed.
    const entries = await bytes.listDirectory(prefix);
    for (const entry of entries) {
      if (entry.type !== "file" || !/^(head|base|chunk-\d+)$/.test(entry.path.slice(prefix.length + 1))) {
        throw new Error("Unexpected draft entry.");
      }
    }
    const paths = entries.map(entry => entry.path);
    if (paths.length) {
      if (bytes.removeFiles) await bytes.removeFiles(paths);
      else for (const path of paths) await bytes.remove(path, false);
    }
    await bytes.remove(prefix, true);
  };
  const writeBatch = async (writes: readonly { offset: number; bytes: Uint8Array }[]) => {
    ensureOpen();
    if (!Array.isArray(writes) || writes.length > 8 || writes.some(write =>
      !Number.isSafeInteger(write.offset) || write.offset < 0 ||
      !Number.isSafeInteger(write.offset + write.bytes.length) || write.bytes.length > 131072) ||
      writes.reduce((total, write) => total + write.bytes.length, 0) > 8 * 131072) {
      throw new Error("Invalid document write batch.");
    }
    const changed = new Set<string>();
    let nextHead = head;
    if (writes.some(write => write.bytes.length) && !head.dirty) {
      head = { ...head, dirty: true };
      await saveHead();
      nextHead = head;
    }

    const grouped = new Map<number, Array<{ start: number; bytes: Uint8Array }>>();
    for (const { offset, bytes: input } of writes) {
      if (!input.length) continue;
      for (let done = 0; done < input.length;) {
        const position = offset + done;
        const index = Math.floor(position / chunkSize);
        const start = position % chunkSize;
        const count = Math.min(input.length - done, chunkSize - start);
        const parts = grouped.get(index) ?? [];
        parts.push({ start, bytes: input.subarray(done, done + count) });
        grouped.set(index, parts);
        done += count;
      }
      nextHead = {
        ...nextHead,
        size: Math.max(nextHead.size, offset + input.length),
        ...(nextHead.download ? {
          download: {
            ...nextHead.download,
            ranges: mergeRange(nextHead.download.ranges, offset, offset + input.length),
          },
        } : {}),
      };
    }

    const encodedRecords: Array<{ path: string; bytes: Uint8Array; index: number }> = [];
    try {
      for (const [index, parts] of [...grouped].sort((left, right) => left[0] - right[0])) {
        const logicalSize = nextHead.download
          ? Math.max(0, Math.min(chunkSize, nextHead.download.sizeBytes - index * chunkSize))
          : chunkSize;
        const sorted = [...parts].sort((left, right) => left.start - right.start);
        let covered = 0;
        for (const part of sorted) {
          if (part.start > covered) break;
          covered = Math.max(covered, part.start + part.bytes.length);
        }
        const replacesWholeDownloadChunk = !!nextHead.download && covered >= logicalSize;
        const data = replacesWholeDownloadChunk ? new Uint8Array(chunkSize) : await chunk(index);
        try {
          for (const part of parts) data.set(part.bytes, part.start);
          const name = `${prefix}/chunk-${index}`;
          if (bytes.writeFiles) encodedRecords.push({ path: name, bytes: await encodeRecord(bytes, name, data, options), index });
          else await writeRecord(bytes, name, data, options, false);
          if (!bytes.writeFiles) {
            chunks.add(index);
            changed.add(name);
          }
        } finally { data.fill(0); }
      }
      if (encodedRecords.length) {
        const batches: Array<typeof encodedRecords> = [];
        let batch: typeof encodedRecords = [];
        let batchSize = 0;
        for (const record of encodedRecords) {
          if (record.bytes.length > MAX_DRAFT_RECORD_BATCH_BYTES) {
            throw new Error("Encrypted draft record exceeds the native batch limit.");
          }
          if (batch.length && (batch.length === MAX_DRAFT_RECORD_BATCH_FILES ||
            batchSize + record.bytes.length > MAX_DRAFT_RECORD_BATCH_BYTES)) {
            batches.push(batch);
            batch = [];
            batchSize = 0;
          }
          batch.push(record);
          batchSize += record.bytes.length;
        }
        if (batch.length) batches.push(batch);
        for (const records of batches) {
          await bytes.writeFiles!(records);
          for (const record of records) {
            chunks.add(record.index);
            changed.add(record.path);
          }
        }
      }
    } finally { encodedRecords.forEach(record => record.bytes.fill(0)); }
    if (!changed.size) return;
    await bytes.flushChanges([...changed]);
    head = nextHead;
    await saveHead();
  };
  return {
    path: head.path, size: async () => { ensureOpen(); return head.size; }, readRange, digest, flush, discard,
    downloadRanges: () => head.download?.ranges.map(range => ({ ...range })) ?? [],
    write: (offset: number, input: Uint8Array) => writeBatch([{ offset, bytes: input }]),
    writeBatch,
    close: async () => { closed = true; metadata?.fileKey.fill(0); if (!head.dirty) await discard(); },
  };
}

export async function openDocumentDraft(bytes: DraftStorage, options: DraftOptions & {
  path: string; truncate: boolean; recover?: boolean; download?: DownloadDraftInput;
}) {
  assertReplicaPath(options.path);
  if (isInternalReplicaPath(options.path)) throw new Error("Private document.");
  const current = (await options.replica.scan()).find(file => file.name === options.path);
  if (current && !current.deleted && Number(current.type ?? 0) !== 0) throw new Error("Document is not a file.");
  const prefix = ".syncpeer-draft-" + [...await options.randomBytes(16)]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (await bytes.stat(prefix)) throw new Error("Draft already exists.");
  await bytes.makeDirectory(prefix);
  const baseSize = options.truncate || current?.deleted ? 0 : Number(current?.size ?? 0);
  if (baseSize) await bytes.copy(await encryptUntrustedFilename(options.folderKey, options.path), prefix + "/base");
  const download: DownloadDraft | undefined = options.download ? {
    folderId: options.download.folderId,
    path: options.download.path,
    sizeBytes: options.download.sizeBytes,
    encrypted: options.download.encrypted,
    modifiedMs: options.download.modifiedMs,
    ...(options.download.sourceDeviceId ? { sourceDeviceId: options.download.sourceDeviceId } : {}),
    ...(options.download.contentId ? { contentId: options.download.contentId } : {}),
    ranges: [],
  } : undefined;
  const head: DraftHead = {
    format: 1,
    path: options.path,
    baseSize,
    size: baseSize,
    dirty: options.truncate,
    version: current?.version ?? null,
    chunkSize: download ? DRAFT_CHUNK_SIZE : LEGACY_DRAFT_CHUNK_SIZE,
    recover: options.recover ?? true,
    ...(download ? { download } : {}),
  };
  const data = new TextEncoder().encode(JSON.stringify(head));
  try {
    await writeRecord(bytes, prefix + "/head", data, options);
  } finally {
    data.fill(0);
  }
  return useDraft(bytes, prefix, head, options, options.download?.blocks);
}

export async function openDocumentDownloadDraft(bytes: DraftStorage, options: DraftOptions & {
  path: string; download: DownloadDraftInput;
}) {
  for (const root of await bytes.listDirectory("")) {
    if (root.type !== "directory" || !/^\.syncpeer-draft-[a-f0-9]{32}$/.test(root.path)) continue;
    let data: Uint8Array | undefined;
    try {
      data = await readRecord(bytes, root.path + "/head", options.folderKey);
      const head = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as DraftHead;
      if (head.recover !== false || head.path !== options.path || !validDownload(head.download)) continue;
      const { modifiedMs } = head.download!;
      const metadata: FileDownloadMetadata = {
        folderId: head.download!.folderId,
        path: head.download!.path,
        sizeBytes: head.download!.sizeBytes,
        encrypted: head.download!.encrypted,
        ...(head.download!.sourceDeviceId ? { sourceDeviceId: head.download!.sourceDeviceId } : {}),
        ...(head.download!.contentId ? { contentId: head.download!.contentId } : {}),
      };
      if (modifiedMs === options.download.modifiedMs && sameDownloadMetadata(metadata, options.download)) {
        return useDraft(bytes, root.path, head, options, options.download.blocks);
      }
      const draft = await useDraft(bytes, root.path, head, options);
      await draft.discard();
    } finally {
      data?.fill(0);
    }
  }
  return openDocumentDraft(bytes, { ...options, truncate: true, recover: false, download: options.download });
}
export async function recoverDocumentDrafts(bytes: DraftStorage, options: DraftOptions): Promise<string[]> {
  const issues: string[] = [];
  for (const root of await bytes.listDirectory("")) {
    if (root.type !== "directory" || !/^\.syncpeer-draft-[a-f0-9]{32}$/.test(root.path)) continue;
    try {
      const data = await readRecord(bytes, root.path + "/head", options.folderKey);
      let head: DraftHead;
      try { head = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); } finally { data.fill(0); }
      if (head.recover === false) {
        if (head.download && validDownload(head.download)) continue;
        const draft = await useDraft(bytes, root.path, head, options);
        await draft.discard();
        continue;
      }
      const draft = await useDraft(bytes, root.path, head, options);
      try { await draft.flush(true); } finally { await draft.close(); }
    } catch { issues.push("An encrypted edit needs recovery; its data has been retained."); }
  }
  return issues;
}
