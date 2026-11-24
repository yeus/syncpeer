import type { DocumentFilesystem } from "./documentFilesystem.js";

// Document drafts persist one encrypted 1 MiB chunk per batch. Sending eight
// independent 128 KiB writes instead repeatedly rewrites the same draft chunk.
// Keep the existing writeBatch bounds and yield between durable batches.
const WRITE_BYTES = 128 * 1024;
const BATCH_BYTES = 8 * WRITE_BYTES;

export async function writeDocumentDownload(
  documents: Pick<DocumentFilesystem, "writeBatch">,
  handle: number,
  offset: number,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  for (let start = 0; start < bytes.length; start += BATCH_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(start + BATCH_BYTES, bytes.length);
    const writes = [];
    for (let pos = start; pos < end; pos += WRITE_BYTES) {
      writes.push({ offset: offset + pos, bytes: bytes.subarray(pos, Math.min(pos + WRITE_BYTES, end)) });
    }
    await documents.writeBatch(handle, writes);
  }
}
