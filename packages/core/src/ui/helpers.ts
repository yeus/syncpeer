import type { AdvertisedDeviceInfo, FolderInfo } from "../core/model/remoteFs.ts";

export interface BreadcrumbSegment {
  key: string;
  label: string;
  targetFolderId: string;
  targetPath: string;
  ellipsis?: boolean;
}

export interface SavedDeviceLike {
  id: string;
  name: string;
  createdAtMs: number;
  isIntroducer: boolean;
  customName?: boolean;
}

export interface AdvertisedDeviceItem {
  id: string;
  name: string;
  sourceFolderIds: string[];
  accepted: boolean;
}

export interface AdvertisedFolderItem {
  key: string;
  folderId: string;
  label: string;
  sourceDeviceId: string;
  syncApproved: boolean;
}

export const normalizePath = (value: string): string =>
  value.replace(/^\/+|\/+$/g, "");

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const sanitizeDeviceId = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");

const canonicalComparableDeviceId = (value: string): string => {
  const normalized = sanitizeDeviceId(value);
  if (normalized.length !== 56) return normalized;
  let out = "";
  for (let index = 0; index < normalized.length; index += 1) {
    if ((index + 1) % 14 === 0) continue;
    out += normalized[index];
  }
  return out;
};

export const normalizeDeviceId = (value: string): string =>
  canonicalComparableDeviceId(value);

const compactDeviceId = (value: string): string => normalizeDeviceId(value);

export const isValidSyncthingDeviceId = (value: string): boolean =>
  [52, 56].includes(compactDeviceId(value).length);

export const normalizeSavedDevices = (
  parsed: SavedDeviceLike[] | null | undefined,
): SavedDeviceLike[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => typeof item?.id === "string" && item.id.trim() !== "")
    .flatMap((item) => {
      const normalizedId = normalizeDeviceId(String(item.id ?? ""));
      if (!normalizedId) return [];
      const preferredName = String(item.name ?? "").trim();
      const temporaryName = normalizedId.slice(0, 5) || normalizedId;
      const normalizedName = preferredName || normalizedId;
      const normalized: SavedDeviceLike = {
        id: normalizedId,
        name: normalizedName,
        createdAtMs: Number(item.createdAtMs) || Date.now(),
        isIntroducer: item.isIntroducer === true,
        // Legacy entries without this flag are treated as non-custom when
        // they still use an auto-generated placeholder.
        customName:
          typeof item.customName === "boolean"
            ? item.customName
            : normalizedName !== normalizedId && normalizedName !== temporaryName,
      };
      return [normalized];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const normalizeSyncApprovedIntroducedFolderKeys = (
  value: string[] | null | undefined,
): Set<string> => {
  if (!Array.isArray(value)) return new Set<string>();
  const normalized = value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item !== "");
  return new Set(normalized);
};

export const normalizeFolderPasswords = (
  value: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value ?? {})
      .map(([folderId, password]) => [folderId.trim(), String(password ?? "").trim()])
      .filter(([folderId, password]) => folderId !== "" && password !== ""),
  );

export const favoriteKey = (
  folderId: string,
  path: string,
  kind: "folder" | "file",
): string => `${kind}:${folderId}:${normalizePath(path)}`;

export const resolveDirectoryPath = (basePath: string, nextPath: string): string => {
  const base = normalizePath(basePath);
  const next = normalizePath(nextPath);
  if (!next) return base;
  if (
    !base ||
    next === base ||
    next.startsWith(`${base}/`) ||
    next.includes("/")
  ) {
    return next;
  }
  return `${base}/${next}`;
};

export const folderDisplayName = (folder: FolderInfo): string =>
  folder.label || folder.id;

export const breadcrumbSegments = (
  folderId: string,
  path: string,
  availableFolders: FolderInfo[],
  maxVisibleCrumbs: number,
): BreadcrumbSegment[] => {
  if (!folderId) return [];
  const folder = availableFolders.find(
    (candidate) => candidate.id === folderId,
  );
  const folderLabel = folder?.label || folderId;
  const cleanPath = normalizePath(path);
  const parts = cleanPath ? cleanPath.split("/") : [];

  const segments: BreadcrumbSegment[] = [
    {
      key: `folder:${folderId}`,
      label: folderLabel,
      targetFolderId: folderId,
      targetPath: "",
    },
  ];

  for (let index = 0; index < parts.length; index += 1) {
    const segmentPath = parts.slice(0, index + 1).join("/");
    segments.push({
      key: `path:${segmentPath}`,
      label: parts[index],
      targetFolderId: folderId,
      targetPath: segmentPath,
    });
  }

  if (segments.length <= maxVisibleCrumbs) return segments;
  return [
    {
      key: "ellipsis",
      label: "...",
      targetFolderId: folderId,
      targetPath: "",
      ellipsis: true,
    },
    ...segments.slice(segments.length - (maxVisibleCrumbs - 1)),
  ];
};

export const cachedFileKey = (folderId: string, path: string): string =>
  `${folderId}:${normalizePath(path)}`;

export const formatRate = (bytesPerSecond: number): string => {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${Math.round(bytesPerSecond)} B/s`;
};

export const formatEta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.ceil(seconds % 60);
  return `${minutes}m ${remaining}s`;
};

export const syncApprovedFolderKey = (
  sourceDeviceId: string,
  folderId: string,
): string => `${normalizeDeviceId(sourceDeviceId)}:${folderId.trim()}`;

export const collectAdvertisedDevices = (
  availableFolders: FolderInfo[],
  knownDevices: SavedDeviceLike[],
  sourceDeviceId: string,
  sourceIsIntroducer: boolean,
): AdvertisedDeviceItem[] => {
  if (!sourceIsIntroducer || !sourceDeviceId) return [];
  const savedIds = new Set(knownDevices.map((device) => normalizeDeviceId(device.id)));
  const map = new Map<string, AdvertisedDeviceItem>();
  for (const folder of availableFolders) {
    const devices = Array.isArray(folder.advertisedDevices)
      ? (folder.advertisedDevices as AdvertisedDeviceInfo[])
      : [];
    for (const device of devices) {
      const normalizedId = normalizeDeviceId(device.id);
      if (!normalizedId) continue;
      const entry = map.get(normalizedId);
      const normalizedName = (device.name ?? "").trim() || normalizedId;
      if (!entry) {
        map.set(normalizedId, {
          id: normalizedId,
          name: normalizedName,
          sourceFolderIds: [folder.id],
          accepted: savedIds.has(normalizedId),
        });
        continue;
      }
      if (!entry.sourceFolderIds.includes(folder.id)) {
        entry.sourceFolderIds = [...entry.sourceFolderIds, folder.id].sort();
      }
      if (entry.name === entry.id && normalizedName !== normalizedId) {
        entry.name = normalizedName;
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.accepted !== b.accepted) return a.accepted ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
};

export const collectAdvertisedFolders = (
  availableFolders: FolderInfo[],
  sourceDeviceId: string,
  sourceIsIntroducer: boolean,
  syncApprovedKeys: Set<string>,
): AdvertisedFolderItem[] => {
  if (!sourceIsIntroducer || !sourceDeviceId) return [];
  return availableFolders
    .map((folder) => {
      const key = syncApprovedFolderKey(sourceDeviceId, folder.id);
      return {
        key,
        folderId: folder.id,
        label: folder.label || folder.id,
        sourceDeviceId,
        syncApproved: syncApprovedKeys.has(key),
      };
    })
    .sort((a, b) => {
      if (a.syncApproved !== b.syncApproved) return a.syncApproved ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
};
