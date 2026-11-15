import { encodeBase64 } from "../transfer/base64.js";
import { parseServiceResponse, withServiceProtocol } from "./serviceProtocol.js";
import { normalizeDeviceId } from "../ui/helpers.js";

type Command = (request: Record<string, unknown>) => Promise<unknown>;

const STAGE_CHUNK_BYTES = 64 * 1024;

/** Stream a browser-selected file into Keystore-encrypted native staging.
 * Finalization atomically enqueues the service-owned upload job. No staging
 * write touches the target's existing encrypted replica. */
export const stageServiceUpload = async (args: {
  command: Command;
  folderId: string;
  peerId: string;
  path: string;
  file: Blob;
  modifiedMs: number;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}): Promise<{ id: string; phase: string }> => {
  args.signal?.throwIfAborted();
  if (!/^[A-Z2-7]{52}([A-Z2-7]{4})?$/.test(normalizeDeviceId(args.peerId))) {
    throw new Error("An authenticated destination peer is required for upload.");
  }
  if (!Number.isSafeInteger(args.file.size) || args.file.size > 512 * 1024 * 1024) {
    throw new Error("Upload exceeds Android's encrypted staging limit (512 MiB).");
  }
  const begun = parseServiceResponse("transferStageBegin", await args.command(
    withServiceProtocol({ operation: "transferStageBegin",
      sizeBytes: args.file.size, modifiedMs: args.modifiedMs }))) as { stageId: string };
  const stageId = begun.stageId;
  try {
    for (let offset = 0; offset < args.file.size; offset += STAGE_CHUNK_BYTES) {
      args.signal?.throwIfAborted();
      const chunk = new Uint8Array(await args.file.slice(offset, offset + STAGE_CHUNK_BYTES).arrayBuffer());
      try {
        const result = parseServiceResponse("transferStageWrite", await args.command(
          withServiceProtocol({ operation: "transferStageWrite", stageId, offset,
            bytes: encodeBase64(chunk) }))) as { offset: number };
        if (result.offset !== offset + chunk.length) throw new Error("Android staging offset changed.");
      } finally { chunk.fill(0); }
      args.onProgress?.(Math.min(args.file.size, offset + STAGE_CHUNK_BYTES), args.file.size);
    }
    args.signal?.throwIfAborted();
    return parseServiceResponse("transferStageFinish", await args.command(
      withServiceProtocol({ operation: "transferStageFinish", stageId,
        folderId: args.folderId, path: args.path, peerId: args.peerId }))) as { id: string; phase: string };
  } catch (error) {
    await args.command(withServiceProtocol({ operation: "transferStageCancel", stageId }))
      .catch(() => undefined);
    throw error;
  }
};
