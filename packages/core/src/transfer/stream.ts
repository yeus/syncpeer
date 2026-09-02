import type { Port } from "./frpBus.js";

export interface FileDownloadMetadata {
  folderId: string;
  path: string;
  sizeBytes: number;
  encrypted: boolean;
}

export interface FileDownloadSink {
  begin: (metadata: FileDownloadMetadata) => Promise<void> | void;
  write: (offset: number, bytes: Uint8Array) => Promise<void> | void;
  commit: () => Promise<void> | void;
  abort: (error: unknown) => Promise<void> | void;
  hasRange?: (offset: number, size: number) => boolean;
}

export interface DownloadCheckpoint {
  metadata: FileDownloadMetadata | null;
  completedRanges: Array<{ offset: number; size: number }>;
}

export class RemoteMetadataChangedError extends Error {
  readonly name = "RemoteMetadataChangedError";
}

const sameMetadata = (left: FileDownloadMetadata, right: FileDownloadMetadata): boolean =>
  left.folderId === right.folderId &&
  left.path === right.path &&
  left.sizeBytes === right.sizeBytes &&
  left.encrypted === right.encrypted;

export const createCheckpointedDownloadSink = (
  sink: FileDownloadSink,
  checkpoint: DownloadCheckpoint = { metadata: null, completedRanges: [] },
): { sink: FileDownloadSink; checkpoint: DownloadCheckpoint } => {
  const hasRange = (offset: number, size: number): boolean =>
    checkpoint.completedRanges.some(
      (range) => offset >= range.offset && offset + size <= range.offset + range.size,
    );
  const addRange = (offset: number, size: number): void => {
    const sorted = [...checkpoint.completedRanges, { offset, size }]
      .sort((left, right) => left.offset - right.offset);
    checkpoint.completedRanges = sorted.reduce<Array<{ offset: number; size: number }>>(
      (ranges, range) => {
        const previous = ranges.at(-1);
        if (!previous || previous.offset + previous.size < range.offset) {
          ranges.push({ ...range });
        } else {
          previous.size = Math.max(previous.offset + previous.size, range.offset + range.size) - previous.offset;
        }
        return ranges;
      },
      [],
    );
  };
  return {
    checkpoint,
    sink: {
      begin: async (metadata) => {
        if (checkpoint.metadata && !sameMetadata(checkpoint.metadata, metadata)) {
          const error = new RemoteMetadataChangedError("Remote file metadata changed during download recovery.");
          await sink.abort(error);
          throw error;
        }
        if (!checkpoint.metadata) {
          await sink.begin(metadata);
          checkpoint.metadata = { ...metadata };
        }
      },
      write: async (offset, bytes) => {
        if (hasRange(offset, bytes.length)) return;
        await sink.write(offset, bytes);
        addRange(offset, bytes.length);
      },
      commit: () => sink.commit(),
      abort: (error) => sink.abort(error),
      hasRange,
    },
  };
};

export type FileTransferMessage =
  | { type: "transfer.begin"; transferId: string; metadata: FileDownloadMetadata }
  | { type: "transfer.chunk"; transferId: string; chunkId: number; offset: number; bytes: Uint8Array }
  | { type: "transfer.commit"; transferId: string }
  | { type: "transfer.abort"; transferId: string; message: string }
  | { type: "transfer.ack"; transferId: string; operation: "begin" | "chunk" | "commit"; chunkId?: number }
  | { type: "transfer.error"; transferId: string; operation: string; message: string; chunkId?: number };

export interface FileDownloadResult {
  bytesWritten: number;
  totalBytes: number;
}

const transferTimeoutMs = 30_000;

export const createPortDownloadSink = (
  port: Port<FileTransferMessage, FileTransferMessage>,
  transferId: string,
): FileDownloadSink => {
  let started = false;
  let begun = false;
  let nextChunkId = 0;
  let committed = false;

  const request = async (
    message: FileTransferMessage,
    operation: "begin" | "chunk" | "commit",
    chunkId?: number,
  ): Promise<void> => {
    const response = new Promise<FileTransferMessage>((resolve, reject) => {
      const unsubscribe = port.receive((result) => {
        const matchesOperation = result.type === "transfer.error"
          ? result.transferId === transferId && result.operation === operation
          : result.type === "transfer.ack" &&
            result.transferId === transferId &&
            result.operation === operation &&
            (chunkId === undefined || result.chunkId === chunkId);
        if (!matchesOperation) return;
        unsubscribe();
        clearTimeout(timer);
        resolve(result);
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Transfer ${operation} timed out.`));
      }, transferTimeoutMs);
    });
    port.send(message);
    const result = await response;
    if (result.type === "transfer.error") {
      throw new Error(result.message);
    }
  };

  return {
    begin: async (metadata) => {
      if (begun) return;
      started = true;
      await request({ type: "transfer.begin", transferId, metadata }, "begin");
      begun = true;
    },
    write: async (offset, bytes) => {
      if (!begun || committed) throw new Error("Transfer sink is not writable.");
      const chunkId = nextChunkId++;
      await request({ type: "transfer.chunk", transferId, chunkId, offset, bytes }, "chunk", chunkId);
    },
    commit: async () => {
      if (committed) return;
      if (!begun) throw new Error("Transfer sink has not begun.");
      await request({ type: "transfer.commit", transferId }, "commit");
      committed = true;
    },
    abort: async (error) => {
      if (!started || committed) return;
      const message = error instanceof Error ? error.message : String(error);
      port.send({ type: "transfer.abort", transferId, message });
      started = false;
      begun = false;
    },
  };
};
