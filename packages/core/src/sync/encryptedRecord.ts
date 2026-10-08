import { sha256 } from "@noble/hashes/sha2.js";
import { encryptUntrustedFilename } from "../core/model/untrusted.js";
import { loadEncryptedDiskMetadata, readEncryptedDiskRange, writeEncryptedDiskFile, type EncryptedFileSource } from "./encryptedFilesystem.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

/** Private records use the same Syncthing file encoding as file contents. */
export async function writeEncryptedRecord(args: Pick<Parameters<typeof writeEncryptedDiskFile>[0], "folderKey" | "randomBytes" | "createSink" | "signal"> & {
  name: string; bytes: Uint8Array;
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
}) {
  assertReplicaPath(args.name);
  if (!isInternalReplicaPath(args.name)) throw new Error("Encrypted record must be private.");
  if (args.bytes.length > 64 * 1024 * 1024) throw new Error("Encrypted record exceeds the supported storage limit.");
  const blocks = [];
  for (let offset = 0; offset < args.bytes.length; offset += 131072) {
    const chunk = args.bytes.subarray(offset, offset + 131072);
    blocks.push({ offset, size: chunk.length, hash: sha256(chunk) });
  }
  const common = {
    folderKey: args.folderKey, randomBytes: args.randomBytes, signal: args.signal,
    fileInfo: { name: args.name, type: 0, size: args.bytes.length, block_size: 131072, blocks },
    source: { size: args.bytes.length, readRange: async (offset: number, size: number) => args.bytes.slice(offset, offset + size) },
  };
  if (!args.writeFile || args.bytes.length > 1024 * 1024) {
    return writeEncryptedDiskFile({ ...common, createSink: args.createSink });
  }
  let encoded: Uint8Array | undefined;
  try {
    const encrypted = await writeEncryptedDiskFile({ ...common, createSink: async (_info, size) => {
      if (size > 2 * 1024 * 1024) throw new Error("Encrypted record exceeds the native whole-file limit.");
      encoded = new Uint8Array(size);
      return {
        write: async (offset: number, bytes: Uint8Array) => { encoded!.set(bytes, offset); },
        commit: async () => {},
        abort: async () => { encoded?.fill(0); },
      };
    } });
    if (!encoded) throw new Error("Encrypted record was not produced.");
    await args.writeFile(args.name, encoded);
    return encrypted;
  } finally { encoded?.fill(0); }
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
