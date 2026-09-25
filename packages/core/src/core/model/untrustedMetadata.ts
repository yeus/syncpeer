import { FileInfo, type BepFileInfo } from "../protocol/bep.js";
import { mergeVersionVectors } from "../protocol/versionVector.js";
import { decryptEncryptedFilename, decryptUntrustedBytes, deriveUntrustedFileKey, encryptUntrustedFilename, encryptUntrustedBytes, encryptUntrustedBlockHash } from "./untrusted.js";

const safeNonnegativeInteger = (value: unknown, label: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid encrypted metadata ${label}.`);
  return result;
};

/** Syncthing's opaque wrapper is shared by BEP publication and disk trailers. */
export async function encryptUntrustedFileInfo(folderKey: Uint8Array, file: BepFileInfo, nonce: Uint8Array): Promise<BepFileInfo> {
  const fileKey = deriveUntrustedFileKey(folderKey, file.name);
  const counters = mergeVersionVectors(file.version ?? {}, {}).counters ?? [];
  const version = counters.reduce((sum, counter) => sum + BigInt(counter.value), 0n);
  let size = 0;
  const blocks = (file.blocks ?? []).map(block => {
    const encrypted = { offset: size, size: Math.max(1024, block.size) + 40,
      hash: encryptUntrustedBlockHash(fileKey, block.hash, Number(block.offset)) };
    size += encrypted.size;
    return encrypted;
  });
  const regular = Number(file.type ?? 0) === 0;
  return {
    name: await encryptUntrustedFilename(folderKey, file.name),
    type: regular ? 0 : 1,
    permissions: 0o644,
    modified_s: 1234567890,
    deleted: file.deleted ?? false,
    invalid: file.invalid ?? false,
    sequence: file.sequence,
    version: { counters: [{ id: "1", value: String(BigInt.asUintN(64, version)) }] },
    ...(regular ? { size, blocks, block_size: (file.block_size || 131072) + 40 } : {}),
    encrypted: encryptUntrustedBytes(fileKey, FileInfo.encode(file).finish(), nonce),
  };
}

/** The same authenticated metadata is used by BEP and encrypted on-disk trailers. */
export async function decryptUntrustedFileInfo(folderKey: Uint8Array, encrypted: BepFileInfo) {
  if (!(encrypted.encrypted instanceof Uint8Array) || !encrypted.encrypted.length) throw new Error("Encrypted metadata is missing.");
  const name = await decryptEncryptedFilename(folderKey, encrypted.name);
  const fileKey = deriveUntrustedFileKey(folderKey, name);
  const decoded = FileInfo.decode(decryptUntrustedBytes(fileKey, encrypted.encrypted)) as unknown as BepFileInfo;
  if (decoded.name !== name) throw new Error("Authenticated file name does not match encrypted name.");
  const fileInfo: BepFileInfo = { ...decoded,
    size: decoded.size === undefined ? undefined : safeNonnegativeInteger(decoded.size, "size"),
    blocks: decoded.blocks?.map(block => ({ ...block,
      offset: safeNonnegativeInteger(block.offset, "block offset"),
      size: safeNonnegativeInteger(block.size, "block size") })),
    sequence: encrypted.sequence === undefined ? undefined : String(encrypted.sequence),
    version: decoded.version ? { counters: decoded.version.counters?.map(counter => ({
      id: String(counter.id), value: String(counter.value) })) } : undefined,
  };
  return { fileKey, fileInfo };
}
