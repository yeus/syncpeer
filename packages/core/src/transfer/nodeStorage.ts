import { open, mkdir, rename, rm, mkdtemp, readdir, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { sameDownloadMetadata, type FileDownloadSink, type FileDownloadMetadata } from "./stream.js";
import type { DownloadRange } from "./blockReuse.js";

const validateRange = (range: DownloadRange, size: number): void => {
  if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.size) ||
      range.offset < 0 || range.size < 0 || range.offset > size || range.size > size - range.offset) {
    throw new Error("Storage range is outside the file.");
  }
};

const readRange = async (file: FileHandle, range: DownloadRange, consume: (bytes: Uint8Array, offset: number) => Promise<void>) => {
  const buffer = Buffer.alloc(Math.min(256 * 1024, range.size));
  let consumed = 0;
  while (consumed < range.size) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, range.size - consumed), range.offset + consumed);
    if (!bytesRead) throw new Error("Cached source changed while reading.");
    await consume(buffer.subarray(0, bytesRead), range.offset + consumed);
    consumed += bytesRead;
  }
};

export const digestRanges = async (file: FileHandle, ranges: readonly DownloadRange[], skipMissing: boolean) => {
  const size = (await file.stat()).size;
  const results = [];
  for (const range of ranges) {
    if (skipMissing && range.offset + range.size > size) continue;
    validateRange(range, size);
    const hash = createHash("sha256");
    await readRange(file, range, async (bytes) => { hash.update(bytes); });
    results.push({ ...range, hash: new Uint8Array(hash.digest()) });
  }
  return results;
};

const openResumeSource = async (directory: string, prefix: string, current: string, metadata: FileDownloadMetadata) => {
  if (!metadata.contentId || metadata.contentId.startsWith("unhashed:")) return undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.reverse()) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const candidate = path.join(directory, entry.name);
    if (candidate === current) continue;
    try {
      const stored: unknown = JSON.parse(await readFile(path.join(candidate, "metadata.json"), "utf8"));
      if (!stored || typeof stored !== "object" || !sameDownloadMetadata(stored as FileDownloadMetadata, metadata)) continue;
      const owner = stored as { ownerPid?: number; suspended?: boolean };
      if (!owner.suspended) {
        if (!Number.isSafeInteger(owner.ownerPid) || owner.ownerPid! <= 0) continue;
        try { process.kill(owner.ownerPid!, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      }
      return { file: await open(path.join(candidate, "partial"), "r"), directory: candidate };
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return undefined;
};

const saveDownloadMetadata = async (staging: string, metadata: FileDownloadMetadata, suspended: boolean) => {
  const temporary = path.join(staging, "metadata.tmp");
  const record = await open(temporary, "w", 0o600);
  try { await record.writeFile(JSON.stringify({ ...metadata, ownerPid: process.pid, suspended })); await record.sync(); }
  finally { await record.close(); }
  await rename(temporary, path.join(staging, "metadata.json"));
};

/** Native filesystem mechanics only; block selection and comparison stay in core. */
export const createNodeFileDownloadSink = async (localPath: string): Promise<FileDownloadSink> => {
  const finalPath = path.resolve(localPath);
  await mkdir(path.dirname(finalPath), { recursive: true });
  const prefix = `.syncpeer-download-${createHash("sha256").update(finalPath).digest("hex").slice(0, 24)}-`;
  const staging = await mkdtemp(path.join(path.dirname(finalPath), prefix));
  const partialPath = path.join(staging, "partial");
  const file = await open(partialPath, "wx+");
  let cached: FileHandle | undefined;
  let resume: FileHandle | undefined;
  let resumeDirectory: string | undefined;
  let metadata: FileDownloadMetadata | undefined;
  let expectedSize: number | undefined;
  let closed = false;
  let committed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await file.close();
    await cached?.close();
    await resume?.close();
  };
  const write = async (offset: number, bytes: Uint8Array) => {
    if (closed || expectedSize === undefined) throw new Error("Download sink is not writable.");
    validateRange({ offset, size: bytes.length }, expectedSize);
    let written = 0;
    while (written < bytes.length) {
      const result = await file.write(bytes, written, bytes.length - written, offset + written);
      if (!result.bytesWritten) throw new Error("Download write made no progress.");
      written += result.bytesWritten;
    }
  };
  return {
    begin: async (nextMetadata) => {
      if (metadata) {
        if (!sameDownloadMetadata(metadata, nextMetadata)) throw new Error("Download metadata changed.");
        return;
      }
      metadata = { ...nextMetadata };
      expectedSize = metadata.sizeBytes;
      validateRange({ offset: 0, size: expectedSize }, expectedSize);
      const source = await openResumeSource(path.dirname(finalPath), prefix, staging, metadata);
      resume = source?.file;
      resumeDirectory = source?.directory;
      await saveDownloadMetadata(staging, metadata, false);
      if (!cached) {
        try { cached = await open(finalPath, "r"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    },
    write,
    resumeStorage: {
      digestCachedRanges: async (ranges) => resume ? digestRanges(resume, ranges, true) : [],
      copyCachedRanges: async (ranges) => {
        if (!resume) throw new Error("Resume source is unavailable.");
        for (const range of ranges) {
          validateRange(range, (await resume.stat()).size);
          await readRange(resume, range, async (bytes, offset) => write(offset, bytes));
        }
      },
    },
    digestCachedRanges: async (ranges) => cached ? digestRanges(cached, ranges, true) : [],
    copyCachedRanges: async (ranges) => {
      if (!cached) throw new Error("Cached source is unavailable.");
      for (const range of ranges) {
        validateRange(range, (await cached.stat()).size);
        await readRange(cached, range, async (bytes, offset) => write(offset, bytes));
      }
    },
    digestPartialRanges: (ranges) => digestRanges(file, ranges, false),
    digestFile: async () => {
      const [digest] = await digestRanges(file, [{ offset: 0, size: (await file.stat()).size }], false);
      return Buffer.from(digest.hash).toString("hex");
    },
    commit: async () => {
      if (committed) return;
      if ((await file.stat()).size !== expectedSize) throw new Error("Incomplete download.");
      await file.sync();
      await close();
      await rename(partialPath, finalPath);
      committed = true;
      await rm(staging, { recursive: true, force: true });
      if (resumeDirectory) await rm(resumeDirectory, { recursive: true, force: true });
    },
    abort: async () => {
      await close();
      await rm(staging, { recursive: true, force: true });
      if (resumeDirectory) await rm(resumeDirectory, { recursive: true, force: true });
    },
    suspend: async () => {
      if (closed) return;
      await file.sync();
      await close();
      if (metadata) await saveDownloadMetadata(staging, metadata, true);
      else await rm(staging, { recursive: true, force: true });
    },
  };
};
