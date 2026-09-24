import type { FavoriteRecord } from "../ui/browserClient.js";
import type { FavoriteExclusion } from "../ui/favoriteSelection.js";
import type { FolderRetentionPolicy } from "./folderRetention.js";
import type { FolderShareTarget } from "./personalSpaceSharing.js";
import { verifyOwnedRoster, type OwnedRosterTrust } from "./personalSpaceSharing.js";
import { resolvePersonalSpaceChanges, verifyPersonalSpaceChange,
  type PersonalSpaceChange } from "./personalSpaceChanges.js";
import { settingsInteger, settingsText } from "./settingsValidation.js";

export interface DeviceFolderSelection {
  favorites: FavoriteRecord[];
  exclusions: FavoriteExclusion[];
}

export interface SharedFolderSettings {
  shareTargets: FolderShareTarget[];
  minimumCopies: number;
  retentionRevision: number;
  holders: Array<{ id: string; kind: "syncpeer" | "syncthing" }>;
  devices: Record<string, DeviceFolderSelection>;
}

export interface PersonalSpaceSettings {
  format: 1;
  rosterHead: string;
  folders: Record<string, SharedFolderSettings>;
}

const defaultSharedFolderSettings = (): SharedFolderSettings => ({
  shareTargets: [{ kind: "personal-space" }],
  minimumCopies: 2,
  retentionRevision: 1,
  holders: [],
  devices: {},
});

export const defaultPersonalSpaceSettings = (rosterHead: string): PersonalSpaceSettings => ({
  format: 1,
  rosterHead: settingsText(rosterHead, "shared settings roster head"),
  folders: {},
});

const normalizeFavorite = (folderId: string, value: unknown): FavoriteRecord => {
  const favorite = value as Partial<FavoriteRecord>;
  if (!favorite || typeof favorite !== "object" || !["file", "folder"].includes(String(favorite.kind))) {
    throw new Error("Invalid shared favorite.");
  }
  return { folderId, key: settingsText(favorite.key, "shared favorite key"),
    path: settingsText(favorite.path, "shared favorite path"),
    name: settingsText(favorite.name, "shared favorite name"), kind: favorite.kind as "file" | "folder" };
};

const normalizeExclusion = (folderId: string, value: unknown): FavoriteExclusion => {
  const exclusion = value as Partial<FavoriteExclusion>;
  if (!exclusion || typeof exclusion !== "object" || !["file", "folder"].includes(String(exclusion.kind))) {
    throw new Error("Invalid shared favorite exclusion.");
  }
  return { folderId, path: settingsText(exclusion.path, "shared favorite exclusion path"),
    kind: exclusion.kind as "file" | "folder" };
};

const normalizeTargets = (values: unknown[]): FolderShareTarget[] => values.map(value => {
  const target = value as Partial<FolderShareTarget>;
  if (target?.kind === "personal-space") return { kind: "personal-space" };
  if (target?.kind === "device") {
    return { kind: "device", syncthingId: settingsText(target.syncthingId, "share target identity") };
  }
  throw new Error("Invalid shared folder target.");
});

const normalizeFolder = (folderId: string, value: unknown): SharedFolderSettings => {
  const folder = value as Partial<SharedFolderSettings>;
  if (!folder || typeof folder !== "object" || !Array.isArray(folder.shareTargets) ||
    !Array.isArray(folder.holders) || !folder.devices || typeof folder.devices !== "object" ||
    Array.isArray(folder.devices) || folder.holders.length > 1000 || Object.keys(folder.devices).length > 1000) {
    throw new Error("Invalid shared folder settings.");
  }
  const holderIds = new Set<string>();
  const holders = folder.holders.map(holder => {
    if (!holder || typeof holder !== "object" || !["syncpeer", "syncthing"].includes(holder.kind)) {
      throw new Error("Invalid shared retention holder.");
    }
    const id = settingsText(holder.id, "shared retention holder identity");
    if (holderIds.has(id)) throw new Error("Invalid duplicate shared retention holder.");
    holderIds.add(id);
    return { id, kind: holder.kind };
  });
  const devices = Object.fromEntries(Object.entries(folder.devices).map(([deviceId, value]) => {
    const selection = value as Partial<DeviceFolderSelection>;
    if (!selection || typeof selection !== "object" || !Array.isArray(selection.favorites) ||
      !Array.isArray(selection.exclusions) || selection.favorites.length > 10000 || selection.exclusions.length > 10000) {
      throw new Error("Invalid shared device folder selection.");
    }
    return [settingsText(deviceId, "shared settings device identity"), {
      favorites: selection.favorites.map(item => normalizeFavorite(folderId, item)),
      exclusions: selection.exclusions.map(item => normalizeExclusion(folderId, item)),
    }];
  }));
  return { shareTargets: normalizeTargets(folder.shareTargets),
    minimumCopies: settingsInteger(folder.minimumCopies, "shared minimum copy count", 1),
    retentionRevision: settingsInteger(folder.retentionRevision, "shared retention revision", 1),
    holders, devices };
};

export function normalizePersonalSpaceSettings(value: unknown): PersonalSpaceSettings {
  const settings = value as Partial<PersonalSpaceSettings>;
  if (settings?.format !== 1) throw new Error("Unsupported personal-space settings format.");
  if (!settings.folders || typeof settings.folders !== "object" || Array.isArray(settings.folders) ||
    Object.keys(settings.folders).length > 10000) throw new Error("Invalid personal-space settings.");
  const folders = Object.fromEntries(Object.entries(settings.folders).map(([folderId, folder]) => {
    const id = settingsText(folderId, "shared settings folder identity");
    return [id, normalizeFolder(id, folder)];
  }));
  return { format: 1, rosterHead: settingsText(settings.rosterHead, "shared settings roster head"), folders };
}

const folderOrDefault = (settings: PersonalSpaceSettings, folderId: string) =>
  settings.folders[folderId] ?? defaultSharedFolderSettings();

const applySharedChange = (settings: PersonalSpaceSettings,
  change: { path: string[]; value?: unknown; deleted?: true }, deviceId?: string): PersonalSpaceSettings => {
  const [scope, folderId, field, owner] = change.path;
  if (scope !== "folders" || !folderId || !field ||
    !(change.path.length === 3 && (field === "shareTargets" || field === "retention") ||
      change.path.length === 4 && field === "devices" && owner === deviceId)) {
    throw new Error("Unsupported personal-space setting path or device selection owner.");
  }
  const folder = folderOrDefault(settings, folderId);
  let updated: SharedFolderSettings;
  if (field === "shareTargets") {
    if (change.deleted || !Array.isArray(change.value)) throw new Error("Invalid shared folder targets.");
    updated = { ...folder, shareTargets: change.value as FolderShareTarget[] };
  } else if (field === "retention") {
    const value = change.value as Partial<SharedFolderSettings> | null;
    if (change.deleted || !value || typeof value !== "object") throw new Error("Invalid shared retention policy.");
    updated = { ...folder, minimumCopies: value.minimumCopies!,
      retentionRevision: value.retentionRevision!, holders: value.holders! };
  } else {
    const devices = { ...folder.devices };
    if (change.deleted) delete devices[owner!];
    else devices[owner!] = change.value as DeviceFolderSelection;
    updated = { ...folder, devices };
  }
  return normalizePersonalSpaceSettings({ ...settings,
    folders: { ...settings.folders, [folderId]: updated } });
};

/** Materialize only recognized paths from a complete journal pinned to the verified owned roster. */
export async function materializePersonalSpaceSettings(subtle: SubtleCrypto, trust: OwnedRosterTrust,
  changes: readonly PersonalSpaceChange[]): Promise<{
    settings: PersonalSpaceSettings | null;
    conflicts: ReturnType<typeof resolvePersonalSpaceChanges>["conflicts"];
  }> {
  if (!trust || trust.knownHead !== trust.updates?.at(-1)?.hash) throw new Error("Invalid trusted device list.");
  const roster = await verifyOwnedRoster(subtle, trust.updates, trust.genesisKey, trust.knownHead);
  const known = new Map(roster.devices.map(device => [device.id, device.signingKey]));
  const resolved = resolvePersonalSpaceChanges(changes);
  const baseline = defaultPersonalSpaceSettings(trust.knownHead);
  for (const change of changes) {
    const signingKey = known.get(change.deviceId);
    if (!signingKey) throw new Error("Personal-space setting author is not a trusted device.");
    if (!await verifyPersonalSpaceChange(subtle, change, signingKey)) {
      throw new Error("Personal-space setting signature is invalid.");
    }
    applySharedChange(baseline, change, change.deviceId);
  }
  if (resolved.conflicts.length) return { settings: null, conflicts: resolved.conflicts };
  const owners = new Map(changes.map(change => [change.id, change.deviceId]));
  const settings = resolved.values.reduce((current, value) =>
    applySharedChange(current, value, owners.get(value.heads[0])), baseline);
  return { settings, conflicts: [] };
}

export function setDeviceFolderSelection(settings: PersonalSpaceSettings, folderId: string, deviceId: string,
  selection: DeviceFolderSelection): PersonalSpaceSettings {
  const current = normalizePersonalSpaceSettings(settings);
  const id = settingsText(folderId, "shared settings folder identity");
  const folder = folderOrDefault(current, id);
  return normalizePersonalSpaceSettings({ ...current, folders: { ...current.folders, [id]: { ...folder,
    devices: { ...folder.devices, [settingsText(deviceId, "shared settings device identity")]: selection } } } });
}

export function updateFolderRetention(settings: PersonalSpaceSettings, folderId: string,
  retention: Pick<SharedFolderSettings, "minimumCopies" | "holders">): PersonalSpaceSettings {
  const current = normalizePersonalSpaceSettings(settings);
  const id = settingsText(folderId, "shared settings folder identity");
  const folder = folderOrDefault(current, id);
  return normalizePersonalSpaceSettings({ ...current, folders: { ...current.folders, [id]: { ...folder,
    minimumCopies: retention.minimumCopies, holders: retention.holders,
    retentionRevision: folder.retentionRevision + 1 } } });
}

export function folderRetentionPolicyFromSettings(settings: PersonalSpaceSettings,
  folderId: string): FolderRetentionPolicy {
  const current = normalizePersonalSpaceSettings(settings);
  const id = settingsText(folderId, "shared settings folder identity");
  const folder = folderOrDefault(current, id);
  return { format: 1, folderId: id, minimumCopies: folder.minimumCopies,
    revision: folder.retentionRevision, rosterHead: current.rosterHead, holders: folder.holders };
}
