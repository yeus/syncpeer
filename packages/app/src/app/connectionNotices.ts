export const folderRootEmptyNotice = (
  isConnected: boolean,
  folderCount: number,
): string | null => {
  if (folderCount > 0) return null;
  if (!isConnected) return "Connect to browse folders.";
  return "Connected, but the remote device is not sharing any folders with this device. Share a folder with this device in the remote Syncthing settings.";
};

export const shouldRenderFolderRootList = (
  isConnected: boolean,
  rootFolderCount: number,
) => isConnected || rootFolderCount > 0;

/** Network connectivity does not prove metadata or bytes are synchronized. */
export const connectedFolderStatus = (
  folders: readonly { locked: boolean; indexReceived: boolean }[],
): string => {
  if (!folders.length) return "Connected · no folders advertised";
  const locked = folders.filter(folder => folder.locked).length;
  if (locked) return `Connected · encrypted folder${locked === 1 ? "" : "s"} locked`;
  if (folders.some(folder => !folder.indexReceived)) return "Connected · waiting for file indexes";
  return "Connected · file index available";
};

export const localDiscoveryUnavailableNotice = (rawError: unknown): string | null => {
  const message = rawError instanceof Error ? rawError.message : String(rawError);
  const normalized = message.toLowerCase();
  if (!normalized.includes("local discovery sockets unavailable")) return null;
  if (normalized.includes("address already in use")) {
    return "Local discovery is unavailable because another application is already using its network port. This often happens when another Syncthing instance is running on this computer. Automatic, global, direct, and relay connections can still work.";
  }
  return "Local discovery is unavailable on this system. Automatic, global, direct, and relay connections can still work.";
};

export type LocalDiscoveryHealth = "available" | "partial" | "unavailable";

/** Interpret native socket diagnostics without treating an empty scan as a bind failure. */
export const localDiscoveryHealthFromDiagnostics = (value: unknown): {
  health: LocalDiscoveryHealth; notice: string;
} | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const errors = Array.isArray(data.bindErrors)
    ? data.bindErrors.filter((item): item is string => typeof item === "string") : [];
  const occupied = errors.some(error => /address already in use/i.test(error));
  const standard = data.syncthingLanAvailable === true;
  const syncpeer = data.syncpeerLanActive === true;
  const bound = typeof data.socketsBound === "number" ? data.socketsBound : null;
  if (bound === 0 && !syncpeer) return {
    health: "unavailable", notice: occupied
      ? "LAN discovery sockets could not bind; the discovery port may already be in use by another application. Add a device ID for global, direct, or relay connectivity."
      : "LAN discovery sockets are unavailable. You can still add a device by ID for global, direct, or relay connectivity.",
  };
  if ((data.syncthingLanAvailable === false && syncpeer) || (errors.length > 0 && (syncpeer || (bound !== null && bound > 0)))) {
    return { health: "partial", notice: occupied
      ? "Standard Syncthing LAN discovery could not bind its port, possibly because another application uses it. Other discovery paths may still work."
      : standard ? "Some LAN discovery sockets are unavailable; other discovery paths remain active."
      : "Standard Syncthing LAN discovery is unavailable, although another local discovery path is active." };
  }
  return { health: "available", notice: "" };
};
