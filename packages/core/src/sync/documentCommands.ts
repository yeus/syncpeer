import type { createDocumentFilesystem } from "./documentFilesystem.js";

/** Changes that can invalidate a listener's prepared peer-specific folder view. */
export const changesSessionConfiguration = (operation: unknown, path?: unknown): boolean =>
  typeof operation === "string" && !(
    ["savePersonalSpaceSetting", "resolvePersonalSpaceConflict"].includes(operation) &&
    Array.isArray(path) && path.length === 3 && path[0] === "folders" &&
    typeof path[1] === "string" && path[2] === "retention"
  ) && [
    "createVault", "unlock", "unlockRemembered", "lock", "restoreRecoveryBackup",
    "register", "attachDownloads", "detachDownloads", "saveProfileSettings",
    "savePersonalSpaceSetting", "resolvePersonalSpaceConflict", "appendPersonalSpaceChange",
    "importPairingTransfer", "revokeOwnedDevice", "recoverOwnedDevice",
    "saveConnectionPasswords", "mergeConnectionPasswords",
  ].includes(operation);

/** Apply a document command, then invalidate prepared/live peer views only after the mutation succeeds. */
export async function dispatchDocumentCommandWithSessionConfiguration(
  documents: ReturnType<typeof createDocumentFilesystem>,
  input: unknown,
  onSessionConfigurationChange: () => void,
): Promise<unknown> {
  const command = input && typeof input === "object" && !Array.isArray(input)
    ? input as { operation?: unknown; path?: unknown }
    : null;
  const invalidatesSession = changesSessionConfiguration(command?.operation, command?.path);
  const result = await dispatchDocumentCommand(documents, input);
  if (invalidatesSession) onSessionConfigurationChange();
  return result;
}

type Documents = ReturnType<typeof createDocumentFilesystem>;

type DocumentCommandContext = {
  documents: Documents;
  command: Record<string, unknown>;
  text: (field: string) => string;
  integer: (field: string) => number;
  ranges: () => Array<{ offset: number; size: number }>;
  blocks: () => Array<{ offset: number; size: number; hash: Uint8Array }> | undefined;
};

type CommandHandler = (context: DocumentCommandContext) => unknown | Promise<unknown>;

function sessionSharedFolders({ documents, command }: DocumentCommandContext) {
  if (typeof command.remoteDeviceId !== "string" || command.remoteDeviceId.length > 128) {
    throw new Error("Invalid remote device identity.");
  }
  return documents.sessionSharedFolders(command.remoteDeviceId);
}

function savePersonalSpaceSetting({ documents, command }: DocumentCommandContext) {
  if (!Array.isArray(command.path) || command.path.length < 3 || command.path.length > 4 ||
    command.path.some(part => typeof part !== "string" || !part || part.length > 1024)) {
    throw new Error("Invalid shared setting path.");
  }
  if (!Object.hasOwn(command, "value")) throw new Error("Shared setting value is missing.");
  return documents.savePersonalSpaceSetting(command.path as string[], command.value);
}

function resolvePersonalSpaceConflict({ documents, command, text }: DocumentCommandContext) {
  if (!Array.isArray(command.path) || command.path.length < 3 || command.path.length > 4 ||
    command.path.some(part => typeof part !== "string" || !part || part.length > 1024)) {
    throw new Error("Invalid shared setting path.");
  }
  return documents.resolvePersonalSpaceConflict(command.path as string[], text("selectedHead"));
}

function appendPersonalSpaceChange({ documents, command }: DocumentCommandContext) {
  if (!command.change || typeof command.change !== "object" || Array.isArray(command.change)) {
    throw new Error("Invalid personal-space change.");
  }
  return documents.appendPersonalSpaceChange(
    command.change as Parameters<Documents["appendPersonalSpaceChange"]>[0]);
}

function saveDirectorySnapshot({ documents, command, text }: DocumentCommandContext) {
  if (!command.snapshot || typeof command.snapshot !== "object" || Array.isArray(command.snapshot)) {
    throw new Error("Invalid directory snapshot.");
  }
  return documents.saveDirectorySnapshot(text("folderId"), text("sourceDeviceId"),
    command.path === "" ? "" : text("path"), command.snapshot as Parameters<Documents["saveDirectorySnapshot"]>[3]);
}

function saveProfileSettings({ documents, command }: DocumentCommandContext) {
  if (!command.settings || typeof command.settings !== "object" || Array.isArray(command.settings)) {
    throw new Error("Invalid profile settings.");
  }
  return documents.saveProfileSettings(command.settings as Parameters<Documents["saveProfileSettings"]>[0]);
}

function saveConnectionPasswords({ documents, command }: DocumentCommandContext) {
  if (!command.passwords || typeof command.passwords !== "object" || Array.isArray(command.passwords)) throw new Error("Invalid credentials.");
  return documents.saveConnectionPasswords(command.passwords as Record<string, string>);
}

function mergeConnectionPasswords({ documents, command }: DocumentCommandContext) {
  if (!command.passwords || typeof command.passwords !== "object" || Array.isArray(command.passwords)) throw new Error("Invalid credentials.");
  return documents.mergeConnectionPasswords(command.passwords as Record<string, string>);
}

function recoverOwnedDevice({ documents, command, text }: DocumentCommandContext) {
  if (!command.kit || typeof command.kit !== "object" || Array.isArray(command.kit)) {
    throw new Error("Invalid owned recovery kit.");
  }
  return documents.recoverOwnedDevice(text("localDeviceId"),
    command.kit as Parameters<Documents["recoverOwnedDevice"]>[1], text("password"));
}

function exportPairingTransfer({ documents, command, text }: DocumentCommandContext) {
  if (!command.joiningDevice || typeof command.joiningDevice !== "object" || Array.isArray(command.joiningDevice)) {
    throw new Error("Invalid joining device identity.");
  }
  return documents.exportPairingTransfer(text("localDeviceId"),
    command.joiningDevice as Parameters<Documents["exportPairingTransfer"]>[1]);
}

function importPairingTransfer({ documents, command, text }: DocumentCommandContext) {
  if (!command.transfer || typeof command.transfer !== "object" || Array.isArray(command.transfer) ||
    (command.remember !== undefined && typeof command.remember !== "boolean")) {
    throw new Error("Invalid personal-space pairing transfer.");
  }
  if (!command.identity || typeof command.identity !== "object" || Array.isArray(command.identity)) {
    throw new Error("Invalid local device identity.");
  }
  return documents.importPairingTransfer(command.transfer as Parameters<Documents["importPairingTransfer"]>[0],
    command.identity as Parameters<Documents["importPairingTransfer"]>[1], text("password"), command.remember !== false);
}

function restoreRecoveryBackup({ documents, command, text }: DocumentCommandContext) {
  if (!command.backup || typeof command.backup !== "object" || Array.isArray(command.backup)) {
    throw new Error("Invalid personal-space recovery backup.");
  }
  return documents.restoreRecoveryBackup(command.backup as Parameters<Documents["restoreRecoveryBackup"]>[0],
    text("recoveryPassword"), text("password"));
}

function saveUiState({ documents, command }: DocumentCommandContext) {
  const state = command.state ?? null;
  if (state !== null) {
    const encoded = JSON.stringify(state);
    if (typeof encoded !== "string" || encoded.length > 512 * 1024) throw new Error("Invalid UI state record.");
  }
  return documents.saveUiState(state);
}

function digestCachedFiles({ documents, command }: DocumentCommandContext) {
  if (!Array.isArray(command.files) || command.files.length > 256 || command.files.some(file =>
    !file || typeof file !== "object" || typeof file.folderId !== "string" || !file.folderId ||
    file.folderId.length > 4096 || typeof file.path !== "string" || !file.path || file.path.length > 4096)) {
    throw new Error("Invalid cached document digest request.");
  }
  return documents.digestCachedFiles(command.files.map(file => ({ folderId: file.folderId, path: file.path })));
}

function cachedStatuses({ documents, command, text }: DocumentCommandContext) {
  if (!Array.isArray(command.paths) || command.paths.length > 4096 || command.paths.some(path => typeof path !== "string" || path.length > 4096)) throw new Error("Invalid document paths.");
  return documents.cachedStatuses(text("folderId"), command.paths);
}

function recordFavoriteResolution({ documents, command, text }: DocumentCommandContext) {
  if (command.resolution !== "keep-local" && command.resolution !== "keep-remote") {
    throw new Error("Invalid favorite conflict resolution.");
  }
  return documents.recordFavoriteResolution(text("folderId"), text("path"), command.resolution);
}

function clearFavoriteRenames({ documents, command, text }: DocumentCommandContext) {
  if (!Array.isArray(command.paths) || command.paths.length > 4096 ||
    command.paths.some(path => typeof path !== "string" || path.length > 4096)) throw new Error("Invalid document paths.");
  return documents.clearFavoriteRenames(text("folderId"), command.paths);
}

function saveFavoriteSyncEntries({ documents, command, text }: DocumentCommandContext) {
  if (!command.entries || typeof command.entries !== "object" || Array.isArray(command.entries)) {
    throw new Error("Invalid favorite sync entries.");
  }
  return documents.saveFavoriteSyncEntries(text("folderId"),
    command.entries as Parameters<Documents["saveFavoriteSyncEntries"]>[1]);
}

function beginDownload({ documents, command, text, integer, blocks }: DocumentCommandContext) {
  if (typeof command.encrypted !== "boolean") throw new Error("Invalid download encryption metadata.");
  return documents.beginDownload(text("folderId"), text("path"), integer("size"), integer("modifiedMs"),
    command.expectedLocalHash === undefined || command.expectedLocalHash === null ? command.expectedLocalHash : text("expectedLocalHash"), {
    encrypted: command.encrypted,
    ...(command.sourceDeviceId === undefined ? {} : { sourceDeviceId: text("sourceDeviceId") }),
    ...(command.contentId === undefined ? {} : { contentId: text("contentId") }),
    ...(command.blocks === undefined ? {} : { blocks: blocks() }),
  });
}

async function digestRanges({ documents, command, integer, ranges }: DocumentCommandContext) {
  if (command.source !== "cached" && command.source !== "partial") throw new Error("Invalid document source.");
  return (await documents.digestRanges(integer("handle"), command.source, ranges()))
    .map(range => ({ ...range, hash: Array.from(range.hash) }));
}

function createVault({ documents, command, text }: DocumentCommandContext) {
  if (command.remember !== undefined && typeof command.remember !== "boolean") throw new Error("Invalid remember setting.");
  return documents.createVault(text("password"), command.remember === true,
    command.localDeviceId === undefined ? undefined : text("localDeviceId"),
    command.recoveryKey === undefined ? undefined : text("recoveryKey"));
}

function registerDocument({ documents, command, text }: DocumentCommandContext) {
  return documents.register({ id: text("id"), label: text("label"),
    ...(command.password === undefined ? {} : { password: text("password") }) });
}

function createDocument({ documents, command, text }: DocumentCommandContext) {
  if (typeof command.directory !== "boolean") throw new Error("Invalid document type.");
  return documents.create(text("id"), text("name"), command.directory);
}

async function readDocument({ documents, integer }: DocumentCommandContext) {
  const size = integer("size");
  if (size > 131072) throw new Error("Document read exceeds bridge limit.");
  const bytes = await documents.read(integer("handle"), integer("offset"), size);
  try { return Array.from(bytes); } finally { bytes.fill(0); }
}

async function writeDocument({ documents, command, integer }: DocumentCommandContext) {
  const value = command.bytes;
  if (!Array.isArray(value) || value.length > 131072 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("Invalid document bytes.");
  const bytes = new Uint8Array(value);
  try { await documents.write(integer("handle"), integer("offset"), bytes); return bytes.length; }
  finally { bytes.fill(0); value.fill(0); }
}

async function writeDocumentBatch({ documents, command, integer }: DocumentCommandContext) {
  const values = command.writes;
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    throw new Error("Invalid document write batch.");
  }
  let total = 0;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid document write batch.");
    const write = value as Record<string, unknown>;
    if (!Number.isSafeInteger(write.offset) || Number(write.offset) < 0 ||
      !Array.isArray(write.bytes) || write.bytes.length > 131072) throw new Error("Invalid document write batch.");
    for (const byte of write.bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("Invalid document write batch.");
    }
    total += write.bytes.length;
    if (total > 8 * 131072 || !Number.isSafeInteger(Number(write.offset) + write.bytes.length)) {
      throw new Error("Invalid document write batch.");
    }
  }
  const writes = values.map(value => {
    const write = value as { offset: number; bytes: number[] };
    return { offset: write.offset, bytes: new Uint8Array(write.bytes) };
  });
  try { await documents.writeBatch(integer("handle"), writes); return total; }
  finally {
    writes.forEach(write => write.bytes.fill(0));
    values.forEach(value => ((value as { bytes: number[] }).bytes).fill(0));
  }
}

function releaseDocument({ documents, command, integer }: DocumentCommandContext) {
  if (command.abort !== undefined && typeof command.abort !== "boolean") throw new Error("Invalid document release.");
  return documents.release(integer("handle"), command.abort === true);
}

const unknownCommand = (): never => { throw new Error("Unknown document command."); };

const commandHandlers: Record<string, CommandHandler> = {
  status: ({ documents }) => documents.status(),
  cacheRegistrations: ({ documents }) => documents.status(),
  connectionPasswords: ({ documents }) => documents.connectionPasswords(),
  sessionSharedFolders,
  profileSettings: ({ documents }) => documents.profileSettings(),
  localReleaseHistory: ({ documents }) => documents.localReleaseHistory(),
  personalSpaceChanges: ({ documents }) => documents.personalSpaceChanges(),
  sharedPersonalSpaceSettings: ({ documents }) => documents.sharedPersonalSpaceSettings(),
  savePersonalSpaceSetting,
  resolvePersonalSpaceConflict,
  appendPersonalSpaceChange,
  loadDirectorySnapshot: ({ documents, command, text }) => documents.loadDirectorySnapshot(text("folderId"), text("sourceDeviceId"),
    command.path === "" ? "" : text("path")),
  saveDirectorySnapshot,
  enforceCacheQuota: ({ documents }) => documents.enforceCacheQuota(),
  saveProfileSettings,
  saveConnectionPasswords,
  mergeConnectionPasswords,
  exportRecoveryBackup: ({ documents, text }) => documents.exportRecoveryBackup(text("password")),
  ownedDevices: ({ documents }) => documents.ownedDevices(),
  revokeOwnedDevice: ({ documents, text }) => documents.revokeOwnedDevice(text("deviceId")),
  recoverOwnedDevice,
  exportPairingTransfer,
  importPairingTransfer,
  restoreRecoveryBackup,
  uiState: ({ documents }) => documents.uiState(),
  saveUiState,
  rememberFolder: ({ documents, text }) => documents.rememberFolder({ id: text("id"), label: text("label") }),
  cachedFiles: ({ documents }) => documents.cachedFiles(),
  digestCachedFiles,
  folderFiles: ({ documents, text }) => documents.cachedFiles(text("folderId")),
  cachedStatuses,
  versions: ({ documents, text }) => documents.versions(text("id")),
  restoreVersion: ({ documents, text }) => documents.restoreVersion(text("id"), text("versionId")),
  favoriteSyncState: ({ documents, text }) => documents.favoriteSyncState(text("folderId")),
  clearFavoriteSyncEntry: ({ documents, text }) => documents.clearFavoriteSyncEntry(text("folderId"), text("path")),
  recordFavoriteResolution,
  clearFavoriteRenames,
  saveFavoriteSyncEntries,
  attachDownloads: ({ documents, text }) => documents.attachDownloads(text("id")),
  detachDownloads: ({ documents, text }) => documents.detachDownloads(text("id")),
  beginDownload,
  downloadRanges: ({ documents, integer }) => documents.downloadRanges(integer("handle")),
  suspendDownload: ({ documents, integer }) => documents.suspendDownload(integer("handle")),
  finishDownload: ({ documents, integer }) => documents.finishDownload(integer("handle")),
  digest: ({ documents, integer }) => documents.digest(integer("handle")),
  copyRanges: ({ documents, integer, ranges }) => documents.copyRanges(integer("handle"), ranges()),
  digestRanges,
  remove: ({ documents, text }) => documents.remove(text("id")),
  rename: ({ documents, text }) => documents.rename(text("id"), text("name")),
  setSyncBaseline: ({ documents, text, integer }) => documents.setSyncBaseline(text("id"), { hash: text("hash"), sizeBytes: integer("sizeBytes"), modifiedMs: integer("modifiedMs") }),
  createVault,
  unlock: ({ documents, text }) => documents.unlock(text("password")),
  unlockRemembered: ({ documents }) => documents.unlockRemembered(),
  changeMasterPassword: ({ documents, text }) => documents.changeMasterPassword(text("password")),
  lock: ({ documents }) => documents.lock(),
  register: registerDocument,
  stat: ({ documents, text }) => documents.stat(text("id")),
  list: ({ documents, text }) => documents.list(text("id")),
  create: createDocument,
  open: ({ documents, text }) => documents.open(text("id"), text("mode")),
  size: ({ documents, integer }) => documents.size(integer("handle")),
  read: readDocument,
  write: writeDocument,
  writeBatch: writeDocumentBatch,
  flush: ({ documents, integer }) => documents.flush(integer("handle")),
  release: releaseDocument,
};

/** Validate the native/UI boundary before dispatching to the one document owner. */
export async function dispatchDocumentCommand(documents: Documents, input: unknown): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid document command.");
  const command = input as Record<string, unknown>;
  const text = (field: string) => {
    const value = command[field];
    if (typeof value !== "string" || !value.length || value.length > 4096) {
      throw new Error(`Invalid document ${field}: expected 1 to 4096 characters.`);
    }
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
  const blocks = () => {
    if (command.blocks === undefined) return undefined;
    if (!Array.isArray(command.blocks)) throw new Error("Invalid download blocks.");
    return command.blocks.map(value => {
      if (!value || typeof value !== "object") throw new Error("Invalid download block.");
      const block = value as Record<string, unknown>;
      if (typeof block.offset !== "number" || !Number.isSafeInteger(block.offset) || block.offset < 0 ||
        typeof block.size !== "number" || !Number.isSafeInteger(block.size) || block.size < 0 ||
        !Array.isArray(block.hash) || block.hash.length !== 32 ||
        block.hash.some(byte => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new Error("Invalid download block.");
      }
      return { offset: block.offset, size: block.size, hash: new Uint8Array(block.hash) };
    });
  };
  const handler = typeof command.operation === "string" ? commandHandlers[command.operation] ?? unknownCommand : unknownCommand;
  return handler({ documents, command, text, integer, ranges, blocks });
}
