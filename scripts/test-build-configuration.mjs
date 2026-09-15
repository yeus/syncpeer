import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("application builds compile the core workspace first", () => {
  const scripts = json("package.json").scripts;
  assert.equal(
    scripts["build:app"],
    "npm run build:core && npm run build -w @syncpeer/app",
  );
});

test("Tauri builds use the dependency-aware application build", () => {
  const configs = [
    [
      "packages/tauri-shell/src-tauri/tauri.conf.json",
      "npm --prefix ../.. run build:app",
    ],
    [
      "packages/tauri-shell/src-tauri/tauri.lan-e2e.conf.json",
      "npm --prefix ../.. run build:app -- -- --mode lan-e2e",
    ],
    [
      "packages/tauri-shell/src-tauri/tauri.android-e2e.conf.json",
      "npm --prefix ../.. run build:app -- -- --mode android-e2e",
    ],
  ];

  for (const [file, expected] of configs) {
    assert.equal(json(file).build.beforeBuildCommand, expected);
  }
});

test("Android release setup uses tools available on standard runners", () => {
  const script = fs.readFileSync("scripts/build-android-prod-with-secrets.sh", "utf8");
  assert.doesNotMatch(script, /\brg\b/);
});

test("Android compatibility testing has one explicit API 29 owner", () => {
  const flake = fs.readFileSync("flake.nix", "utf8");
  const scripts = json("package.json").scripts;
  assert.match(flake, /compatibilityPlatformVersion = "29"/);
  assert.equal(
    scripts["android:emulator:compat"],
    "node scripts/android-emulator.mjs start compat",
  );
  assert.equal(
    scripts["test:android:compat"],
    "npm run build:android:e2e && npm run android:install:e2e && node scripts/test-android-e2e.mjs --expect-sdk 29 --reboot",
  );
});

test("the combined Android workflow owns both emulator profiles", () => {
  const scripts = json("package.json").scripts;
  const runner = fs.readFileSync("scripts/test-android.mjs", "utf8");
  assert.equal(scripts["test:android"], "node scripts/test-android.mjs");
  assert.match(runner, /build:android:e2e/);
  assert.match(runner, /compat/);
  assert.match(runner, /modern/);
  assert.match(runner, /test-android-e2e\.mjs/);
  assert.match(runner, /--skip-network/);
});

test("the combined Android workflow provisions WebView without Play Store interaction", () => {
  const runner = fs.readFileSync("scripts/test-android.mjs", "utf8");
  assert.match(runner, /captureWebViewFixture/);
  assert.match(runner, /installWebViewFixture/);
  assert.match(runner, /set-webview-implementation/);
});

test("modern Android uses only a focused service smoke test", () => {
  const scripts = json("package.json").scripts;
  assert.equal(
    scripts["android:emulator:modern"],
    "node scripts/android-emulator.mjs start modern",
  );
  assert.equal(
    scripts["test:android:modern-smoke"],
    "npm run build:android:e2e && npm run android:install:e2e && node scripts/test-android-e2e.mjs --modern-smoke",
  );
});

test("Android 10 runs compatibility checks instead of being skipped", () => {
  const script = fs.readFileSync("scripts/test-android-e2e.mjs", "utf8");
  assert.doesNotMatch(script, /Android E2E skipped: Android 14/);
  assert.match(script, /Expected Android API/);
  assert.match(script, /picker\.includes\("com\.android\.documentsui"\)/);
});
