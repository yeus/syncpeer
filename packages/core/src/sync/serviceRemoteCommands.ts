import type { SyncpeerSessionHandle } from "../client.js";
import type { FileEntry } from "../core/model/remoteFs.js";

type RemoteReadApi = Pick<SyncpeerSessionHandle["remoteFs"],
  "listFolders" | "getRemoteDeviceInfo" | "listFolderSyncStates" |
  "setFocusedFolder" | "requestFolderIndex" | "waitForFolderIndex" | "readDir" | "listFiles">;

const requireText = (value: unknown, label: string, allowEmpty = false): string => {
  if (typeof value !== "string" || value.length > 4096 || (!allowEmpty && !value)) {
    throw new Error("Invalid remote " + label + ".");
  }
  if (label === "path" && (value.startsWith("/") ||
    value.split("/").some(segment => segment === "." || segment === ".."))) {
    throw new Error("Invalid remote path.");
  }
  return value;
};

const page = (entries: FileEntry[], request: Record<string, unknown>) => {
  const offset = request.offset ?? 0;
  const limit = request.limit ?? 128;
  if (!Number.isInteger(offset) || Number(offset) < 0 ||
    !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 256) {
    throw new Error("Invalid remote page limit or offset.");
  }
  const position = Number(offset);
  let end = Math.min(entries.length, position + Number(limit));
  const render = (until: number) => ({
    entries: entries.slice(position, until).map(entry => ({
      ...entry,
      blocks: entry.blocks?.map(block => ({ ...block, hash: Array.from(block.hash) })),
    })),
    nextOffset: until < entries.length ? until : null,
    total: entries.length,
  });
  let result = render(end);
  // Return bounded metadata directly. Native IPC wraps errors, so relying on
  // a client retry with a smaller limit can silently fail for large indexes.
  while (new TextEncoder().encode(JSON.stringify(result)).length > 512 * 1024 &&
    end - position > 1) {
    end = position + Math.max(1, Math.floor((end - position) / 2));
    result = render(end);
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 512 * 1024) {
    throw new Error("Remote directory entry is too large for the Android IPC boundary.");
  }
  return result;
};

export async function executeServiceRemoteCommand(
  session: Pick<SyncpeerSessionHandle, "remoteDeviceId" | "connectedVia" | "transportKind" | "connectionScope"> &
    { remoteFs: RemoteReadApi },
  request: Record<string, unknown>,
) {
  const remoteFs = session.remoteFs;
  switch (request.operation) {
    case "overview": {
      const [folders, device, folderSyncStates] = await Promise.all([
        remoteFs.listFolders(),
        Promise.resolve(remoteFs.getRemoteDeviceInfo()),
        Promise.resolve(remoteFs.listFolderSyncStates()),
      ]);
      return { folders, device, folderSyncStates, connectedVia: session.connectedVia,
        transportKind: session.transportKind, connectionScope: session.connectionScope };
    }
    case "listFolders": return remoteFs.listFolders();
    case "setFocusedFolder": {
      if (request.folderId !== null && (typeof request.folderId !== "string" ||
        !request.folderId || request.folderId.length > 4096)) {
        throw new Error("Invalid focused remote folder.");
      }
      remoteFs.setFocusedFolder(request.folderId as string | null);
      return { focused: request.folderId };
    }
    case "requestFolderIndex": {
      await remoteFs.requestFolderIndex(requireText(request.folderId, "folder"));
      return { requested: true };
    }
    case "waitForFolderIndex": {
      const folderId = requireText(request.folderId, "folder");
      const timeoutMs = request.timeoutMs === undefined ? 3000 : Number(request.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) {
        throw new Error("Invalid remote index timeout.");
      }
      return remoteFs.waitForFolderIndex(folderId, timeoutMs);
    }
    case "readDir": {
      const folderId = requireText(request.folderId, "folder");
      const path = requireText(request.path, "path", true);
      return page(await remoteFs.readDir(folderId, path), request);
    }
    case "listFiles": {
      return page(await remoteFs.listFiles(requireText(request.folderId, "folder")), request);
    }
    default: throw new Error("Unknown remote session command.");
  }
}
