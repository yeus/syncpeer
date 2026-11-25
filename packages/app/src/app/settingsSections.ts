export const settingsSections = [
  { id: "synchronization", title: "Synchronization", description: "Background activity, network and battery policies" },
  { id: "personal-space", title: "Personal space", description: "Trusted devices and pairing" },
  { id: "storage", title: "Storage", description: "Local files, cache and version history" },
  { id: "security", title: "Security & recovery", description: "Encryption, biometrics, device identity and backups" },
  { id: "network", title: "Network", description: "Discovery, relay and advanced connections" },
  { id: "appearance", title: "Appearance", description: "Theme and colors" },
  { id: "diagnostics", title: "Diagnostics", description: "Connection health, logs and troubleshooting" },
  { id: "about", title: "About", description: "Version, documentation and licenses" },
] as const;
export type SettingsSection = "overview" | (typeof settingsSections)[number]["id"];
export const settingsSection = (value: string | null): SettingsSection =>
  value === "overview" || settingsSections.some(section => section.id === value)
    ? value as SettingsSection : "personal-space";
