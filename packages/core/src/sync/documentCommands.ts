import type { createDocumentFilesystem } from "./documentFilesystem.js";

/** Validate the native/UI boundary before dispatching to the one document owner. */
export async function dispatchDocumentCommand(documents: ReturnType<typeof createDocumentFilesystem>, input: unknown): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid document command.");
  const command = input as Record<string, unknown>;
  const text = (field: string) => {
    const value = command[field];
    if (typeof value !== "string" || !value.length || value.length > 4096) throw new Error("Invalid document argument.");
    return value;
  };
  const integer = (field: string) => {
    const value = command[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid document range.");
    return value;
  };
  const ranges = () => {
    if (!Array.isArray(command.ranges) || command.ranges.length > 256) throw new Error("Invalid document ranges.");
    return command.ranges.map(value => {
      if (!value || typeof value !== "object") throw new Error("Invalid document range.");
      return { offset: value.offset as number, size: value.size as number };
    });
  };
  switch (command.operation) {
    case "status": case "cacheRegistrations": return documents.status();
    case "connectionPasswords": return documents.connectionPasswords();
    case "sessionSharedFolders": {
      if (!command.passwords || typeof command.passwords !== "object" || Array.isArray(command.passwords) ||
        Object.entries(command.passwords).some(([id, password]) => !id || id.length > 4096 ||
          typeof password !== "string" || password.length > 4096)) {
        throw new Error("Invalid folder credentials.");
      }
      return documents.sessionSharedFolders(command.passwords as Record<string, string>);
    }
    case "profileSettings": return documents.profileSettings();
    case "loadDirectorySnapshot": return documents.loadDirectorySnapshot(text("folderId"), text("sourceDeviceId"),
      command.path === "" ? "" : text("path"));
    case "saveDirectorySnapshot": {
      if (!command.snapshot || typeof command.snapshot !== "object" || Array.isArray(command.snapshot)) {
        throw new Error("Invalid directory snapshot.");
      }
      return documents.saveDirectorySnapshot(text("folderId"), text("sourceDeviceId"),
        command.path === "" ? "" : text("path"), command.snapshot as Parameters<typeof documents.saveDirectorySnapshot>[3]);
    }
    case "enforceCacheQuota": return documents.enforceCacheQuota();
    case "saveProfileSettings": {
      if (!command.settings || typeof command.settings !== "object" || Array.isArray(command.settings)) {
        throw new Error("Invalid profile settings.");
      }
      return documents.saveProfileSettings(command.settings as Parameters<typeof documents.saveProfileSettings>[0]);
    }
    case "saveConnectionPasswords": {
      if (!command.passwords || typeof command.passwords !== "object" || Array.isArray(command.passwords)) throw new Error("Invalid credentials.");
      return documents.saveConnectionPasswords(command.passwords as Record<string, string>);
    }
    case "mergeConnectionPasswords": {
      if (!command.passwords || typeof command.passwords !== "object" || Array.isArray(command.passwords)) throw new Error("Invalid credentials.");
      return documents.mergeConnectionPasswords(command.passwords as Record<string, string>);
    }
    case "exportRecoveryBackup": return documents.exportRecoveryBackup(text("password"));
    case "exportPairingTransfer": return documents.exportPairingTransfer();
    case "importPairingTransfer": {
      if (!command.transfer || typeof command.transfer !== "object" || Array.isArray(command.transfer) ||
        (command.remember !== undefined && typeof command.remember !== "boolean")) {
        throw new Error("Invalid personal-space pairing transfer.");
      }
      return documents.importPairingTransfer(command.transfer as Parameters<typeof documents.importPairingTransfer>[0],
        text("password"), command.remember !== false);
    }
    case "restoreRecoveryBackup": {
      if (!command.backup || typeof command.backup !== "object" || Array.isArray(command.backup)) {
        throw new Error("Invalid personal-space recovery backup.");
      }
      return documents.restoreRecoveryBackup(command.backup as Parameters<typeof documents.restoreRecoveryBackup>[0],
        text("recoveryPassword"), text("password"));
    }
    case "uiState": return documents.uiState();
    case "saveUiState": {
      const state = command.state ?? null;
      if (state !== null) {
        const encoded = JSON.stringify(state);
        if (typeof encoded !== "string" || encoded.length > 512 * 1024) throw new Error("Invalid UI state record.");
      }
      return documents.saveUiState(state);
    }
    case "rememberFolder": return documents.rememberFolder({ id: text("id"), label: text("label") });
    case "cachedFiles": return documents.cachedFiles();
    case "folderFiles": return documents.cachedFiles(text("folderId"));
    case "cachedStatuses": {
      if (!Array.isArray(command.paths) || command.paths.length > 4096 || command.paths.some(path => typeof path !== "string" || path.length > 4096)) throw new Error("Invalid document paths.");
      return documents.cachedStatuses(text("folderId"), command.paths);
    }
    case "versions": return documents.versions(text("id"));
    case "restoreVersion": return documents.restoreVersion(text("id"), text("versionId"));
    case "favoriteSyncState": return documents.favoriteSyncState(text("folderId"));
    case "clearFavoriteSyncEntry": return documents.clearFavoriteSyncEntry(text("folderId"), text("path"));
    case "recordFavoriteResolution": {
      if (command.resolution !== "keep-local" && command.resolution !== "keep-remote") {
        throw new Error("Invalid favorite conflict resolution.");
      }
      return documents.recordFavoriteResolution(text("folderId"), text("path"), command.resolution);
    }
    case "clearFavoriteRenames": {
      if (!Array.isArray(command.paths) || command.paths.length > 4096 ||
        command.paths.some(path => typeof path !== "string" || path.length > 4096)) throw new Error("Invalid document paths.");
      return documents.clearFavoriteRenames(text("folderId"), command.paths);
    }
    case "saveFavoriteSyncEntries": {
      if (!command.entries || typeof command.entries !== "object" || Array.isArray(command.entries)) {
        throw new Error("Invalid favorite sync entries.");
      }
      return documents.saveFavoriteSyncEntries(text("folderId"),
        command.entries as Parameters<typeof documents.saveFavoriteSyncEntries>[1]);
    }
    case "attachDownloads": return documents.attachDownloads(text("id"));
    case "detachDownloads": return documents.detachDownloads(text("id"));
    case "clearFolderContents": return documents.clearFolderContents(text("folderId"));
    case "beginDownload": {
      if (typeof command.encrypted !== "boolean") throw new Error("Invalid download encryption metadata.");
      return documents.beginDownload(text("folderId"), text("path"), integer("size"), integer("modifiedMs"),
        command.expectedLocalHash === undefined || command.expectedLocalHash === null ? command.expectedLocalHash : text("expectedLocalHash"), {
        encrypted: command.encrypted,
        ...(command.sourceDeviceId === undefined ? {} : { sourceDeviceId: text("sourceDeviceId") }),
        ...(command.contentId === undefined ? {} : { contentId: text("contentId") }),
      });
    }
    case "downloadRanges": return documents.downloadRanges(integer("handle"));
    case "suspendDownload": return documents.suspendDownload(integer("handle"));
    case "finishDownload": return documents.finishDownload(integer("handle"));
    case "digest": return documents.digest(integer("handle"));
    case "copyRanges": return documents.copyRanges(integer("handle"), ranges());
    case "digestRanges": {
      if (command.source !== "cached" && command.source !== "partial") throw new Error("Invalid document source.");
      return (await documents.digestRanges(integer("handle"), command.source, ranges()))
        .map(range => ({ ...range, hash: Array.from(range.hash) }));
    }
    case "remove": return documents.remove(text("id"));
    case "rename": return documents.rename(text("id"), text("name"));
    case "setSyncBaseline": return documents.setSyncBaseline(text("id"), { hash: text("hash"), sizeBytes: integer("sizeBytes"), modifiedMs: integer("modifiedMs") });
    case "createVault": {
      if (command.remember !== undefined && typeof command.remember !== "boolean") throw new Error("Invalid remember setting.");
      return documents.createVault(text("password"), command.remember === true);
    }
    case "unlock": return documents.unlock(text("password"));
    case "unlockRemembered": return documents.unlockRemembered();
    case "changeMasterPassword": return documents.changeMasterPassword(text("password"));
    case "lock": return documents.lock();
    case "register": return documents.register({ id: text("id"), label: text("label"),
      ...(command.password === undefined ? {} : { password: text("password") }) });
    case "stat": return documents.stat(text("id"));
    case "list": return documents.list(text("id"));
    case "create": {
      if (typeof command.directory !== "boolean") throw new Error("Invalid document type.");
      return documents.create(text("id"), text("name"), command.directory);
    }
    case "open": return documents.open(text("id"), text("mode"));
    case "size": return documents.size(integer("handle"));
    case "read": {
      const size = integer("size");
      if (size > 131072) throw new Error("Document read exceeds bridge limit.");
      const bytes = await documents.read(integer("handle"), integer("offset"), size);
      try { return Array.from(bytes); } finally { bytes.fill(0); }
    }
    case "write": {
      const value = command.bytes;
      if (!Array.isArray(value) || value.length > 131072 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("Invalid document bytes.");
      const bytes = new Uint8Array(value);
      try { await documents.write(integer("handle"), integer("offset"), bytes); return bytes.length; }
      finally { bytes.fill(0); value.fill(0); }
    }
    case "flush": return documents.flush(integer("handle"));
    case "release": {
      if (command.abort !== undefined && typeof command.abort !== "boolean") throw new Error("Invalid document release.");
      return documents.release(integer("handle"), command.abort === true);
    }
    default: throw new Error("Unknown document command.");
  }
}
