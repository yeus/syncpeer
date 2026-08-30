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
}

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
