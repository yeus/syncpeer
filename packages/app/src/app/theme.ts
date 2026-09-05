export type ThemeMode = "auto" | "light" | "dark";

export interface ThemePreferences {
  mode: ThemeMode;
  primaryColor: string;
  secondaryColor: string;
}

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  mode: "auto",
  primaryColor: "#2A3548",
  secondaryColor: "#F78F3B",
};

const normalizeHexColor = (value: unknown, fallback: string) => {
  const color = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : fallback;
};

export const normalizeThemePreferences = (value: unknown): ThemePreferences => {
  const candidate = value && typeof value === "object"
    ? value as Partial<ThemePreferences>
    : {};
  const mode = candidate.mode === "light" || candidate.mode === "dark"
    ? candidate.mode
    : "auto";
  return {
    mode,
    primaryColor: normalizeHexColor(
      candidate.primaryColor,
      DEFAULT_THEME_PREFERENCES.primaryColor,
    ),
    secondaryColor: normalizeHexColor(
      candidate.secondaryColor,
      DEFAULT_THEME_PREFERENCES.secondaryColor,
    ),
  };
};

export const resolveThemeMode = (
  mode: ThemeMode,
  systemPrefersDark: boolean,
): "light" | "dark" => mode === "auto"
  ? systemPrefersDark ? "dark" : "light"
  : mode;

export const applyTheme = (
  root: {
    dataset: Record<string, string | undefined>;
    style: { setProperty: (name: string, value: string) => void };
  },
  preferences: ThemePreferences,
  systemPrefersDark: boolean,
): void => {
  root.dataset.theme = resolveThemeMode(preferences.mode, systemPrefersDark);
  root.dataset.themePreference = preferences.mode;
  root.style.setProperty("--brand-primary", preferences.primaryColor);
  root.style.setProperty("--brand-secondary", preferences.secondaryColor);
};
