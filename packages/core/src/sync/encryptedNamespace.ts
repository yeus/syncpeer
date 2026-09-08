import type { BepFileInfo } from "../core/protocol/bep.js";
import { decryptEncryptedFilename, encryptUntrustedFilename, isEncryptedPathPrefix } from "../core/model/untrusted.js";
import { loadEncryptedDiskMetadata } from "./encryptedFilesystem.js";
import type { ReplicaSource } from "./replicaIndex.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";

export interface EncryptedNamespaceEntry {
  fileInfo: BepFileInfo;
  storedPath?: string;
  revision?: string;
  /** Name-only directories may represent upstream symlinks; no target is available on disk. */
  metadata: "authenticated" | "name-only" | "inferred";
}

export const addNamespaceEntry = (entries: Map<string, EncryptedNamespaceEntry>, entry: EncryptedNamespaceEntry) => {
  const name = entry.fileInfo.name;
  const previous = entries.get(name);
  if (previous && (previous.fileInfo.type !== 1 || entry.fileInfo.type !== 1 || previous.metadata !== "inferred")) {
    throw new Error("Conflicting encrypted namespace entries.");
  }
  const parts = name.split("/");
  for (let count = 1; count < parts.length; count++) {
    const parent = parts.slice(0, count).join("/");
    const existing = entries.get(parent);
    if (existing && existing.fileInfo.type !== 1) throw new Error("Encrypted file conflicts with a parent directory.");
    if (!existing) entries.set(parent, { fileInfo: { name: parent, type: 1, size: 0 }, metadata: "inferred" });
  }
  entries.set(name, entry);
};

/** Build a plaintext view in memory using metadata only, never retaining per-file keys. */
export async function readEncryptedNamespace(source: ReplicaSource, folderKey: Uint8Array, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const storedEntries = (await source.listEntries()).filter(entry => !isInternalReplicaPath(entry.path));
  const paths = new Set<string>();
  for (const entry of storedEntries) {
    assertReplicaPath(entry.path);
    if (paths.has(entry.path)) throw new Error("Duplicate encrypted storage path.");
    paths.add(entry.path);
  }
  const entries = new Map<string, EncryptedNamespaceEntry>([["", { fileInfo: { name: "", type: 1, size: 0 }, metadata: "inferred" }]]);
  for (const stored of storedEntries) {
    signal?.throwIfAborted();
    if (stored.type === "directory") {
      if (isEncryptedPathPrefix(stored.path)) continue;
      const name = await decryptEncryptedFilename(folderKey, stored.path);
      if (await encryptUntrustedFilename(folderKey, name) !== stored.path) throw new Error("Noncanonical encrypted directory name.");
      assertReplicaPath(name);
      addNamespaceEntry(entries, { fileInfo: { name, type: 1, size: 0 }, storedPath: stored.path, revision: stored.revision, metadata: "name-only" });
      continue;
    }
    if (stored.type !== "file") throw new Error("Unsupported encrypted storage entry; symlinks are not followed.");
    const metadata = await loadEncryptedDiskMetadata({ size: stored.size,
      readRange: (offset, size) => source.readRange(stored.path, offset, size),
    }, stored.path, folderKey, signal);
    try {
      if (await encryptUntrustedFilename(folderKey, metadata.fileInfo.name) !== stored.path) throw new Error("Noncanonical encrypted file name.");
      addNamespaceEntry(entries, { fileInfo: metadata.fileInfo, storedPath: stored.path, revision: stored.revision, metadata: "authenticated" });
    } finally { metadata.fileKey.fill(0); }
  }
  signal?.throwIfAborted();
  return entries;
}
