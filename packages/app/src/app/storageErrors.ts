const rawErrorText = (error: unknown): string => {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === "string") return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "reason", "error", "description"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    }
  }
  return "";
};

const errorText = (error: unknown): string => rawErrorText(error).toLowerCase();
const privateStorageUnrecognized = "syncpeer_private_storage_unrecognized";
const privateStorageResetMessage =
  "Syncpeer found existing data in its private local storage, but this version cannot recognize or safely use it. " +
  "You can reset Syncpeer's private local data and start fresh. This removes local settings, downloaded copies, " +
  "unsynced edits, and this device's identity. External folders and other devices are not changed.";

const safeNativeFailureText = (error: unknown): string | null => {
  const message = rawErrorText(error).replace(/\s+/g, " ").trim();
  if (!message) return null;
  const withoutPaths = message
    .replace(/file:\/\/[^\s"'`,;):]+/gi, "[path]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|users|tmp|var|private|data|storage|mnt)\/)[^\s"'`,;):]+/gi, "[path]");
  const withoutLongTokens = withoutPaths.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return withoutLongTokens.length > 240 ? `${withoutLongTokens.slice(0, 237)}...` : withoutLongTokens;
};

const storageFailureReason = (error: unknown): string | null => {
  const message = errorText(error);
  if (!message) return error === undefined ? null : "the native storage bridge returned no diagnostic detail";
  if (message.includes("protected credential") || message.includes("manual unlock") || message.includes("secret service")) {
    return "the protected credential store is locked or unavailable";
  }
  if (message.includes("protected identity")) {
    return "the protected device identity could not be read or created";
  }
  if (message.includes("metadata key operation")) {
    return "the protected metadata key could not be read or created";
  }
  if (message.includes("protected metadata key is invalid") || message.includes("recovery or local reset")) {
    return "protected metadata is invalid and needs recovery or a local reset";
  }
  if (message.includes("existing metadata requires")) {
    return "existing local metadata needs its protected key or a confirmed local reset";
  }
  if (message.includes("permission denied") || message.includes("access denied") || message.includes("operation not permitted")) {
    return "the operating system denied access to Syncpeer's private app-data directory";
  }
  if (message.includes("no space left") || message.includes("disk full")) {
    return "Syncpeer's private app-data volume is out of free space";
  }
  if (message.includes("read-only file system") || message.includes("read-only filesystem")) {
    return "Syncpeer's private app-data volume is read-only";
  }
  if (message.includes("replica initialization requires an empty folder")) {
    return "the private storage directory contains unexpected files";
  }
  if (message.includes("replica root is busy")) {
    return "the private storage directory is already in use by another Syncpeer process";
  }
  if (message.includes("credential vault") || message.includes("document vault")) {
    return "the local credential vault could not be read";
  }
  const detail = safeNativeFailureText(error);
  return detail
    ? `the native storage operation reported: ${detail}`
    : "the native storage bridge returned no diagnostic detail";
};

export const documentStoragePreparationIssue = (folderCount: number, error?: unknown) => {
  if (errorText(error).includes(privateStorageUnrecognized)) {
    return { message: privateStorageResetMessage, canResetPrivateStorage: true };
  }
  const reason = storageFailureReason(error);
  const reasonText = reason ? ` Reason: ${reason.replace(/[.!?]+$/, "")}.` : "";
  if (folderCount === 0) {
    return {
      message: `Syncpeer could not open its private local data store for settings and downloaded files.${reasonText} No user-selected or peer folder was accessed; downloading is paused.`,
      canResetPrivateStorage: false,
    };
  }
  const folder = folderCount === 1 ? "the shared folder" : "the shared folders";
  return {
    message: `Syncpeer could not prepare local storage for ${folder}.${reasonText} Downloading is paused; check the vault and folder access.`,
    canResetPrivateStorage: false,
  };
};

export const formatDocumentStoragePreparationError = (folderCount: number, error?: unknown): string =>
  documentStoragePreparationIssue(folderCount, error).message;
