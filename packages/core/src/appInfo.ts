export type AppBuildMode = "development" | "production";
export type AppRuntimeEnvironment = "tauri" | "browser" | "node";
export type AppRuntimeSurface = "cli" | "desktop-ui" | "android-ui" | "web-ui";
export type AppRuntimePlatform =
  | "android"
  | "ios"
  | "linux"
  | "macos"
  | "windows"
  | "unknown";
export type AppRuntimeArchitecture =
  | "arm"
  | "arm64"
  | "x64"
  | "x86"
  | "unknown";

export interface AppBuildInfo {
  appName: "Syncpeer";
  appVersion: string;
  coreVersion: string;
  buildCommit: string;
  buildTimeUtc: string;
  buildMode: AppBuildMode;
  runtimeEnvironment: AppRuntimeEnvironment;
  runtimeSurface: AppRuntimeSurface;
  platform: AppRuntimePlatform;
  architecture: AppRuntimeArchitecture;
}

const textOrUnknown = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  return trimmed || "unknown";
};

export const createAppBuildInfo = (input: {
  appVersion: unknown;
  coreVersion: unknown;
  buildCommit: unknown;
  buildTimeUtc: unknown;
  buildMode: AppBuildMode;
  runtimeEnvironment: AppRuntimeEnvironment;
  runtimeSurface: AppRuntimeSurface;
  platform: AppRuntimePlatform;
  architecture: AppRuntimeArchitecture;
}): AppBuildInfo => ({
  appName: "Syncpeer",
  appVersion: textOrUnknown(input.appVersion),
  coreVersion: textOrUnknown(input.coreVersion),
  buildCommit: textOrUnknown(input.buildCommit),
  buildTimeUtc: textOrUnknown(input.buildTimeUtc),
  buildMode: input.buildMode,
  runtimeEnvironment: input.runtimeEnvironment,
  runtimeSurface: input.runtimeSurface,
  platform: input.platform,
  architecture: input.architecture,
});

export const classifyRuntimePlatform = (text: string): AppRuntimePlatform => {
  const normalized = text.toLowerCase();
  if (normalized.includes("android")) return "android";
  if (normalized.includes("iphone") || normalized.includes("ipad") || normalized.includes("ios")) {
    return "ios";
  }
  if (normalized.includes("win")) return "windows";
  if (normalized.includes("mac") || normalized.includes("darwin")) return "macos";
  if (normalized.includes("linux") || normalized.includes("x11")) return "linux";
  return "unknown";
};

export const classifyRuntimeArchitecture = (text: string): AppRuntimeArchitecture => {
  const normalized = text.toLowerCase();
  if (normalized.includes("arm64") || normalized.includes("aarch64") || normalized.includes("armv8")) {
    return "arm64";
  }
  if (normalized.includes("arm")) return "arm";
  if (normalized.includes("x86_64") || normalized.includes("x64") || normalized.includes("amd64") || normalized.includes("win64")) {
    return "x64";
  }
  if (normalized.includes("x86") || normalized.includes("i386") || normalized.includes("i686")) {
    return "x86";
  }
  return "unknown";
};

export const formatAppBuildInfo = (info: AppBuildInfo): string => [
  "# Syncpeer Build Information",
  `app_name: ${info.appName}`,
  `app_version: ${info.appVersion}`,
  `core_version: ${info.coreVersion}`,
  `build_commit: ${info.buildCommit}`,
  `build_time_utc: ${info.buildTimeUtc}`,
  `build_mode: ${info.buildMode}`,
  `runtime_environment: ${info.runtimeEnvironment}`,
  `runtime_surface: ${info.runtimeSurface}`,
  `platform: ${info.platform}`,
  `architecture: ${info.architecture}`,
].join("\n");
