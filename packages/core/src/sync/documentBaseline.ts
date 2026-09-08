import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readEncryptedRecord, writeEncryptedRecord } from "./encryptedRecord.js";
import type { ReplicaByteStorage } from "./encryptedReplicaStorage.js";
import type { CachedFileRecord } from "../ui/browserClient.js";
import { encryptUntrustedFilename } from "../core/model/untrusted.js";

const nameFor = async (path: string, key: Uint8Array) => ".syncpeer-baseline-" +
  bytesToHex(sha256(new TextEncoder().encode(await encryptUntrustedFilename(key, path))));
const validate = (value: NonNullable<CachedFileRecord["syncBaseline"]>) => {
  if (!value || !/^[a-f0-9]{64}$/.test(value.hash) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 ||
    !Number.isSafeInteger(value.modifiedMs) || value.modifiedMs < 0) throw new Error("Invalid document sync baseline.");
  return { hash: value.hash, sizeBytes: value.sizeBytes, modifiedMs: value.modifiedMs };
};

export async function loadDocumentBaseline(bytes: ReplicaByteStorage, folderKey: Uint8Array, path: string) {
  const name = await nameFor(path, folderKey), entry = await bytes.stat(name);
  if (!entry) return undefined;
  if (entry.type !== "file" || entry.size > 65536) throw new Error("Invalid document sync baseline.");
  const data = await readEncryptedRecord({ size: entry.size, readRange: (offset, size) => bytes.readRange(name, offset, size) }, folderKey, name);
  try { return validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))); }
  finally { data.fill(0); }
}

export async function saveDocumentBaseline(bytes: ReplicaByteStorage, options: {
  path: string; folderKey: Uint8Array; randomBytes: (size: number) => Uint8Array | Promise<Uint8Array>;
  baseline: NonNullable<CachedFileRecord["syncBaseline"]>;
}) {
  const name = await nameFor(options.path, options.folderKey), data = new TextEncoder().encode(JSON.stringify(validate(options.baseline)));
  try {
    await writeEncryptedRecord({ name, bytes: data, folderKey: options.folderKey, randomBytes: options.randomBytes,
      createSink: (_info, size) => bytes.createSink(name, size) });
    await bytes.flushChanges([name]);
  } finally { data.fill(0); }
}
