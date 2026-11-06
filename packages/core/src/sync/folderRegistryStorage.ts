import { validateRegistrations, type FolderRegistration } from "./folderRegistry.js";
import type { createNativeFilesystem } from "./nativeFilesystem.js";
import type { createCredentialVault } from "./credentialVault.js";
import { readExactEncryptedRange } from "./ciphertextFilesystem.js";

/** Registry ownership stays in the vault; legacy plaintext is deleted only after read-back. */
export function createFolderRegistryStorage(storage: Awaited<ReturnType<typeof createNativeFilesystem>>,
  vault: Pick<ReturnType<typeof createCredentialVault>,
    "registrations" | "saveRegistrations" | "registrationStatus" | "pendingLocalReleases">) {
  const path = ".syncpeer-document-folders";
  const load = async (): Promise<FolderRegistration[]> => {
    await storage.checkHealth();
    const saved = await vault.registrations();
    const entry = await storage.stat(path);
    if (!entry) return saved ?? [];
    if (entry.type !== "file" || entry.size > 1024 * 1024) throw new Error("Invalid document registrations.");
    const bytes = await readExactEncryptedRange({ size: entry.size,
      readRange: (offset, size) => storage.readRange(path, offset, size) }, 0, entry.size);
    const legacy = validateRegistrations(JSON.parse(new TextDecoder().decode(bytes)));
    if (saved !== null && JSON.stringify(saved) !== JSON.stringify(legacy)) {
      throw new Error("Conflicting folder registrations require recovery; legacy data was retained.");
    }
    if (saved === null) await vault.saveRegistrations(legacy);
    if (JSON.stringify(await vault.registrations()) !== JSON.stringify(legacy)) {
      throw new Error("Encrypted folder registration migration could not be verified.");
    }
    await storage.withLock(async () => {
      const current = await storage.stat(path);
      if (current?.revision !== entry.revision) throw new Error("Legacy folder registrations changed during migration.");
      await storage.remove(path, false);
      await storage.flushChanges([path]);
    });
    return legacy;
  };
  return {
    load,
    status: async () => {
      await storage.checkHealth();
      const snapshot = await vault.registrationStatus();
      if (!await storage.stat(path)) return {
        folders: snapshot.registrations ?? [], pendingLocalReleases: snapshot.pendingLocalReleases,
      };
      // Legacy migration must preserve its original conflict/read-back/atomic-delete checks.
      return { folders: await load(), pendingLocalReleases: await vault.pendingLocalReleases() };
    },
    save: (folders: FolderRegistration[]) => vault.saveRegistrations(folders),
  };
}
