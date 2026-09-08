import { sha256 } from "@noble/hashes/sha2.js";
import { encryptUntrustedFilename } from "../core/model/untrusted.js";
import { loadEncryptedDiskMetadata, readEncryptedDiskRange, writeEncryptedDiskFile, type EncryptedFileSource } from "./encryptedFilesystem.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

/** Private records use the same Syncthing file encoding as file contents. */
export async function writeEncryptedRecord(args: Pick<Parameters<typeof writeEncryptedDiskFile>[0], "folderKey" | "randomBytes" | "createSink" | "signal"> & {
  name: string; bytes: Uint8Array;
}) {
  assertReplicaPath(args.name);
  if (!isInternalReplicaPath(args.name)) throw new Error("Encrypted record must be private.");
  if (args.bytes.length > 64 * 1024 * 1024) throw new Error("Encrypted record exceeds the supported storage limit.");
  const blocks = [];
  for (let offset = 0; offset < args.bytes.length; offset += 131072) {
    const chunk = args.bytes.subarray(offset, offset + 131072);
    blocks.push({ offset, size: chunk.length, hash: sha256(chunk) });
  }
  return writeEncryptedDiskFile({ ...args,
    fileInfo: { name: args.name, type: 0, size: args.bytes.length, block_size: 131072, blocks },
    source: { size: args.bytes.length, readRange: async (offset, size) => args.bytes.slice(offset, offset + size) },
  });
}

/** Caller must clear the returned plaintext once decoded. */
export async function readEncryptedRecord(source: EncryptedFileSource, folderKey: Uint8Array, name: string, signal?: AbortSignal) {
  assertReplicaPath(name);
  if (!isInternalReplicaPath(name)) throw new Error("Encrypted record must be private.");
  const encryptedName = await encryptUntrustedFilename(folderKey, name);
  const metadata = await loadEncryptedDiskMetadata(source, encryptedName, folderKey, signal);
  let bytes = new Uint8Array();
  try {
    const size = Number(metadata.fileInfo.size);
    if (size > 64 * 1024 * 1024) throw new Error("Encrypted record exceeds the supported storage limit.");
    bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 131072) {
      const chunk = await readEncryptedDiskRange(source, metadata, offset, Math.min(131072, size - offset), signal);
      try { bytes.set(chunk, offset); } finally { chunk.fill(0); }
    }
    return bytes;
  } catch (error) { bytes.fill(0); throw error; }
  finally { metadata.fileKey.fill(0); }
}
