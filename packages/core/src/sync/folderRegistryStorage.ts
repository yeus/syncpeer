import type { FolderRegistration } from "./folderRegistry.js";
import type { createNativeFilesystem } from "./nativeFilesystem.js";
import { readExactEncryptedRange, writeCiphertextRange } from "./ciphertextFilesystem.js";

/** Registration metadata is private app configuration; passwords belong in the vault. */
export function createFolderRegistryStorage(storage: Awaited<ReturnType<typeof createNativeFilesystem>>) {
  const path = ".syncpeer-document-folders";
  return {
    load: async (): Promise<FolderRegistration[]> => {
      await storage.checkHealth();
      const entry = await storage.stat(path);
      if (!entry) return [];
      if (entry.type !== "file" || entry.size > 1024 * 1024) throw new Error("Invalid document registrations.");
      const bytes = await readExactEncryptedRange({ size: entry.size,
        readRange: (offset, size) => storage.readRange(path, offset, size) }, 0, entry.size);
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    save: (folders: FolderRegistration[]) => storage.withLock(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(folders));
      if (bytes.length > 1024 * 1024) throw new Error("Document registration limit exceeded.");
      const sink = await storage.createSink(path, bytes.length);
      try {
        await writeCiphertextRange(sink, 0, bytes, () => {});
        await sink.commit();
        await storage.flushChanges([path]);
      } catch (error) { await sink.abort(error); throw error; }
    }),
  };
}
