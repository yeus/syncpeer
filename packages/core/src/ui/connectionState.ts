import { getDefaultDiscoveryServer, normalizeDiscoveryServer, type ConnectOptions } from "./browserClient.js";

export type DiscoveryMode = "global" | "direct";

export interface StoredConnectionSettingsLike {
  host: string;
  port: number;
  cert: string;
  key: string;
  remoteId: string;
  deviceName: string;
  timeoutMs: number;
  discoveryMode: DiscoveryMode;
  discoveryServer: string;
  enableRelayFallback: boolean;
  autoAcceptNewDevices: boolean;
  autoAcceptIntroducedFolders: boolean;
}

export const fromConnectionSettings = (
  stored: StoredConnectionSettingsLike | null,
): StoredConnectionSettingsLike => {
  const discoveryMode: DiscoveryMode =
    stored?.discoveryMode === "direct" ? "direct" : "global";

  if (!stored) {
    return {
      host: "",
      port: 22000,
      cert: "",
      key: "",
      remoteId: "",
      deviceName: "syncpeer-ui",
      timeoutMs: 15000,
      discoveryMode,
      discoveryServer: getDefaultDiscoveryServer(),
      enableRelayFallback: true,
      autoAcceptNewDevices: false,
      autoAcceptIntroducedFolders: false,
    };
  }

  return {
    host:
      discoveryMode === "direct"
        ? stored.host || "127.0.0.1"
        : stored.host || "",
    port: Number(stored.port) || 22000,
    cert: stored.cert || "",
    key: stored.key || "",
    remoteId: stored.remoteId || "",
    deviceName: stored.deviceName || "syncpeer-ui",
    timeoutMs: Number(stored.timeoutMs) || 15000,
    discoveryMode,
    discoveryServer: normalizeDiscoveryServer(stored.discoveryServer),
    enableRelayFallback: stored.enableRelayFallback !== false,
    autoAcceptNewDevices: stored.autoAcceptNewDevices === true,
    autoAcceptIntroducedFolders: stored.autoAcceptIntroducedFolders === true,
  };
};

export const toConnectionSettings = (
  connection: StoredConnectionSettingsLike,
): StoredConnectionSettingsLike => ({
  host: connection.host,
  port: connection.port,
  cert: connection.cert,
  key: connection.key,
  remoteId: connection.remoteId,
  deviceName: connection.deviceName,
  timeoutMs: connection.timeoutMs,
  discoveryMode: connection.discoveryMode,
  discoveryServer: normalizeDiscoveryServer(connection.discoveryServer),
  enableRelayFallback: connection.enableRelayFallback,
  autoAcceptNewDevices: connection.autoAcceptNewDevices,
  autoAcceptIntroducedFolders: connection.autoAcceptIntroducedFolders,
});

export const buildConnectionDetails = (
  connection: StoredConnectionSettingsLike,
  folderPasswords: Record<string, string>,
): ConnectOptions => ({
  host: connection.host,
  port: connection.port,
  discoveryMode: connection.discoveryMode,
  discoveryServer: normalizeDiscoveryServer(connection.discoveryServer),
  cert: connection.cert || undefined,
  key: connection.key || undefined,
  remoteId: connection.remoteId || undefined,
  deviceName: connection.deviceName,
  timeoutMs: connection.timeoutMs,
  enableRelayFallback: connection.enableRelayFallback,
  folderPasswords,
});
