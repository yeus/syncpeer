export { RemoteFs } from "./core/model/remoteFs.js";
export type { FolderInfo, FileEntry, FileBlock } from "./core/model/remoteFs.js";

export async function connectAndSync(): Promise<never> {
  throw new Error(
    "connectAndSync is not available in browser builds. " +
      "The current BEP transport requires Node APIs (tls/fs/crypto). " +
      "Use the CLI or call a backend/Tauri command instead.",
  );
}
