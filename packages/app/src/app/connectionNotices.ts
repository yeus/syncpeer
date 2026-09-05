export const folderRootEmptyNotice = (
  isConnected: boolean,
  folderCount: number,
): string | null => {
  if (folderCount > 0) return null;
  if (!isConnected) return "Connect to browse folders.";
  return "Connected, but the remote device is not sharing any folders with this device. Share a folder with this device in the remote Syncthing settings.";
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
