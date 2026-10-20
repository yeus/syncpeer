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
type DraftSource = { size: number; readRange: (offset: number, size: number) => Promise<Uint8Array> };
type DraftMetadata = Awaited<ReturnType<typeof loadEncryptedDiskMetadata>>;

class DocumentDraft {
  private readonly bytes: DraftStorage;
  private readonly prefix: string;
  private head: DraftHead;
  private readonly options: DraftOptions;
  private readonly chunkSize: number;
  private readonly chunks: Set<number>;
  private readonly source: DraftSource | null;
  private readonly metadata: DraftMetadata | null;
  private readonly downloadBlocks: readonly RangeDigest[] | undefined;
  private closed = false;

  private constructor(
    bytes: DraftStorage,
    prefix: string,
    head: DraftHead,
    options: DraftOptions,
    chunkSize: number,
    chunks: Set<number>,
    source: DraftSource | null,
    metadata: DraftMetadata | null,
    downloadBlocks?: readonly RangeDigest[],
  ) {
    this.bytes = bytes;
    this.prefix = prefix;
    this.head = head;
    this.options = options;
    this.chunkSize = chunkSize;
    this.chunks = chunks;
    this.source = source;
    this.metadata = metadata;
    this.downloadBlocks = downloadBlocks;
  }

  static async create(
    bytes: DraftStorage,
    prefix: string,
    head: DraftHead,
    options: DraftOptions,
    expectedDownloadBlocks?: readonly RangeDigest[],
  ) {

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
    return new DocumentDraft(bytes, prefix, head, options, chunkSize, chunks, source, metadata, downloadBlocks);
  }

  private ensureOpen = () => { if (this.closed) throw new Error("Document draft is closed."); };

  private saveHead = async () => {
    const data = new TextEncoder().encode(JSON.stringify(this.head));
    try { await writeRecord(this.bytes, this.prefix + "/head", data, this.options); } finally { data.fill(0); }
  };

  private chunk = async (index: number) => {
    if (this.chunks.has(index)) {
      const data = await readRecord(this.bytes, `${this.prefix}/chunk-${index}`, this.options.folderKey);
      if (data.length !== this.chunkSize) { data.fill(0); throw new Error("Invalid document draft block."); }
      return data;
    }
    const data = new Uint8Array(this.chunkSize), offset = index * this.chunkSize;
    if (this.source && this.metadata && offset < this.head.baseSize) {
      const original = await readEncryptedDiskRange(this.source, this.metadata, offset, Math.min(data.length, this.head.baseSize - offset));
      try { data.set(original); } finally { original.fill(0); }
    }
    return data;
  };

  private readRange = async (offset: number, size: number) => {
    this.ensureOpen();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) throw new Error("Invalid document range.");
    const output = new Uint8Array(Math.max(0, Math.min(size, this.head.size - offset)));
    const segments: Array<{ index: number; start: number; count: number; target: number }> = [];
    for (let done = 0; done < output.length;) {
      const position = offset + done, start = position % this.chunkSize,
        count = Math.min(output.length - done, this.chunkSize - start);
      segments.push({ index: Math.floor(position / this.chunkSize), start, count, target: done });
      done += count;
    }
    const batched = new Map<number, Uint8Array>();
    try {
      const indexes = [...new Set(segments.map(segment => segment.index).filter(index => this.chunks.has(index)))];
      if (this.bytes.readFiles && indexes.length > 1) {
        const values = await readRecords(this.bytes, indexes.map(index => `${this.prefix}/chunk-${index}`),
          this.options.folderKey, this.chunkSize);
        for (let position = 0; position < indexes.length; position++) {
          const data = values[position]!;
          if (data.length !== this.chunkSize) { data.fill(0); throw new Error("Invalid document draft block."); }
          batched.set(indexes[position]!, data);
        }
      }
      for (const segment of segments) {
        const cached = batched.get(segment.index);
        const data = cached ?? await this.chunk(segment.index);
        try { output.set(data.subarray(segment.start, segment.start + segment.count), segment.target); }
        finally { if (!cached) data.fill(0); }
      }
      return output;
    } catch (error) { output.fill(0); throw error; }
    finally { for (const data of batched.values()) data.fill(0); }
  };

  private digest = async () => {
    const hash = sha256.create();
    for (let offset = 0; offset < this.head.size; offset += this.chunkSize) {
      const data = await this.readRange(offset, Math.min(this.chunkSize, this.head.size - offset));
      try { hash.update(data); } finally { data.fill(0); }
    }
    return hash.digest();
  };

  private matches = async (path: string) => {
    const current = (await this.options.replica.scan()).find(file => file.name === path && !file.deleted);
    if (!current || current.type === 1 || Number(current.size) !== this.head.size) return false;
    const replicaSource = await createReplicaFileSource(this.options.replica, path), hash = sha256.create();
    for (let offset = 0; offset < replicaSource.size; offset += 131072) {
      const data = await replicaSource.readRange(offset, Math.min(131072, replicaSource.size - offset));
      try { hash.update(data); } finally { data.fill(0); }
    }
    return equalHash(hash.digest(), await this.digest());
  };

  private flush = async (recover = false, modifiedMs?: number) => {
    this.ensureOpen();
    if (!this.head.dirty) return;
    let target = this.head.path, version = this.head.version;
    if (recover) {
      const current = (await this.options.replica.scan()).find(file => file.name === target);
      const sameVersion = !current ? version === null
        : version !== null && compareConcurrentVersionCounters(current.version ?? {}, version) === 0;
      if (!sameVersion) {
        if (await this.matches(target)) {
          this.head = { ...this.head, version: current!.version ?? {}, dirty: false };
          await this.saveHead();
          return;
        }
        target = `${this.head.path}.sync-conflict-${this.prefix.slice(".syncpeer-draft-".length)}`;
        if (await this.matches(target)) {
          this.head = { ...this.head, dirty: false };
          await this.saveHead();
          return;
        }
        version = null;
      }
    }

    const expectedBlocks = recover ? undefined : this.downloadBlocks;
    const reusableBlocks = expectedBlocks && hasReplicaBlockLayout(expectedBlocks, this.head.size)
      ? expectedBlocks : undefined;
    const expectedByOffset = reusableBlocks
      ? new Map(reusableBlocks.map(block => [block.offset, block] as const))
      : undefined;
    const wholeHash = this.head.download ? sha256.create() : undefined;
    const pendingHashChunks = new Map<number, Uint8Array>();
    let nextHashOffset = 0;
    let publishedDigest = this.head.size === 0 && wholeHash ? wholeHash.digest() : undefined;

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
      if (nextHashOffset === this.head.size) publishedDigest = wholeHash.digest();
    };

    const publicationReadRange = async (offset: number, size: number) => {
      const data = await this.readRange(offset, size);
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
          const data = await this.readRange(block.offset + done, Math.min(131072, block.size - done));
          try { hash.update(data); } finally { data.fill(0); }
        }
        if (!equalHash(hash.digest(), block.hash)) {
          throw new Error("Downloaded document block changed before publication.");
        }
      }
    }

    try {
      const result = await this.options.replica.edit!({
        method: "write",
        folderId: this.options.folderId,
        path: target,
        expectedVersion: version,
        modifiedMs: modifiedMs ?? Date.now(),
        source: {
          size: this.head.size,
          readRange: this.head.download ? publicationReadRange : this.readRange,
        },
        ...(reusableBlocks ? { blocks: reusableBlocks } : {}),
      });
      if (this.head.download && !publishedDigest) {
        throw new Error("Document publication did not verify the complete download.");
      }
      this.head = { ...this.head, version: result.version ?? {}, dirty: false };
      await this.saveHead();
      return publishedDigest;
    } finally {
      for (const pending of pendingHashChunks.values()) pending.fill(0);
      pendingHashChunks.clear();
    }
  };

  private discard = async () => {
    this.closed = true;
    this.metadata?.fileKey.fill(0);
    // No recursive delete and no externally supplied path. Unexpected entries fail closed.
    const entries = await this.bytes.listDirectory(this.prefix);
    for (const entry of entries) {
      if (entry.type !== "file" || !/^(head|base|chunk-\d+)$/.test(entry.path.slice(this.prefix.length + 1))) {
        throw new Error("Unexpected draft entry.");
      }
    }
    const paths = entries.map(entry => entry.path);
    if (paths.length) {
      if (this.bytes.removeFiles) await this.bytes.removeFiles(paths);
      else for (const path of paths) await this.bytes.remove(path, false);
    }
    await this.bytes.remove(this.prefix, true);
  };

  private writeBatch = async (writes: readonly { offset: number; bytes: Uint8Array }[]) => {
    this.ensureOpen();
    if (!Array.isArray(writes) || writes.length > 8 || writes.some(write =>
      !Number.isSafeInteger(write.offset) || write.offset < 0 ||
      !Number.isSafeInteger(write.offset + write.bytes.length) || write.bytes.length > 131072) ||
      writes.reduce((total, write) => total + write.bytes.length, 0) > 8 * 131072) {
      throw new Error("Invalid document write batch.");
    }
    const changed = new Set<string>();
    let nextHead = this.head;
    if (writes.some(write => write.bytes.length) && !this.head.dirty) {
      this.head = { ...this.head, dirty: true };
      await this.saveHead();
      nextHead = this.head;
    }

    const grouped = new Map<number, Array<{ start: number; bytes: Uint8Array }>>();
    for (const { offset, bytes: input } of writes) {
      if (!input.length) continue;
      for (let done = 0; done < input.length;) {
        const position = offset + done;
        const index = Math.floor(position / this.chunkSize);
        const start = position % this.chunkSize;
        const count = Math.min(input.length - done, this.chunkSize - start);
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
          ? Math.max(0, Math.min(this.chunkSize, nextHead.download.sizeBytes - index * this.chunkSize))
          : this.chunkSize;
        const sorted = [...parts].sort((left, right) => left.start - right.start);
        let covered = 0;
        for (const part of sorted) {
          if (part.start > covered) break;
          covered = Math.max(covered, part.start + part.bytes.length);
        }
        const replacesWholeDownloadChunk = !!nextHead.download && covered >= logicalSize;
        const data = replacesWholeDownloadChunk ? new Uint8Array(this.chunkSize) : await this.chunk(index);
        try {
          for (const part of parts) data.set(part.bytes, part.start);
          const name = `${this.prefix}/chunk-${index}`;
          if (this.bytes.writeFiles) encodedRecords.push({ path: name, bytes: await encodeRecord(this.bytes, name, data, this.options), index });
          else await writeRecord(this.bytes, name, data, this.options, false);
          if (!this.bytes.writeFiles) {
            this.chunks.add(index);
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
          await this.bytes.writeFiles!(records);
          for (const record of records) {
            this.chunks.add(record.index);
            changed.add(record.path);
          }
        }
      }
    } finally { encodedRecords.forEach(record => record.bytes.fill(0)); }
    if (!changed.size) return;
    await this.bytes.flushChanges([...changed]);
    this.head = nextHead;
    await this.saveHead();
  };

  api() {
    return {
      path: this.head.path,
      size: async () => { this.ensureOpen(); return this.head.size; },
      readRange: this.readRange,
      digest: this.digest,
      flush: this.flush,
      discard: this.discard,
      downloadRanges: () => this.head.download?.ranges.map(range => ({ ...range })) ?? [],
      write: (offset: number, input: Uint8Array) => this.writeBatch([{ offset, bytes: input }]),
      writeBatch: this.writeBatch,
      close: async () => {
        this.closed = true;
        this.metadata?.fileKey.fill(0);
        if (!this.head.dirty) await this.discard();
      },
    };
  }
}

async function useDraft(
  bytes: DraftStorage,
  prefix: string,
  head: DraftHead,
  options: DraftOptions,
  expectedDownloadBlocks?: readonly RangeDigest[],
) {
  return (await DocumentDraft.create(bytes, prefix, head, options, expectedDownloadBlocks)).api();
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
