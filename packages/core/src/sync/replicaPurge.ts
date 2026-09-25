import type { createNativeFilesystem } from "./nativeFilesystem.js";

type Storage = Pick<Awaited<ReturnType<typeof createNativeFilesystem>>,
  "withLock" | "checkHealth" | "stat" | "listDirectory" | "remove">;

/** Remove only an app-owned replica's local bytes after its controller has been closed. */
export async function purgePrivateReplicaContents(storage: Storage): Promise<void> {
  await storage.withLock(async () => {
    await storage.checkHealth();
    if ((await storage.stat(".stfolder"))?.type !== "directory") {
      throw new Error("Private replica marker is unavailable; local copy was not removed.");
    }
    const removeEntry = async (entry: Awaited<ReturnType<Storage["listDirectory"]>>[number]): Promise<void> => {
      if (entry.type === "directory") {
        for (const child of await storage.listDirectory(entry.path)) await removeEntry(child);
      }
      await storage.remove(entry.path, entry.type === "directory");
    };
    const entries = (await storage.listDirectory("")).filter(entry =>
      entry.path !== ".stfolder" && entry.path !== ".syncpeer-replica.lock");
    for (const entry of entries.filter(entry => !entry.path.startsWith(".syncpeer-"))) await removeEntry(entry);
    for (const entry of entries.filter(entry => entry.path.startsWith(".syncpeer-"))) await removeEntry(entry);
    await storage.checkHealth();
  });
}
