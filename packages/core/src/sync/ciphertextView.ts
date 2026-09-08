import { equalBytes } from "@noble/ciphers/utils.js";
import { FileInfo, type BepFileInfo } from "../core/protocol/bep.js";
import { decryptUntrustedFileInfo } from "../core/model/untrustedMetadata.js";
import { untrustedPasswordToken } from "../core/model/untrusted.js";
import { planReplicaMerge } from "./replicaMerge.js";
import { assertReplicaPath, isInternalReplicaPath } from "./replicaPaths.js";
import { addNamespaceEntry, type EncryptedNamespaceEntry } from "./encryptedNamespace.js";
import { loadEncryptedDiskMetadata, readEncryptedDiskRange } from "./encryptedFilesystem.js";
import type { createCiphertextReplica } from "./ciphertextReplica.js";
import type { CiphertextIndex } from "./ciphertextIndex.js";

/** Resolve using authenticated vectors, never the opaque outer version counter. */
async function reconcile(index: CiphertextIndex, folderKey: Uint8Array, check: () => void) {
  const files = new Map<string, { id: string; fileInfo: BepFileInfo; encryptedName: string }>();
  const history = Object.entries(index.versions).sort(([, a], [, b]) => Number(a.info.sequence) - Number(b.info.sequence));
  for (const [id, entry] of history) {
    check();
    const decoded = await decryptUntrustedFileInfo(folderKey, entry.info);
    try {
      check();
      const file = decoded.fileInfo;
      assertReplicaPath(file.name);
      if (isInternalReplicaPath(file.name) || ![0, 1].includes(Number(file.type ?? 0))) throw new Error("Unsupported authenticated entry.");
      const previous = files.get(file.name);
      const merge = planReplicaMerge(previous?.fileInfo, file);
      if (merge.action === "keep") continue;
      const remote = { id, fileInfo: file, encryptedName: entry.info.name };
      const chosen = merge.source === "local" ? previous! : remote;
      if (merge.conflict) {
        if (files.has(merge.conflict.name)) throw new Error("Authenticated conflict name already exists.");
        const loser = merge.source === "local" ? remote : previous!;
        files.set(merge.conflict.name, { ...loser, fileInfo: merge.conflict });
      }
      files.set(file.name, { ...chosen, fileInfo: merge.winner });
    } finally { decoded.fileKey.fill(0); }
  }
  return files;
}

/** An immutable authenticated read view; closing revokes in-flight and future reads. */
export async function openCiphertextView(replica: Pick<ReturnType<typeof createCiphertextReplica>, "snapshot" | "openGeneration">,
  folderKey: Uint8Array, signal?: AbortSignal) {
  const key = folderKey.slice();
  let closed = false;
  const check = () => {
    if (closed) throw new Error("Encrypted view is closed.");
    signal?.throwIfAborted();
  };
  try {
    check();
    const index = await replica.snapshot();
    if (!equalBytes(untrustedPasswordToken(index.identity.folderId, key), index.identity.passwordToken)) {
      throw new Error("Encrypted view key does not match folder identity.");
    }
    const files = await reconcile(index, key, check);
    const namespace = new Map<string, EncryptedNamespaceEntry>([["", { fileInfo: { name: "", type: 1, size: 0 }, metadata: "inferred" }]]);
    for (const entry of files.values()) if (!entry.fileInfo.deleted) {
      addNamespaceEntry(namespace, { fileInfo: entry.fileInfo, metadata: "authenticated" });
    }
    check();
    return {
      sequence: index.sequence,
      list: () => {
        check();
        return new Map([...namespace].map(([name, entry]) => [name, { ...entry,
          fileInfo: FileInfo.decode(FileInfo.encode(entry.fileInfo).finish()) as unknown as BepFileInfo }]));
      },
      readRange: async (path: string, offset: number, size: number) => {
        check();
        const entry = files.get(path);
        if (!entry || entry.fileInfo.deleted || Number(entry.fileInfo.type ?? 0) !== 0) throw new Error("Encrypted view file unavailable.");
        const source = await replica.openGeneration(entry.id);
        check();
        const metadata = await loadEncryptedDiskMetadata(source, entry.encryptedName, key, signal);
        let data: Uint8Array | undefined;
        try {
          check();
          data = await readEncryptedDiskRange(source, metadata, offset, size, signal);
          check();
          return data;
        } catch (error) { data?.fill(0); throw error; }
        finally { metadata.fileKey.fill(0); }
      },
      close: () => { closed = true; key.fill(0); files.clear(); namespace.clear(); },
    };
  } catch (error) { key.fill(0); throw error; }
}
