import assert from "node:assert/strict";
import test from "node:test";
import { defaultProfileSettings, normalizeProfileSettings } from "../packages/core/src/sync/profileSettings.ts";

test("background syncing is opt-in and old profiles migrate safely", () => {
  const defaults = defaultProfileSettings();
  assert.equal(defaults.profile.keepSyncingInBackground, false);
  const previous = { ...defaults, profile: { ...defaults.profile } } as {
    profile: Record<string, unknown>;
  } & Omit<typeof defaults, "profile">;
  delete previous.profile.keepSyncingInBackground;
  assert.equal(normalizeProfileSettings(previous).profile.keepSyncingInBackground, false);
  assert.equal(normalizeProfileSettings({
    ...defaults, profile: { ...defaults.profile, keepSyncingInBackground: true },
  }).profile.keepSyncingInBackground, true);
  assert.throws(() => normalizeProfileSettings({
    ...defaults, profile: { ...defaults.profile, keepSyncingInBackground: "yes" },
  }));
  assert.equal(defaults.profile.requireCharging, false);
  delete previous.profile.requireCharging;
  assert.equal(normalizeProfileSettings(previous).profile.requireCharging, false);
  assert.equal(normalizeProfileSettings({
    ...defaults, profile: { ...defaults.profile, requireCharging: true },
  }).profile.requireCharging, true);
  assert.throws(() => normalizeProfileSettings({
    ...defaults, profile: { ...defaults.profile, requireCharging: "yes" },
  }));
});
