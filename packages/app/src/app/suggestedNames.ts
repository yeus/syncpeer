import { normalizeDeviceId } from "@syncpeer/core/browser";

export const inferPlatformLabel = () => {
  if (typeof navigator === "undefined") return "device";
  const uaDataPlatform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ?? "";
  const platform =
    `${uaDataPlatform} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (platform.includes("android")) return "android";
  if (
    platform.includes("iphone") ||
    platform.includes("ipad") ||
    platform.includes("ios")
  ) {
    return "ios";
  }
  if (platform.includes("mac")) return "mac";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "device";
};

export const suggestedClientName = () => {
  if (typeof window !== "undefined") {
    const host = window.location.hostname.trim().toLowerCase();
    if (
      host &&
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "tauri.localhost"
    ) {
      return `syncpeer-${host}`;
    }
  }
  return `syncpeer-${inferPlatformLabel()}`;
};

export const temporarySavedDeviceName = (deviceId: string) => {
  const normalized = normalizeDeviceId(deviceId);
  return normalized ? normalized.slice(0, 5) || normalized : "";
};
