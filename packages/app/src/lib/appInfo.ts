import {
  createAppBuildInfo,
  formatAppBuildInfo,
  type AppBuildInfo,
} from "@syncpeer/core/browser";
import {
  detectRuntimeArchitecture,
  detectRuntimeEnvironment,
  detectRuntimePlatform,
  detectRuntimeSurface,
} from "./runtimeInfo.ts";

export const getAppBuildInfo = (): AppBuildInfo =>
  createAppBuildInfo({
    appVersion: import.meta.env.SYNCPEER_APP_VERSION,
    coreVersion: import.meta.env.SYNCPEER_CORE_VERSION,
    buildCommit: import.meta.env.SYNCPEER_BUILD_COMMIT,
    buildTimeUtc: import.meta.env.SYNCPEER_BUILD_TIME_UTC,
    buildMode: import.meta.env.DEV ? "development" : "production",
    runtimeEnvironment: detectRuntimeEnvironment(),
    runtimeSurface: detectRuntimeSurface(),
    platform: detectRuntimePlatform(),
    architecture: detectRuntimeArchitecture(),
  });

export const formatBuildTimeLocal = (buildTimeUtc: string): string => {
  if (buildTimeUtc === "unknown") return "unknown";
  const parsed = new Date(buildTimeUtc);
  return Number.isNaN(parsed.getTime()) ? "unknown" : parsed.toLocaleString();
};

export { formatAppBuildInfo };
