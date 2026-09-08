import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { FileInfo, type BepFileInfo } from "../core/protocol/bep.js";
import { mergeVersionVectors } from "../core/protocol/versionVector.js";
import { readExactEncryptedRange, validateCiphertextMetadata, writeCiphertextRange, type EncryptedFileSource } from "./ciphertextFilesystem.js";
import type { FileDownloadSink } from "../transfer/stream.js";

export interface CiphertextFolderIdentity {
  folderId: string;
  passwordToken: Uint8Array;
}

export interface CiphertextIndex {
  format: 1;
  identity: CiphertextFolderIdentity;
  sequence: number;
  /** IDs name immutable generations, not user-visible conflict filenames. */
  versions: Record<string, { info: BepFileInfo; revision: string; verification: "pending-unlock" }>;
  pending?: { id: string; info: BepFileInfo };
}

/** BEP has one current entry per name. Preserve all alternatives in the private index. */
export function selectCiphertextPublication(index: CiphertextIndex) {
  const selected = new Map<string, { id: string; info: BepFileInfo }>();
  for (const [id, entry] of Object.entries(index.versions)) {
    if (entry.info.invalid) continue;
    const previous = selected.get(entry.info.name);
    const counter = BigInt(String(entry.info.version!.counters![0].value));
    const older = previous ? BigInt(String(previous.info.version!.counters![0].value)) : -1n;
    if (counter > older || (counter === older && id > previous!.id)) selected.set(entry.info.name, { id, info: entry.info });
  }
  return [...selected.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
}

const validateIdentity = (identity: CiphertextFolderIdentity) => {
  if (!identity || typeof identity.folderId !== "string" || !identity.folderId.length || identity.folderId.length > 1024 ||
    !(identity.passwordToken instanceof Uint8Array) || identity.passwordToken.length < 16 || identity.passwordToken.length > 4096) {
    throw new Error("Invalid encrypted folder identity.");
  }
};

const requireIdentity = (actual: CiphertextFolderIdentity, expected: CiphertextFolderIdentity) => {
  validateIdentity(actual);
  validateIdentity(expected);
  if (actual.folderId !== expected.folderId || !equalBytes(actual.passwordToken, expected.passwordToken)) {
    throw new Error("Encrypted folder identity mismatch.");
  }
};

const descriptorBytes = (info: BepFileInfo) => {
  validateCiphertextMetadata(info);
  const counters = mergeVersionVectors(info.version ?? {}, {}).counters ?? [];
  if (counters.length !== 1 || counters[0].id !== "1") throw new Error("Invalid opaque encrypted version.");
  // Remote sequence numbers are not causal history or stable generation IDs.
  return FileInfo.encode({ ...info, version: { counters }, sequence: 0 }).finish();
};

const generationId = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

export function createCiphertextIndex(identity: CiphertextFolderIdentity): CiphertextIndex {
  validateIdentity(identity);
  return { format: 1, identity: { folderId: identity.folderId, passwordToken: identity.passwordToken.slice() },
    sequence: 0, versions: Object.create(null) };
}

/** Persist this journal before receiving bytes. Caller holds the root transaction lock. */
export function prepareCiphertextUpdate(index: CiphertextIndex, identity: CiphertextFolderIdentity, info: BepFileInfo): CiphertextIndex {
  requireIdentity(index.identity, identity);
  if (index.pending) throw new Error("Encrypted update is already pending recovery.");
  const bytes = descriptorBytes(info);
  const id = generationId(bytes);
  if (Object.hasOwn(index.versions, id)) return index;
  if (index.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Encrypted index sequence exhausted.");
  return { ...index, pending: { id, info: FileInfo.decode(bytes) as unknown as BepFileInfo } };
}

/** Call only after the immutable generation is durably published; persist before advertising. */
export function completeCiphertextUpdate(index: CiphertextIndex, id: string, revision: string): CiphertextIndex {
  if (!index.pending || index.pending.id !== id || typeof revision !== "string" || !revision.length) {
    throw new Error("Encrypted transaction does not match pending publication.");
  }
  const sequence = index.sequence + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error("Encrypted index sequence exhausted.");
  const encoded = descriptorBytes(index.pending.info);
  if (generationId(encoded) !== id) throw new Error("Encrypted generation identity mismatch.");
  const info = FileInfo.decode(encoded) as unknown as BepFileInfo;
  info.sequence = sequence;
  return { format: 1, identity: index.identity, sequence,
    versions: { ...index.versions, [id]: { info, revision, verification: "pending-unlock" } } };
}

/** Opaque metadata only. Store inside private app storage; this is not a public diagnostic. */
export function encodeCiphertextIndex(index: CiphertextIndex): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 1, identity: {
    folderId: index.identity.folderId, passwordToken: Array.from(index.identity.passwordToken),
  }, sequence: index.sequence, versions: Object.entries(index.versions).map(([id, value]) => ({
    id, revision: value.revision, sequence: Number(value.info.sequence), info: Array.from(descriptorBytes(value.info)),
  })), ...(index.pending ? { pending: { id: index.pending.id, info: Array.from(descriptorBytes(index.pending.info)) } } : {}) }));
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Encrypted index capacity exceeded; unlock and reconcile history.");
  // Keep writer validation identical to restart validation.
  decodeCiphertextIndex(bytes, index.identity);
  return bytes;
}

const storedBytes = (value: unknown) => {
  if (!Array.isArray(value) || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("Invalid encrypted index bytes.");
  }
  return new Uint8Array(value);
};

const storedDescriptor = (value: { id?: unknown; info?: unknown }) => {
  if (!value || typeof value.id !== "string") throw new Error("Invalid encrypted generation.");
  const info = FileInfo.decode(storedBytes(value.info)) as unknown as BepFileInfo;
  if (generationId(descriptorBytes(info)) !== value.id) throw new Error("Encrypted generation identity mismatch.");
  return { id: value.id, info };
};

export function decodeCiphertextIndex(bytes: Uint8Array, expected: CiphertextFolderIdentity): CiphertextIndex {
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Encrypted index capacity exceeded.");
  const stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!stored || stored.format !== 1 || !Number.isSafeInteger(stored.sequence) || stored.sequence < 0 ||
    !stored.identity || !Array.isArray(stored.versions)) throw new Error("Invalid encrypted index.");
  const index = createCiphertextIndex({ folderId: stored.identity.folderId, passwordToken: storedBytes(stored.identity.passwordToken) });
  requireIdentity(index.identity, expected);
  index.sequence = stored.sequence;
  const sequences = new Set<number>();
  for (const value of stored.versions) {
    const { id, info } = storedDescriptor(value);
    if (Object.hasOwn(index.versions, id) || typeof value.revision !== "string" || !value.revision.length ||
      !Number.isSafeInteger(value.sequence) || value.sequence <= 0 || value.sequence > index.sequence || sequences.has(value.sequence)) {
      throw new Error("Invalid encrypted generation history.");
    }
    sequences.add(value.sequence);
    info.sequence = value.sequence;
    index.versions[id] = { info, revision: value.revision, verification: "pending-unlock" };
  }
  if (stored.pending !== undefined) {
    index.pending = storedDescriptor(stored.pending);
    if (Object.hasOwn(index.versions, index.pending.id)) throw new Error("Encrypted pending generation is already committed.");
  }
  return index;
}

export async function loadCiphertextIndex(source: EncryptedFileSource, expected: CiphertextFolderIdentity, signal?: AbortSignal) {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > 64 * 1024 * 1024) {
    throw new Error("Invalid or oversized encrypted index.");
  }
  return decodeCiphertextIndex(await readExactEncryptedRange(source, 0, source.size, signal), expected);
}

/** Host supplies staging and durable atomic commit; it must hold the root lock. */
export async function saveCiphertextIndex(index: CiphertextIndex,
  createSink: (size: number) => Promise<Pick<FileDownloadSink, "write" | "commit" | "abort">>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bytes = encodeCiphertextIndex(index);
  const sink = await createSink(bytes.length);
  try {
    await writeCiphertextRange(sink, 0, bytes, () => signal?.throwIfAborted());
    signal?.throwIfAborted();
    await sink.commit();
  } catch (error) { await sink.abort(error); throw error; }
}
