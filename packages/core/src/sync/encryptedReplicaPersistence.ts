import type { writeEncryptedDiskFile, EncryptedFileSource } from "./encryptedFilesystem.js";
import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import { encodeReplicaIndex, decodeReplicaIndex } from "./replicaPersistence.js";
import type { ReplicaIndex } from "./replicaIndex.js";

/** Private record: never include this file in the replicated namespace. */
export async function saveEncryptedReplicaIndex(args: Pick<Parameters<typeof writeEncryptedDiskFile>[0], "folderKey" | "randomBytes" | "createSink" | "signal"> & {
  index: ReplicaIndex;
}) {
  const bytes = encodeReplicaIndex(args.index);
  try {
    return await writeEncryptedRecord({ ...args, name: ".syncpeer-replica-index", bytes });
  } finally { bytes.fill(0); }
}

/** Read from a stable storage snapshot; authentication failure must not become an empty index. */
export async function loadEncryptedReplicaIndex(source: EncryptedFileSource, folderKey: Uint8Array, signal?: AbortSignal) {
  const bytes = await readEncryptedRecord(source, folderKey, ".syncpeer-replica-index", signal);
  try {
    return decodeReplicaIndex(bytes);
  } finally { bytes.fill(0); }
}
