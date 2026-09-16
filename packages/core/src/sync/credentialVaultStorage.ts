import type { CredentialVaultRecord } from "./credentialVault.js";
import type { PersonalSpaceBootstrap } from "./personalSpaceBootstrap.js";
import type { ReplicaByteStorage } from "./encryptedReplicaStorage.js";
import type { ReplicaStorage } from "./replicaStorage.js";
import { readExactEncryptedRange, writeCiphertextRange } from "./ciphertextFilesystem.js";

const createPrivateJsonRecordStorage = <T>(path: string,
  bytes: Pick<ReplicaByteStorage, "stat" | "readRange" | "createSink" | "flushChanges" | "remove">,
  options: { withLock: ReplicaStorage["withLock"]; checkHealth: () => Promise<void> }) => {
  return {
    withLock: options.withLock,
    load: async (): Promise<unknown> => {
      await options.checkHealth();
      const stat = await bytes.stat(path);
      if (!stat) return null;
      if (stat.type !== "file" || stat.size > 16 * 1024 * 1024) throw new Error("Invalid or oversized credential record.");
      const content = await readExactEncryptedRange({ size: stat.size,
        readRange: (offset, size) => bytes.readRange(path, offset, size) }, 0, stat.size);
      const after = await bytes.stat(path);
      if (!after || after.revision !== stat.revision || after.size !== stat.size) throw new Error("Credential record changed during read.");
      await options.checkHealth();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
    },
    save: async (record: T) => {
      await options.checkHealth();
      const content = new TextEncoder().encode(JSON.stringify(record));
      if (content.length > 16 * 1024 * 1024) throw new Error("Credential record capacity exceeded.");
      const sink = await bytes.createSink(path, content.length);
      try {
        await writeCiphertextRange(sink, 0, content, () => {});
        await options.checkHealth();
        await sink.commit();
        await bytes.flushChanges([path]);
      } catch (error) { await sink.abort(error); throw error; }
    },
    remove: async () => {
      await options.checkHealth();
      if (await bytes.stat(path)) await bytes.remove(path, false);
      await bytes.flushChanges([path]);
    },
  };
};

/** Atomic private vault record; ciphertext and manual-lock intent are one publication. */
export function createCredentialVaultStorage(bytes: Pick<ReplicaByteStorage, "stat" | "readRange" | "createSink" | "flushChanges" | "remove">,
  options: { withLock: ReplicaStorage["withLock"]; checkHealth: () => Promise<void> }) {
  return createPrivateJsonRecordStorage<CredentialVaultRecord>(".syncpeer-vault-record", bytes, options);
}

/** Password-wrapped recovery record; never contains readable space or folder IDs. */
export function createPersonalSpaceBootstrapStorage(bytes: Pick<ReplicaByteStorage, "stat" | "readRange" | "createSink" | "flushChanges" | "remove">,
  options: { withLock: ReplicaStorage["withLock"]; checkHealth: () => Promise<void> }) {
  return createPrivateJsonRecordStorage<PersonalSpaceBootstrap>(".syncpeer-space", bytes, options);
}
