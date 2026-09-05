import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_THEME_PREFERENCES,
  applyTheme,
  normalizeThemePreferences,
  resolveThemeMode,
} from "../packages/app/src/app/theme.ts";

test("normalizes missing and invalid theme preferences", () => {
  assert.deepEqual(normalizeThemePreferences(undefined), DEFAULT_THEME_PREFERENCES);
  assert.deepEqual(
    normalizeThemePreferences({
      mode: "sepia",
      primaryColor: "blue",
      secondaryColor: "#12345",
    }),
    DEFAULT_THEME_PREFERENCES,
  );
});

test("preserves valid customized colors", () => {
  assert.deepEqual(
    normalizeThemePreferences({
      mode: "dark",
      primaryColor: "#123abc",
      secondaryColor: "#FEDCBA",
    }),
    {
      mode: "dark",
      primaryColor: "#123ABC",
      secondaryColor: "#FEDCBA",
    },
  );
});

test("resolves automatic, light, and dark modes deterministically", () => {
  assert.equal(resolveThemeMode("auto", false), "light");
  assert.equal(resolveThemeMode("auto", true), "dark");
  assert.equal(resolveThemeMode("light", true), "light");
  assert.equal(resolveThemeMode("dark", false), "dark");
});

test("applies the resolved mode and custom brand tokens", () => {
  const properties = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
    },
  };

  applyTheme(root, {
    mode: "auto",
    primaryColor: "#102030",
    secondaryColor: "#F08030",
  }, true);

  assert.deepEqual(root.dataset, {
    theme: "dark",
    themePreference: "auto",
  });
  assert.equal(properties.get("--brand-primary"), "#102030");
  assert.equal(properties.get("--brand-secondary"), "#F08030");
});
