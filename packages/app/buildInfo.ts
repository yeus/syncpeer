export const resolvePackagedAppVersion = (config: unknown): string => {
  if (!config || typeof config !== "object" || !("version" in config)) {
    return "unknown";
  }
  const version = (config as { version?: unknown }).version;
  return typeof version === "string" && version.trim() ? version.trim() : "unknown";
};
