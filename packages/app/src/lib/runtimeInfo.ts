import {
  classifyRuntimeArchitecture,
  classifyRuntimePlatform,
  type AppRuntimeArchitecture,
  type AppRuntimePlatform,
  type AppRuntimeSurface,
  type AppRuntimeEnvironment,
} from "@syncpeer/core/browser";

export type RuntimeSurface = AppRuntimeSurface;
export type RuntimeEnvironment = AppRuntimeEnvironment;
export type RuntimePlatform = AppRuntimePlatform;
export type RuntimeArchitecture = AppRuntimeArchitecture;

export const supportsOngoingTransferNotifications = (surface: RuntimeSurface) =>
  surface === "android-ui";

export const classifyRuntimeEnvironment = (signals: {
  hasNodeRuntime: boolean;
  hasTauriRuntime: boolean;
}): RuntimeEnvironment => {
  if (signals.hasTauriRuntime) return "tauri";
  if (signals.hasNodeRuntime) return "node";
  return "browser";
};

const hasNavigator = () => typeof navigator !== "undefined";

const userAgentText = () =>
  hasNavigator()
    ? `${navigator.userAgent ?? ""} ${(navigator as Navigator & { platform?: string }).platform ?? ""}`.toLowerCase()
    : "";

const runtimeSignalText = () => {
  const runtimeProcess = typeof process !== "undefined" ? process : undefined;
  const runtimeNavigator = hasNavigator()
    ? (navigator as Navigator & {
        platform?: string;
        userAgentData?: { platform?: string };
      })
    : undefined;
  return [
    runtimeProcess?.platform,
    runtimeNavigator?.platform,
    runtimeNavigator?.userAgentData?.platform,
    userAgentText(),
  ]
    .filter(Boolean)
    .join(" ");
};

export const detectRuntimeEnvironment = (): RuntimeEnvironment => {
  const runtimeGlobal = globalThis as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return classifyRuntimeEnvironment({
    hasNodeRuntime: typeof process !== "undefined" && Boolean(process.versions?.node),
    hasTauriRuntime: Boolean(
      runtimeGlobal.__TAURI__ || runtimeGlobal.__TAURI_INTERNALS__,
    ),
  });
};

export const detectRuntimeSurface = (): RuntimeSurface => {
  const environment = detectRuntimeEnvironment();
  if (environment === "node") return "cli";
  if (environment === "tauri") {
    return userAgentText().includes("android") ? "android-ui" : "desktop-ui";
  }
  return "web-ui";
};

export const detectRuntimePlatform = (): RuntimePlatform =>
  classifyRuntimePlatform(runtimeSignalText());

export const detectRuntimeArchitecture = (): RuntimeArchitecture => {
  const runtimeProcess = typeof process !== "undefined" ? process : undefined;
  const runtimeNavigator = hasNavigator()
    ? (navigator as Navigator & { userAgentData?: { architecture?: string } })
    : undefined;
  return classifyRuntimeArchitecture([
    runtimeProcess?.arch,
    runtimeNavigator?.userAgentData?.architecture,
    runtimeSignalText(),
  ].filter(Boolean).join(" "));
};
