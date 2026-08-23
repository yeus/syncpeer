export type RuntimeSurface = "cli" | "desktop-ui" | "android-ui" | "web-ui";
export type RuntimeEnvironment = "tauri" | "browser" | "node";

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
