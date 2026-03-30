import { normalizeDeviceId } from "./helpers.ts";

export const FOLDER_PASSWORD_SCOPE_SEPARATOR = ":";

export const isScopedFolderPasswordKey = (value: string): boolean => {
  const separatorIndex = value.indexOf(FOLDER_PASSWORD_SCOPE_SEPARATOR);
  if (separatorIndex <= 0) return false;
  const possibleDeviceId = normalizeDeviceId(value.slice(0, separatorIndex));
  if (!possibleDeviceId) return false;
  const scopedFolderId = value
    .slice(separatorIndex + FOLDER_PASSWORD_SCOPE_SEPARATOR.length)
    .trim();
  return scopedFolderId !== "";
};

export const folderPasswordScopedKey = (
  sourceDeviceId: string,
  folderId: string,
): string => {
  const normalizedFolderId = folderId.trim();
  if (!normalizedFolderId) return "";
  const normalizedDeviceId = normalizeDeviceId(sourceDeviceId);
  if (!normalizedDeviceId) return normalizedFolderId;
  return `${normalizedDeviceId}${FOLDER_PASSWORD_SCOPE_SEPARATOR}${normalizedFolderId}`;
};

export const resolveFolderPasswordsForDevice = (
  passwordStore: Record<string, string>,
  sourceDeviceId: string,
): Record<string, string> => {
  const normalizedDeviceId = normalizeDeviceId(sourceDeviceId);
  const scopedPrefix =
    normalizedDeviceId === ""
      ? ""
      : `${normalizedDeviceId}${FOLDER_PASSWORD_SCOPE_SEPARATOR}`;
  const resolved: Record<string, string> = {};

  if (scopedPrefix !== "") {
    for (const [storedKey, storedPassword] of Object.entries(passwordStore)) {
      if (!storedKey.startsWith(scopedPrefix)) continue;
      const folderId = storedKey.slice(scopedPrefix.length).trim();
      if (!folderId) continue;
      resolved[folderId] = storedPassword;
    }
  }

  for (const [storedKey, storedPassword] of Object.entries(passwordStore)) {
    const folderId = storedKey.trim();
    if (!folderId || isScopedFolderPasswordKey(folderId)) continue;
    if (!(folderId in resolved)) {
      resolved[folderId] = storedPassword;
    }
  }

  return resolved;
};

